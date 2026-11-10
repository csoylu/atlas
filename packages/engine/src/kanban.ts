import { randomUUID } from 'node:crypto';
import {
  CreateCard,
  UpdateCard,
  type Block,
  type BlockKind,
  type Card,
  type CardStatus,
  type ContentBlock,
  type Message,
} from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';

interface CardRow {
  id: string;
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
}
interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: 'user' | 'assistant';
  author: string;
  content: string;
  at: string;
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
});

const shortId = () => 'c_' + randomUUID().slice(0, 8);
/** Title of a direct chat before Can's first message. */
export const NEW_CHAT = 'New chat';
/** A chat's title from Can's first message: its start, cut at a word under 60 characters. */
export const chatTitle = (text: string): string => {
  if (text.length <= 60) return text;
  const cut = text.slice(0, 60);
  return (cut.lastIndexOf(' ') > 30 ? cut.slice(0, cut.lastIndexOf(' ')) : cut) + '…';
};
const OPEN = (s: CardStatus) => s !== 'done' && s !== 'archived';

export class Kanban {
  /** Set by the dispatcher: the plain-words reason a card isn't moving. */
  waitingReason: (card: Card) => string | null = () => null;

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

  get(id: string): Card {
    const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
    if (!row) throw new NotFoundError(`card ${id} not found`);
    return this.toCard(row, this.parentsOf(id));
  }

  /** Parents that are not done yet. */
  openParents(card: Card): Card[] {
    return card.parents.map((p) => this.get(p)).filter((p) => OPEN(p.status));
  }

  create(input: CreateCard, by: string): Card {
    const c = CreateCard.parse(input);
    const now = new Date().toISOString();
    const id = shortId();
    const conv = 'conv_' + id;
    this.db.transaction(() => {
      this.checkAssignee(c.assignee);
      this.db.prepare("INSERT INTO conversations (id, agent_id, kind) VALUES (?, ?, 'card')").run(conv, c.assignee);
      this.db
        .prepare(
          `INSERT INTO cards (id, title, body, status, assignee, priority, conversation_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, c.title, c.body, c.status, c.assignee, c.priority, conv, by, now, now);
      this.setParents(id, c.parents);
      this.normalizeStatus(id, by);
      this.event(id, 'created', { by });
    })();
    return this.emit(id);
  }

  /**
   * A new direct chat between Can and an agent: a card on the 'direct' board (an agent can have many). It stays 'done'
   * so the dispatcher never works it; Can's messages wake the agent in chat mode (Dispatcher.onUserMessage). Its title
   * is NEW_CHAT until Can's first message names it (appendMessage).
   */
  newChat(agentId: string): Card {
    const card = this.db
      .transaction(() => {
        const c = this.create({ title: NEW_CHAT, status: 'done', assignee: agentId }, 'can');
        this.db.prepare("UPDATE cards SET board = 'direct' WHERE id = ?").run(c.id);
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

  update(id: string, patch: UpdateCard, by: string): Card {
    const p = UpdateCard.parse(patch);
    const before = this.get(id);
    if (before.board === 'direct' && (p.status !== undefined || p.assignee !== undefined || p.parents !== undefined))
      throw new InvalidError(`${id} is a direct chat with @${before.assignee}, not a work card: create a card for work`);
    const cols: Record<string, unknown> = {};
    if (p.title !== undefined) cols.title = p.title;
    if (p.body !== undefined) cols.body = p.body;
    if (p.status !== undefined) cols.status = p.status;
    if (p.assignee !== undefined) cols.assignee = p.assignee;
    if (p.priority !== undefined) cols.priority = p.priority;
    if (p.modelId !== undefined) cols.model_id = p.modelId;
    if (p.effort !== undefined) cols.effort = p.effort;
    if (Object.keys(cols).length === 0 && p.parents === undefined) return before;
    this.db.transaction(() => {
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
      this.normalizeStatus(id, by);
      const after = this.get(id);
      if (after.status !== before.status) this.event(id, 'status', { from: before.status, to: after.status, by });
      const fields = Object.keys(p).filter((k) => k !== 'status');
      if (fields.length) this.event(id, 'edited', { by, fields });
    })();
    return this.emit(id);
  }

  /** Move a card to 'blocked' with a reason Can can act on (design §7). */
  block(id: string, b: { kind: BlockKind; reason: string; options?: string[]; until?: string | null }, by: string): Card {
    if (this.get(id).board === 'direct') throw new InvalidError(`${id} is a direct chat, not a work card: just answer in the chat`);
    const before = this.get(id);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE cards SET status = 'blocked', block_kind = ?, block_reason = ?, block_options = ?, block_until = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(b.kind, b.reason, JSON.stringify(b.options ?? []), b.until ?? null, new Date().toISOString(), id);
      this.event(id, 'blocked', { from: before.status, by, ...b });
    })();
    return this.emit(id);
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

  /** Re-send a card to the UI (its computed fields may have changed). */
  emit(id: string): Card {
    const card = this.get(id);
    this.bus.emit({ type: 'card.updated', card });
    return card;
  }

  /** The card chat. Reads the conversation id directly: get() computes `waiting`, which may read messages. */
  messages(cardId: string): Message[] {
    const row = this.db.prepare('SELECT conversation_id FROM cards WHERE id = ?').get(cardId) as { conversation_id: string } | undefined;
    if (!row) throw new NotFoundError(`card ${cardId} not found`);
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(row.conversation_id) as MessageRow[];
    return rows.map(toMessage);
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
    const id = 'm_' + randomUUID();
    this.db.transaction(() => {
      const { next } = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?')
        .get(card.conversationId) as { next: number };
      this.db
        .prepare(
          'INSERT INTO messages (id, conversation_id, seq, role, author, content, at, context_upto) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, card.conversationId, next, role, author, JSON.stringify(content), new Date().toISOString(), contextUpto);
      if (card.board === 'direct') {
        // Chat history: the latest chat goes first, and Can's first message names a new chat.
        const text = content.map((b) => (b.type === 'text' ? b.text : '')).join(' ').replace(/\s+/g, ' ').trim();
        const title = card.title === NEW_CHAT && role === 'user' && author !== 'system' && text ? chatTitle(text) : card.title;
        this.db.prepare('UPDATE cards SET title = ?, updated_at = ? WHERE id = ?').run(title, new Date().toISOString(), cardId);
      }
    })();
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow;
    const message = toMessage(row);
    this.bus.emit({ type: 'message.appended', message });
    if (card.board === 'direct') this.emit(cardId);
    return message;
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

  private setParents(id: string, parents: string[]): void {
    const unique = [...new Set(parents)];
    for (const p of unique) {
      if (p === id) throw new ConflictError(`card ${id} cannot be its own parent`);
      if (!this.db.prepare('SELECT 1 FROM cards WHERE id = ?').get(p)) throw new ConflictError(`parent card ${p} does not exist`);
      if (this.isAncestor(id, p)) throw new ConflictError(`linking ${p} as parent of ${id} would create a cycle`);
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

  /** A card can't be ready while a parent is open: it waits in todo (Can's rule, design §16). */
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
