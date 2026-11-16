import { randomUUID } from 'node:crypto';
import {
  cardRef,
  parseCardRef,
  CreateCard,
  UpdateCard,
  type Block,
  type BlockKind,
  type Card,
  type CardStatus,
  type ContentBlock,
  type Message,
  type TodoItem,
} from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { insertNotification, type NewNotification } from './notifications.ts';

interface CardRow {
  id: string;
  number: number | null;
  title: string;
  body: string;
  status: CardStatus;
  assignee: string | null;
  priority: number;
  board: 'main' | 'direct';
  conversation_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  block_kind: BlockKind | null;
  block_reason: string | null;
  block_options: string | null;
  block_until: string | null;
  model_id: string | null;
  effort: Card['effort'];
  origin_card: string | null;
}
interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant';
  author: string;
  content: string;
  at: string;
  rewind_id?: string | null;
}

export class NotFoundError extends Error {}
/** A request that is understood but not allowed (cycle, unknown parent…): HTTP 409. */
export class ConflictError extends Error {}
/** A value that can't work (bad cron expression, a time in the past…): HTTP 400. */
export class InvalidError extends Error {}

const toMessage = (r: MessageRow): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  seq: r.seq,
  role: r.role,
  author: r.author,
  content: JSON.parse(r.content) as ContentBlock[],
  at: r.at,
  ...(r.rewind_id ? { rewound: true } : {}),
});

const shortId = () => 'c_' + randomUUID().slice(0, 8);
/** Title of a direct chat before the user's first message. */
export const NEW_CHAT = 'New chat';
/** A chat's title from the user's first message: its start, cut at a word under 60 characters. */
export const chatTitle = (text: string): string => {
  if (text.length <= 60) return text;
  const cut = text.slice(0, 60);
  return (cut.lastIndexOf(' ') > 30 ? cut.slice(0, cut.lastIndexOf(' ')) : cut) + '…';
};
/** The user's message that has a chat renamed by the model, from the conversation so far. */
export const RENAME_AT = 3;
/** A parent that doesn't count as finished: 'closed' (cancelled) is still open, so its children keep waiting. */
const OPEN = (s: CardStatus) => s !== 'done' && s !== 'archived';

/** A card status change the origin chat is told about (design §16, card lifecycle from a chat). */
export type Transition = 'done' | 'review' | 'closed' | 'stopped' | 'needs_input' | 'capability';
const clip = (t: string, n = 1500) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
/** The system message posted in the origin chat. */
export function reportText(card: { id: string; number?: number | null; title: string }, t: Transition, detail: { by: string; text?: string }): string {
  const name = `“${card.title}” (${cardRef(card)})`;
  const who = detail.by === 'user' ? 'you' : `@${detail.by}`;
  const more = detail.text ? `: ${clip(detail.text)}` : '';
  switch (t) {
    case 'done':
      return `✓ Card ${name} finished${more}`;
    case 'review':
      return `Card ${name} is ready for your review${more}`;
    case 'closed':
      return `Card ${name} closed by ${who}. Nothing more will be done on it.`;
    case 'stopped':
      return `You stopped ${name}. Its run and commands were killed; writing on the card resumes it.`;
    case 'needs_input':
      return `Card ${name} needs your OK${more}`;
    case 'capability':
      return `Card ${name} is blocked${more}`;
  }
}

export class Kanban {
  /** Set by the dispatcher: the plain-words reason a card isn't moving. */
  waitingReason: (card: Card) => string | null = () => null;
  /** Direct chats whose title the model is generating right now (in memory: a restart just keeps the old title). */
  private naming = new Set<string>();
  /** Events to send once the current transaction has committed (report-back messages in origin chats). */
  private afterCommit: (() => void)[] = [];

  constructor(
    private db: Db,
    private bus: Bus,
  ) {}

  private toCard(r: CardRow, parents: string[]): Card {
    const block: Block | null = r.block_kind
      ? {
          kind: r.block_kind,
          reason: r.block_reason ?? '',
          options: r.block_options ? (JSON.parse(r.block_options) as string[]) : [],
          until: r.block_until,
        }
      : null;
    const card: Card = {
      id: r.id,
      number: r.number,
      title: r.title,
      body: r.body,
      status: r.status,
      assignee: r.assignee,
      priority: r.priority,
      board: r.board === 'direct' ? 'direct' : 'main',
      parents,
      block,
      waiting: null,
      conversationId: r.conversation_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      modelId: r.model_id,
      effort: r.effort,
      naming: this.naming.has(r.id),
      working: r.board === 'direct' && !!this.db.prepare("SELECT 1 FROM runs WHERE card_id = ? AND status = 'running'").get(r.id),
      originCard: r.origin_card,
    };
    card.waiting = this.waitingReason(card);
    return card;
  }

  private parentsOf(id: string): string[] {
    return (this.db.prepare('SELECT parent_id FROM card_links WHERE child_id = ? ORDER BY parent_id').all(id) as { parent_id: string }[]).map(
      (r) => r.parent_id,
    );
  }

  /** Cards on the kanban board (direct chats are not cards on the board: see direct()). */
  list(opts: { includeArchived?: boolean } = {}): Card[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM cards WHERE board = 'main' ${opts.includeArchived ? '' : "AND status != 'archived'"} ORDER BY priority DESC, created_at`,
      )
      .all() as CardRow[];
    const links = new Map<string, string[]>();
    for (const l of this.db.prepare('SELECT parent_id, child_id FROM card_links ORDER BY parent_id').all() as {
      parent_id: string;
      child_id: string;
    }[])
      links.set(l.child_id, [...(links.get(l.child_id) ?? []), l.parent_id]);
    return rows.map((r) => this.toCard(r, links.get(r.id) ?? []));
  }

  /** The card id for a reference: "#12", "12" or "c_1a2b3c4d" (see parseCardRef). */
  resolve(ref: string): string {
    const p = parseCardRef(ref);
    const row = (
      p && 'number' in p
        ? this.db.prepare('SELECT id FROM cards WHERE number = ?').get(p.number)
        : this.db.prepare('SELECT id FROM cards WHERE id = ?').get(p?.id ?? ref.trim())
    ) as { id: string } | undefined;
    if (!row) throw new NotFoundError(`card ${ref} not found`);
    return row.id;
  }

  /** How a card is named in text (#12; its id if it has no number or is gone). */
  ref(id: string): string {
    const r = this.db.prepare('SELECT id, number FROM cards WHERE id = ?').get(id) as { id: string; number: number | null } | undefined;
    return r ? cardRef(r) : id;
  }

  get(id: string): Card {
    const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
    if (!row) throw new NotFoundError(`card ${id} not found`);
    return this.toCard(row, this.parentsOf(id));
  }

  /** Parents that are not done yet. */
  openParents(card: Card): Card[] {
    return card.parents.map((p) => this.get(p)).filter((p) => OPEN(p.status));
  }

  /** `origin`: the direct chat the card is created from (card_create in a chat); it is told how the card ends. */
  create(input: CreateCard, by: string, origin: string | null = null): Card {
    return this.insert(input, by, origin, 'main');
  }

  /** A new card; board cards take the next number (card_counter, in the same transaction: never reused). */
  private insert(input: CreateCard, by: string, origin: string | null, board: 'main' | 'direct'): Card {
    const c = CreateCard.parse(input);
    const now = new Date().toISOString();
    const id = shortId();
    const conv = 'conv_' + id;
    this.db.transaction(() => {
      this.checkAssignee(c.assignee);
      if (origin && this.get(origin).board !== 'direct') throw new InvalidError(`origin ${origin} is not a direct chat`);
      this.db.prepare("INSERT INTO conversations (id, agent_id, kind) VALUES (?, ?, 'card')").run(conv, c.assignee);
      this.db
        .prepare(
          `INSERT INTO cards (id, title, body, status, assignee, priority, conversation_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, c.title, c.body, c.status, c.assignee, c.priority, conv, by, now, now);
      if (board === 'main') {
        const { last } = this.db.prepare('UPDATE card_counter SET last = last + 1 WHERE id = 1 RETURNING last').get() as { last: number };
        this.db.prepare('UPDATE cards SET number = ? WHERE id = ?').run(last, id);
      } else this.db.prepare("UPDATE cards SET board = 'direct' WHERE id = ?").run(id);
      if (origin) this.db.prepare('UPDATE cards SET origin_card = ? WHERE id = ?').run(origin, id);
      this.setParents(id, c.parents);
      this.normalizeStatus(id, by);
      this.event(id, 'created', { by, ...(origin ? { origin } : {}) });
    })();
    return this.emit(id);
  }

  /**
   * A new direct chat between the user and an agent: a card on the 'direct' board (an agent can have many). It stays 'done'
   * so the dispatcher never works it; the user's messages wake the agent in chat mode (Dispatcher.onUserMessage). Its title
   * is NEW_CHAT until the user's first message names it (appendMessage).
   */
  newChat(agentId: string): Card {
    const card = this.db
      .transaction(() => {
        const c = this.insert({ title: NEW_CHAT, status: 'done', assignee: agentId }, 'user', null, 'direct');
        this.db.prepare("UPDATE conversations SET kind = 'chat' WHERE id = ?").run(c.conversationId);
        return c.id;
      })
      .immediate();
    return this.emit(card);
  }

  /** Direct chats (chat history), latest activity first: a message bumps the chat's updated_at. */
  directs(): Card[] {
    return (
      this.db.prepare("SELECT id FROM cards WHERE board = 'direct' AND status != 'archived' ORDER BY updated_at DESC, created_at DESC").all() as {
        id: string;
      }[]
    ).map((r) => this.get(r.id));
  }

  /** `summary`: the handoff of card_complete / card_request_review, quoted in the origin chat's report. */
  update(id: string, patch: UpdateCard, by: string, summary?: string): Card {
    const p = UpdateCard.parse(patch);
    const before = this.get(id);
    if (before.board === 'direct' && (p.status !== undefined || p.assignee !== undefined || p.parents !== undefined))
      throw new InvalidError(`${cardRef(before)} is a direct chat with @${before.assignee}, not a work card: create a card for work`);
    const cols: Record<string, unknown> = {};
    if (p.title !== undefined) cols.title = p.title;
    if (p.body !== undefined) cols.body = p.body;
    if (p.status !== undefined) cols.status = p.status;
    if (p.assignee !== undefined) cols.assignee = p.assignee;
    if (p.priority !== undefined) cols.priority = p.priority;
    if (p.modelId !== undefined) cols.model_id = p.modelId;
    if (p.effort !== undefined) cols.effort = p.effort;
    if (Object.keys(cols).length === 0 && p.parents === undefined) return before;
    this.tx(() => {
      if (p.assignee !== undefined) this.checkAssignee(p.assignee);
      if (p.modelId && !this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(p.modelId)) throw new ConflictError(`model ${p.modelId} does not exist`);
      if (Object.keys(cols).length) {
        // Picking a chat's model or effort isn't activity: it must not move the chat up the history.
        if (Object.keys(cols).some((k) => k !== 'model_id' && k !== 'effort')) cols.updated_at = new Date().toISOString();
        const set = Object.keys(cols).map((k) => `${k} = @${k}`).join(', ');
        this.db.prepare(`UPDATE cards SET ${set} WHERE id = @id`).run({ ...cols, id });
      }
      if (p.parents !== undefined) this.setParents(id, p.parents);
      // Leaving 'blocked' clears the block.
      if (p.status !== undefined && p.status !== 'blocked') this.clearBlock(id);
      // Moved to 'blocked' by hand (board drag): a blocked card always says why, or the Inbox has nothing to show.
      if (p.status === 'blocked' && !before.block)
        this.db
          .prepare("UPDATE cards SET block_kind = 'needs_input', block_reason = ?, block_options = '[]', block_until = NULL WHERE id = ?")
          .run(by === 'user' ? 'Moved to blocked by you. Reply or move the card to continue.' : `Moved to blocked by ${by}.`, id);
      this.normalizeStatus(id, by);
      const after = this.get(id);
      if (after.status !== before.status) {
        this.event(id, 'status', { from: before.status, to: after.status, by });
        if (after.status === 'done' || after.status === 'review' || after.status === 'closed')
          this.reportBack(after, after.status, { by, text: summary });
        // The Inbox (design §16): not for what the user did themselves.
        if (by !== 'user' && after.board === 'main') {
          if (after.status === 'review') this.notify({ kind: 'card.review', title: after.title, body: summary ?? '', cardId: id });
          if (after.status === 'done') {
            const s = this.db.prepare('SELECT title FROM schedules WHERE last_card_id = ? OR chat_card_id = ? LIMIT 1').get(id, id) as { title: string } | undefined;
            this.notify(s ? { kind: 'schedule.ran', title: s.title, body: summary ?? '', cardId: id } : { kind: 'card.done', title: after.title, body: summary ?? '', cardId: id });
          }
        }
      }
      const fields = Object.keys(p).filter((k) => k !== 'status');
      if (fields.length) this.event(id, 'edited', { by, fields });
    });
    return this.emit(id);
  }

  /** Move a card to 'blocked' with a reason the user can act on (design §7). `stopped`: the user pressed Stop. */
  block(id: string, b: { kind: BlockKind; reason: string; options?: string[]; until?: string | null; stopped?: boolean }, by: string): Card {
    if (this.get(id).board === 'direct') throw new InvalidError(`${id} is a direct chat, not a work card: just answer in the chat`);
    const before = this.get(id);
    this.tx(() => {
      this.db
        .prepare(
          `UPDATE cards SET status = 'blocked', block_kind = ?, block_reason = ?, block_options = ?, block_until = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(b.kind, b.reason, JSON.stringify(b.options ?? []), b.until ?? null, new Date().toISOString(), id);
      this.event(id, 'blocked', { from: before.status, by, ...b });
      if (before.status !== 'blocked') {
        if (b.stopped) this.reportBack(before, 'stopped', { by });
        else if (b.kind === 'needs_input' || b.kind === 'capability') this.reportBack(before, b.kind, { by, text: b.reason });
      }
      if (!b.stopped && by !== 'user' && (b.kind === 'needs_input' || b.kind === 'capability'))
        this.notify({ kind: 'card.blocked', title: before.title, body: b.reason, cardId: id });
    });
    return this.emit(id);
  }

  /** A notification row inside the current transaction (tx()), announced once it commits. */
  private notify(n: NewNotification): void {
    const created = insertNotification(this.db, n);
    this.afterCommit.push(() => this.bus.emit({ type: 'notification.created', notification: created }));
  }

  /** A notification of its own (a failed triage run: the card doesn't block, the user is still told). */
  notifyNow(n: NewNotification): void {
    this.tx(() => this.notify(n));
  }

  remove(id: string): void {
    const card = this.get(id);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM cards WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(card.conversationId);
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(card.conversationId);
    })();
    this.bus.emit({ type: 'card.deleted', id });
  }

  /**
   * Put a card back in a status (and block) after a rewind or its undo: no report to the origin chat (the user did it
   * here, in this chat). Inside the caller's transaction; emit() after it commits.
   */
  restoreState(id: string, status: CardStatus, block: Block | null, event: { kind: string; payload: Record<string, unknown> }): void {
    const before = this.get(id);
    if (before.board === 'direct') return;
    this.db
      .prepare('UPDATE cards SET status = ?, block_kind = ?, block_reason = ?, block_options = ?, block_until = ?, updated_at = ? WHERE id = ?')
      .run(status, block?.kind ?? null, block?.reason ?? null, block ? JSON.stringify(block.options) : null, block?.until ?? null, new Date().toISOString(), id);
    this.event(id, event.kind, { from: before.status, to: status, ...event.payload });
  }

  /** Re-send a card to the UI (its computed fields may have changed). */
  emit(id: string): Card {
    const card = this.get(id);
    this.bus.emit({ type: 'card.updated', card });
    return card;
  }

  /**
   * The card chat. Reads the conversation id directly: get() computes `waiting`, which may read messages. Messages hidden
   * by a rewind are left out unless `rewound` (history_search, marked `rewound: true`).
   */
  messages(cardId: string, o: { rewound?: boolean } = {}): Message[] {
    const row = this.db.prepare('SELECT conversation_id FROM cards WHERE id = ?').get(cardId) as { conversation_id: string } | undefined;
    if (!row) throw new NotFoundError(`card ${cardId} not found`);
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ${o.rewound ? '' : 'AND rewind_id IS NULL'} ORDER BY seq`)
      .all(row.conversation_id) as MessageRow[];
    return rows.map(toMessage);
  }

  /** The agent's todo list on this card's conversation (todo_write); empty if none. */
  todos(cardId: string): TodoItem[] {
    const row = this.db
      .prepare('SELECT v.todos FROM cards c JOIN conversations v ON v.id = c.conversation_id WHERE c.id = ?')
      .get(cardId) as { todos: string | null } | undefined;
    if (!row) throw new NotFoundError(`card ${cardId} not found`);
    return row.todos ? (JSON.parse(row.todos) as TodoItem[]) : [];
  }

  /** Replace the todo list (todo_write always sends the whole list). */
  setTodos(cardId: string, todos: TodoItem[]): void {
    const r = this.db
      .prepare('UPDATE conversations SET todos = ? WHERE id = (SELECT conversation_id FROM cards WHERE id = ?)')
      .run(JSON.stringify(todos), cardId);
    if (!r.changes) throw new NotFoundError(`card ${cardId} not found`);
  }

  /** Append a message to the card's conversation (the card chat, design §16). */
  appendMessage(
    cardId: string,
    role: 'user' | 'assistant',
    author: string,
    content: ContentBlock[],
    contextUpto: number | null = null,
  ): Message {
    const card = this.get(cardId);
    const id = this.db.transaction(() => this.insertMessage(card, role, author, content, contextUpto))();
    return this.emitMessage(id, card);
  }

  /** Insert a message (no transaction, no event: the caller holds the transaction and emits after the commit). */
  private insertMessage(card: Card, role: 'user' | 'assistant', author: string, content: ContentBlock[], contextUpto: number | null): string {
    const id = 'm_' + randomUUID();
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?')
      .get(card.conversationId) as { next: number };
    this.db
      .prepare('INSERT INTO messages (id, conversation_id, seq, role, author, content, at, context_upto) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, card.conversationId, next, role, author, JSON.stringify(content), new Date().toISOString(), contextUpto);
    if (card.board === 'direct') {
      // Chat history: the latest chat goes first, and the user's first message names a new chat.
      const text = content.map((b) => (b.type === 'text' ? b.text : '')).join(' ').replace(/\s+/g, ' ').trim();
      const title = card.title === NEW_CHAT && role === 'user' && author !== 'system' && text ? chatTitle(text) : card.title;
      this.db.prepare('UPDATE cards SET title = ?, updated_at = ? WHERE id = ?').run(title, new Date().toISOString(), card.id);
    }
    return id;
  }

  private emitMessage(id: string, card: Card): Message {
    const message = toMessage(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow);
    this.bus.emit({ type: 'message.appended', message });
    if (card.board === 'direct') this.emit(card.id);
    return message;
  }

  /**
   * Tell the chat a card came from that the card changed state: a `system` message in the chat and an outbox row the
   * dispatcher turns into a chat run (deliverReports). Called inside the status change's transaction, so it happens
   * exactly once per transition, even across a crash.
   */
  private reportBack(card: Card, transition: Transition, detail: { by: string; text?: string }): void {
    if (!card.originCard) return;
    const chat = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(card.originCard) as CardRow | undefined;
    if (!chat || chat.status === 'archived') return;
    const chatCard = this.toCard(chat, []);
    const text = reportText(card, transition, detail);
    const messageId = this.insertMessage(chatCard, 'user', 'system', [{ type: 'text', text }], null);
    this.db
      .prepare('INSERT INTO card_reports (chat_id, card_id, transition, message_id, at) VALUES (?, ?, ?, ?, ?)')
      .run(chatCard.id, card.id, transition, messageId, new Date().toISOString());
    this.afterCommit.push(() => this.emitMessage(messageId, chatCard));
  }

  /** A transaction whose report-back events are sent after it commits (and dropped if it rolls back). */
  private tx(fn: () => void): void {
    try {
      this.db.transaction(fn)();
    } catch (e) {
      this.afterCommit = [];
      throw e;
    }
    const todo = this.afterCommit;
    this.afterCommit = [];
    for (const f of todo) f();
  }

  /** Report-back messages whose chat run hasn't answered yet (oldest first). */
  pendingReports(): { id: number; chatId: string; cardId: string; transition: Transition; at: string }[] {
    return (
      this.db.prepare('SELECT id, chat_id, card_id, transition, at FROM card_reports WHERE delivered_at IS NULL ORDER BY id').all() as {
        id: number;
        chat_id: string;
        card_id: string;
        transition: Transition;
        at: string;
      }[]
    ).map((r) => ({ id: r.id, chatId: r.chat_id, cardId: r.card_id, transition: r.transition, at: r.at }));
  }

  /** The chat's agent has answered a report (or nothing is owed any more). */
  reportDelivered(id: number): void {
    this.db.prepare('UPDATE card_reports SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(new Date().toISOString(), id);
  }

  /** Mark a direct chat as being named by the model (shown in the UI), or done. */
  setNaming(cardId: string, on: boolean): void {
    if (on) this.naming.add(cardId);
    else this.naming.delete(cardId);
    this.emit(cardId);
  }

  /** Give a direct chat its generated title (once: recorded as a 'renamed' event). Keeps its place in the history. */
  renameChat(cardId: string, title: string): void {
    this.db.prepare('UPDATE cards SET title = ? WHERE id = ?').run(title, cardId);
    this.event(cardId, 'renamed', { title });
  }

  /** Time of the latest event of a kind on a card, or '' if none. */
  lastEventAt(cardId: string, kind: string): string {
    const r = this.db.prepare('SELECT MAX(at) AS at FROM card_events WHERE card_id = ? AND kind = ?').get(cardId, kind) as { at: string | null };
    return r.at ?? '';
  }

  event(cardId: string, kind: string, payload: unknown): void {
    this.db
      .prepare('INSERT INTO card_events (card_id, at, kind, payload) VALUES (?, ?, ?, ?)')
      .run(cardId, new Date().toISOString(), kind, JSON.stringify(payload));
  }

  private checkAssignee(agent: string | null): void {
    if (agent && !this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agent))
      throw new ConflictError(`agent ${agent} does not exist`);
  }

  /** `parents`: references ("#12", "12" or ids). */
  private setParents(id: string, parents: string[]): void {
    const ref = (x: string) => this.ref(x);
    const unique = [
      ...new Set(
        parents.map((p) => {
          try {
            return this.resolve(p);
          } catch {
            throw new ConflictError(`parent card ${p} does not exist`);
          }
        }),
      ),
    ];
    for (const p of unique) {
      if (p === id) throw new ConflictError(`card ${ref(id)} cannot be its own parent`);
      if (this.isAncestor(id, p)) throw new ConflictError(`linking ${ref(p)} as parent of ${ref(id)} would create a cycle`);
    }
    this.db.prepare('DELETE FROM card_links WHERE child_id = ?').run(id);
    for (const p of unique) this.db.prepare('INSERT INTO card_links (parent_id, child_id) VALUES (?, ?)').run(p, id);
  }

  /** True if `a` is an ancestor of (or equal to) `b`. */
  private isAncestor(a: string, b: string): boolean {
    const seen = new Set<string>();
    const stack = [b];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === a) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...this.parentsOf(x));
    }
    return false;
  }

  /** A card can't be ready while a parent is open: it waits in todo (design §16). */
  private normalizeStatus(id: string, by: string): void {
    const card = this.get(id);
    if (card.status === 'ready' && this.openParents(card).length) {
      this.db.prepare("UPDATE cards SET status = 'todo' WHERE id = ?").run(id);
      this.event(id, 'status', { from: 'ready', to: 'todo', by, why: 'open parents' });
    }
  }

  private clearBlock(id: string): void {
    this.db
      .prepare('UPDATE cards SET block_kind = NULL, block_reason = NULL, block_options = NULL, block_until = NULL WHERE id = ?')
      .run(id);
  }
}
