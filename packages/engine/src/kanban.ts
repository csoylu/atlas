import { randomUUID } from 'node:crypto';
import {
  cardRef,
  parseCardRef,
  CreateCard,
  IMAGE_MAX_PER_TASK,
  UpdateCard,
  type ImageBlock,
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
import { MEMORY_SELECT, staleCardMemories, toMemory } from './memory.ts';
import { isCleanupCard } from './cleanup.ts';
import { stripData } from './images.ts';
import { cardPrs, parsePrUrl } from './prs.ts';
import { stallOf } from './stalls.ts';
import { reviewOffOf } from './reviewFlow.ts';
import { recordPrEvent, recordTaskEvent } from './workflowEvents.ts';
import { assertActive, defaultProjectId, defaultProjectOrNull, isMember, leadOf, projectForNewCard, projectRow, resolveProject, reviewerFor, scopeFor } from './projects.ts';

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
  images: string;
  reviewer: string | null;
  project_id: string;
  status_since: string | null;
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

interface AgentMessageRow {
  id: number;
  from_agent: string;
  from_card: string;
  to_agent: string;
  to_card: string;
  message_id: string;
  seq: number;
  at: string;
  replied_at: string | null;
  reply_seq: number | null;
  reply_delivered_at: string | null;
}
/** An agent_message on its way: waiting for the target's answer (repliedAt null), or for the sender to read it. */
export interface AgentMessage {
  id: number;
  from: string;
  fromCard: string;
  to: string;
  toCard: string;
  /** Its seq in the target's conversation. */
  seq: number;
  at: string;
  repliedAt: string | null;
  /** The answer's seq in the sender's conversation. */
  replySeq: number | null;
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
/** Above this a note's text is shortened (the full text stays on the task). */
export const NOTE_MAX = 1500;
/**
 * A note's text whole, or shortened without cutting a word (#143): up to the last sentence that fits, else the last
 * whole word with an ellipsis, then where the rest is.
 */
export function noteText(t: string, rest: string, n = NOTE_MAX): string {
  const s = t.trim();
  if (s.length <= n) return s;
  const head = s.slice(0, n);
  const ends = [...head.matchAll(/[.!?](?=\s|$)/g)];
  const end = ends.at(-1);
  const short = end && end.index! >= n / 3 ? head.slice(0, end.index! + 1) : head.slice(0, Math.max(head.search(/\s+\S*$/), 1)).replace(/[\s,;:–—-]+$/, '') + '…';
  return `${short}\n\n(shortened; ${rest})`;
}
/** The system message posted in the origin chat. The agent reads it on its next turn; it never starts a run (#143). */
export function reportText(card: { id: string; number?: number | null; title: string }, t: Transition, detail: { by: string; text?: string }): string {
  const name = `“${card.title}” (${cardRef(card)})`;
  const who = detail.by === 'user' ? 'you' : `@${detail.by}`;
  const what = t === 'needs_input' || t === 'capability' ? 'question' : 'summary';
  const more = detail.text?.trim() ? `: ${noteText(detail.text, `full ${what}: task_show ${cardRef(card)}`)}` : '';
  switch (t) {
    case 'done':
      return `✓ Task ${name} finished${more}`;
    case 'review':
      return `Task ${name} is ready for your review${more}`;
    case 'closed':
      return `Task ${name} closed by ${who}. Nothing more will be done on it.`;
    case 'stopped':
      return `You stopped ${name}. Its run and commands were killed; writing in the task resumes it.`;
    case 'needs_input':
      return `Task ${name} needs your OK${more}`;
    case 'capability':
      return `Task ${name} is blocked${more}`;
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
    // A transient wait is stored in the block columns of a 'todo' card (#131): shown as `retry`, never as a block.
    const retry = r.status === 'todo' && r.block_kind === 'transient' && r.block_until ? { at: r.block_until, reason: r.block_reason ?? '' } : null;
    const block: Block | null = r.block_kind && r.status === 'blocked'
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
      retry,
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
      images: JSON.parse(r.images || '[]') as ImageBlock[],
      reviewer: r.reviewer,
      prs: r.board === 'main' ? cardPrs(this.db, r.id) : [],
      projectId: r.project_id,
      statusSince: r.status_since,
      stall: r.board === 'main' ? stallOf(this.db, r.id) : null,
      reviewOff: reviewOffOf(this.db, { id: r.id, status: r.status, board: r.board, projectId: r.project_id }),
    };
    card.waiting = this.waitingReason(card);
    return card;
  }

  private parentsOf(id: string): string[] {
    return (this.db.prepare('SELECT parent_id FROM card_links WHERE child_id = ? ORDER BY parent_id').all(id) as { parent_id: string }[]).map(
      (r) => r.parent_id,
    );
  }

  /**
   * Cards on the kanban board (direct chats are not cards on the board: see direct()). `project`: that project's only
   * (archived or not). Otherwise the cards of archived projects are left out (#213), unless `archivedProjects`;
   * `includeArchived` (archived cards) takes every project.
   */
  list(opts: { includeArchived?: boolean; project?: string; archivedProjects?: boolean } = {}): Card[] {
    const where = ["board = 'main'"];
    const args: string[] = [];
    if (!opts.includeArchived) where.push("status != 'archived'");
    if (opts.project) {
      where.push('project_id = ?');
      args.push(opts.project);
    } else if (!opts.includeArchived && !opts.archivedProjects) where.push("project_id IN (SELECT id FROM projects WHERE status = 'active')");
    const rows = this.db.prepare(`SELECT * FROM cards WHERE ${where.join(' AND ')} ORDER BY priority DESC, created_at, rowid`).all(...args) as CardRow[];
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
    if (!row) throw new NotFoundError(`task ${ref} not found`);
    return row.id;
  }

  /** How a card is named in text (#12; its id if it has no number or is gone). */
  ref(id: string): string {
    const r = this.db.prepare('SELECT id, number FROM cards WHERE id = ?').get(id) as { id: string; number: number | null } | undefined;
    return r ? cardRef(r) : id;
  }

  get(id: string): Card {
    const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
    if (!row) throw new NotFoundError(`task ${id} not found`);
    return this.toCard(row, this.parentsOf(id));
  }

  /**
   * The project a tool call from `cardId`'s run acts on (#213): its own, or `asked` for a lead (projects.scopeFor).
   */
  scope(agentId: string, cardId: string, asked?: unknown): string {
    return scopeFor(this.db, agentId, this.get(cardId).projectId, asked);
  }

  /** Refuse a tool call from `cardId`'s run on a card of another project, unless the agent leads one of the two. */
  reach(agentId: string, cardId: string, targetId: string): Card {
    const target = this.get(targetId);
    scopeFor(this.db, agentId, this.get(cardId).projectId, target.projectId);
    return target;
  }

  /** Refuse an agent_message to an agent outside the run's project, unless the sender leads it (#213). */
  reachAgent(agentId: string, cardId: string, to: string): void {
    const project = this.get(cardId).projectId;
    if (!this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(to)) return; // agentInbox says it doesn't exist
    if (isMember(this.db, project, to) || leadOf(this.db, project) === agentId) return;
    const leads = this.db.prepare('SELECT 1 FROM projects p JOIN project_members m ON m.project_id = p.id WHERE p.lead = ? AND m.agent_id = ?').get(agentId, to);
    if (leads) return;
    throw new InvalidError(`@${to} is not a member of project ${projectRow(this.db, project).name}: only a project's lead can reach agents of another project`);
  }

  /** The lead of a project (#213): it triages the project's new tasks. */
  leadOf(projectId: string): string | null {
    return leadOf(this.db, projectId);
  }

  /** Parents that are not done yet. */
  openParents(card: Card): Card[] {
    return card.parents.map((p) => this.get(p)).filter((p) => OPEN(p.status));
  }

  /** `origin`: the direct chat the card is created from (card_create in a chat); it is told how the card ends. */
  /** `images`: the task's pictures, already in <data>/task-images (taskImages.ts), written in the same row. */
  create(input: CreateCard, by: string, origin: string | null = null, images: ImageBlock[] = []): Card {
    return this.insert(input, by, origin, 'main', images);
  }

  /** Replace a task's pictures (#119): the files are placed or removed by taskImages.ts around this row write. */
  setImages(id: string, images: ImageBlock[], by: string): Card {
    if (images.length > IMAGE_MAX_PER_TASK) throw new InvalidError(`${IMAGE_MAX_PER_TASK} images per task at most`);
    const before = this.get(id);
    if (before.board === 'direct') throw new InvalidError(`${cardRef(before)} is a direct chat: send the image as a message`);
    this.tx(() => {
      this.db.prepare('UPDATE cards SET images = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(stripData(images)), new Date().toISOString(), id);
      this.event(id, 'edited', { by, fields: ['images'] });
    });
    return this.emit(id);
  }

  /** A new card; board cards take the next number (card_counter, in the same transaction: never reused). */
  private insert(input: CreateCard, by: string, origin: string | null, board: 'main' | 'direct', images: ImageBlock[] = []): Card {
    const c = CreateCard.parse(input);
    if (images.length > IMAGE_MAX_PER_TASK) throw new InvalidError(`${IMAGE_MAX_PER_TASK} images per task at most`);
    const now = new Date().toISOString();
    const id = shortId();
    const conv = 'conv_' + id;
    this.db.transaction(() => {
      this.checkAssignee(c.assignee);
      // A task's project is set here and never changes (#213). Direct chats: the default project until #214.
      const project = board === 'main' ? projectForNewCard(this.db, c.projectId, c.assignee) : c.projectId ? resolveProject(this.db, c.projectId) : defaultProjectId(this.db);
      if (board === 'direct') assertActive(this.db, project, 'it takes no new chat');
      if (origin && this.get(origin).board !== 'direct') throw new InvalidError(`origin ${origin} is not a direct chat`);
      this.db.prepare("INSERT INTO conversations (id, agent_id, kind) VALUES (?, ?, 'card')").run(conv, c.assignee);
      this.db
        .prepare(
          `INSERT INTO cards (id, title, body, status, assignee, priority, conversation_id, created_by, created_at, updated_at, images, project_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, c.title, c.body, c.status, c.assignee, c.priority, conv, by, now, now, JSON.stringify(stripData(images)), project);
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
  /** `projectId`: the chat's project (#213), fixed for good; omitted = the default project. */
  newChat(agentId: string, projectId?: string): Card {
    const card = this.db
      .transaction(() => {
        const c = this.insert({ title: NEW_CHAT, status: 'done', assignee: agentId, projectId }, 'user', null, 'direct');
        this.db.prepare("UPDATE conversations SET kind = 'chat' WHERE id = ?").run(c.conversationId);
        return c.id;
      })
      .immediate();
    return this.emit(card);
  }

  /**
   * The agent's main chat (v3) in a project (#214: one per agent per project; omitted = the default project): the one
   * direct chat the sidebar and voice open, named after the agent and never auto-titled. Created on first use, and
   * again if it was deleted or archived; other direct chats are its History. It lives on project_members.
   */
  /** The agent's current main chat without creating one (read-only, for the screenshot tool), or null. */
  existingMainChat(agentId: string, projectId?: string): Card | null {
    const project = projectId ?? defaultProjectOrNull(this.db);
    if (!project) return null;
    const row = this.db.prepare('SELECT main_chat FROM project_members WHERE agent_id = ? AND project_id = ?').get(agentId, project) as { main_chat: string | null } | undefined;
    if (!row?.main_chat || !this.db.prepare("SELECT 1 FROM cards WHERE id = ? AND board = 'direct' AND status != 'archived'").get(row.main_chat)) return null;
    return this.get(row.main_chat);
  }

  mainChat(agentId: string, projectId?: string): Card {
    const id = this.db
      .transaction(() => {
        const { project, current } = this.mainChatRow(agentId, projectId);
        if (current) return { id: current, created: false };
        return { id: this.insertMainChat(agentId, project), created: true };
      })
      .immediate();
    return id.created ? this.emit(id.id) : this.get(id.id);
  }

  /**
   * `/clear` in a direct chat: a fresh, empty main chat for the agent in that project. The previous one stays as it is,
   * in History, titled « @agent · until <date> ». Voice follows the main chat, so it goes to the new one.
   */
  newMainChat(agentId: string, projectId?: string): Card {
    const { id, old } = this.db
      .transaction(() => {
        const { project, current: old } = this.mainChatRow(agentId, projectId);
        if (old) {
          const until = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
          this.renameChat(old, `${this.get(old).title} · until ${until}`);
        }
        return { id: this.insertMainChat(agentId, project), old };
      })
      .immediate();
    if (old) this.emit(old);
    return this.emit(id);
  }

  /** Inside a transaction: the member row of (agent, project) and its live main chat (null if none, or archived). */
  private mainChatRow(agentId: string, projectId?: string): { project: string; current: string | null } {
    if (!this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId)) throw new NotFoundError(`agent ${agentId} does not exist`);
    const project = projectId ? resolveProject(this.db, projectId) : defaultProjectId(this.db);
    const row = this.db.prepare('SELECT main_chat FROM project_members WHERE agent_id = ? AND project_id = ?').get(agentId, project) as { main_chat: string | null } | undefined;
    if (!row) throw new InvalidError(`@${agentId} is not a member of project ${projectRow(this.db, project).name}: it has no chat there`);
    const live = row.main_chat && this.db.prepare("SELECT 1 FROM cards WHERE id = ? AND board = 'direct' AND status != 'archived'").get(row.main_chat);
    return { project, current: live ? row.main_chat : null };
  }

  /**
   * Inside a transaction: a new direct chat named after the agent (never auto-titled), set as its main chat in the
   * project. « @agent » in the agent's home project (as before projects), « @agent · Project » elsewhere.
   */
  private insertMainChat(agentId: string, projectId: string): string {
    const home = (this.db.prepare('SELECT home FROM project_members WHERE agent_id = ? AND project_id = ?').get(agentId, projectId) as { home: number }).home === 1;
    const title = home ? '@' + agentId : `@${agentId} · ${projectRow(this.db, projectId).name}`;
    const c = this.insert({ title, status: 'done', assignee: agentId, projectId }, 'user', null, 'direct');
    this.db.prepare("UPDATE conversations SET kind = 'chat' WHERE id = ?").run(c.conversationId);
    this.renameChat(c.id, title); // a « renamed » event: never auto-titled
    this.db.prepare('UPDATE project_members SET main_chat = ? WHERE agent_id = ? AND project_id = ?').run(c.id, agentId, projectId);
    return c.id;
  }

  /**
   * Inside the transaction removing a member from a project (#214): its open tasks there go back to the lead (triage,
   * unassigned), its chats there are archived (read-only, still searchable). Returns the cards touched (to emit and to
   * stop their runs after the commit). Other projects are untouched.
   */
  releaseMember(projectId: string, agentId: string, by: string): string[] {
    const open = this.db
      .prepare("SELECT id, status FROM cards WHERE project_id = ? AND assignee = ? AND board = 'main' AND status NOT IN ('done', 'closed', 'archived')")
      .all(projectId, agentId) as { id: string; status: CardStatus }[];
    for (const c of open) {
      this.db.prepare("UPDATE cards SET status = 'triage', assignee = NULL, reviewer = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), c.id);
      this.clearBlock(c.id);
      this.event(c.id, 'status', { from: c.status, to: 'triage', by, why: `@${agentId} left the project` });
      this.event(c.id, 'edited', { by, fields: ['assignee'] });
    }
    const chats = this.db
      .prepare("SELECT id FROM cards WHERE project_id = ? AND assignee = ? AND board = 'direct' AND status != 'archived'")
      .all(projectId, agentId) as { id: string }[];
    for (const c of chats) this.db.prepare("UPDATE cards SET status = 'archived' WHERE id = ?").run(c.id);
    return [...open.map((c) => c.id), ...chats.map((c) => c.id)];
  }

  /** Direct chats (chat history), latest activity first: a message bumps the chat's updated_at. */
  /** `project`: that project's chats (#213); else those of active projects (`archivedProjects`: all). */
  directs(opts: { project?: string; archivedProjects?: boolean } = {}): Card[] {
    const scope = opts.project ? 'AND project_id = ?' : opts.archivedProjects ? '' : "AND project_id IN (SELECT id FROM projects WHERE status = 'active')";
    return (
      this.db.prepare(`SELECT id FROM cards WHERE board = 'direct' AND status != 'archived' ${scope} ORDER BY updated_at DESC, created_at DESC`).all(...(opts.project ? [opts.project] : [])) as {
        id: string;
      }[]
    ).map((r) => this.get(r.id));
  }

  /** `summary`: the handoff of card_complete / card_request_review, quoted in the origin chat's report. */
  update(id: string, patch: UpdateCard, by: string, summary?: string): Card {
    const p = UpdateCard.parse(patch);
    const before = this.get(id);
    // A direct chat can only be archived (out of History; the row stays): no other status, assignee or parents.
    const chatArchive = before.board === 'direct' && p.status === 'archived' && p.assignee === undefined && p.parents === undefined;
    if (before.board === 'direct' && !chatArchive && (p.status !== undefined || p.assignee !== undefined || p.parents !== undefined))
      throw new InvalidError(`${cardRef(before)} is a direct chat with @${before.assignee}, not a work task: create a task for work`);
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
      assertActive(this.db, before.projectId, cardRef(before));
      if (p.assignee !== undefined) this.checkAssignee(p.assignee, before.projectId);
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
          .run(by === 'user' ? 'Moved to blocked by you. Reply or move the task to continue.' : `Moved to blocked by ${by}.`, id);
      this.normalizeStatus(id, by);
      const after = this.get(id);
      if (after.status !== before.status) {
        this.event(id, 'status', { from: before.status, to: after.status, by });
        // In review waits for QA, not the user (#189): no report, no Inbox item.
        if (after.status === 'done' || after.status === 'closed') this.reportBack(after, after.status, { by, text: summary });
        // Its project memories are history now: out of recall (design §8).
        if (after.status === 'done' || after.status === 'closed') {
          const stale = staleCardMemories(this.db, id, by);
          if (stale.length)
            this.afterCommit.push(() => {
              for (const m of stale) this.bus.emit({ type: 'memory.updated', memory: toMemory(this.db.prepare(`${MEMORY_SELECT} WHERE m.id = ?`).get(m) as never) });
            });
        }
        // The Inbox (design §16): not for what the user did themselves.
        if (by !== 'user' && after.board === 'main') {
          if (after.status === 'done' && isCleanupCard(after)) {
            // One Inbox item for the week's proposals, approved or rejected line by line (#83).
            const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM memory_proposals WHERE card_id = ? AND status = 'pending'").get(id) as { n: number };
            this.notify({ kind: 'memory.cleanup', title: n ? `Memory cleanup: ${n} proposal${n === 1 ? '' : 's'}` : 'Memory cleanup: nothing to change', body: summary ?? '', cardId: id });
          } else if (after.status === 'done') {
            // A workflow's agent step (#170): the Inbox says which workflow ran (kind kept from schedules).
            const s = this.db
              .prepare(
                `SELECT w.name AS title FROM workflow_run_steps st JOIN workflow_runs r ON r.id = st.run_id JOIN workflows w ON w.id = r.workflow_id WHERE st.card_id = ?
                 UNION ALL SELECT w.name FROM workflow_nodes n JOIN workflows w ON w.id = n.workflow_id WHERE n.own_card_id = ? LIMIT 1`,
              )
              .get(id, id) as { title: string } | undefined;
            this.notify(s ? { kind: 'schedule.ran', title: s.title, body: summary ?? '', cardId: id } : { kind: 'card.done', title: after.title, body: summary ?? '', cardId: id });
          }
        }
      }
      const fields = Object.keys(p).filter((k) => k !== 'status');
      if (fields.length) this.event(id, 'edited', { by, fields });
    });
    return this.emit(id);
  }

  /**
   * task_request_review (#189): link the task's pull requests and hand it to QA (In review). The reviewer is the review
   * agent (Settings), or the triage agent when the builder is the review agent itself. Asking again (after a fix)
   * clears what was decided on the previous head, so the reviewer checks again and a failure is read again.
   */
  requestReview(id: string, urls: string[], by: string, summary: string): Card {
    const before = this.get(id);
    if (before.board === 'direct') throw new InvalidError('a direct chat has no pull requests: create a task for the work');
    if (before.status === 'review') throw new InvalidError(`${cardRef(before)} is already in review: its pull request is with @${before.reviewer ?? 'nobody'}`);
    const prs = urls.map(parsePrUrl);
    // A task's PRs are its project's (#216): the gate and the reviewer's workspace come from that project.
    const project = projectRow(this.db, before.projectId);
    if (!project.repo) throw new InvalidError(`project ${project.name} has no GitHub repo: set it in Settings → Projects before handing a pull request to QA`);
    const stray = prs.filter((p) => p.repo.toLowerCase() !== project.repo!.toLowerCase());
    if (stray.length)
      throw new InvalidError(
        `${stray.map((p) => p.url).join(', ')} ${stray.length > 1 ? 'are' : 'is'} not in ${project.repo}, the repo of project ${project.name} (${cardRef(before)}'s project): ` +
          'open the PR in that repo, or do the work in a task of the project it belongs to',
      );
    // One PR per task where the project's Review workflow reviews it (#263): one run, one verdict, one merge.
    const all = new Set([...before.prs.map((p) => `${p.repo.toLowerCase()}#${p.number}`), ...prs.map((p) => `${p.repo.toLowerCase()}#${p.number}`)]);
    if (all.size > 1 && this.db.prepare("SELECT 1 FROM workflows WHERE project_id = ? AND origin = 'review'").get(before.projectId))
      throw new InvalidError(`one pull request per task in project ${project.name} (its Review workflow reviews one): ${cardRef(before)} would link ${all.size}. Split the task, one PR each`);
    // The project's review agent; on its own PR, the project's lead (#213, #263). Unset: the Review step says so.
    const who = reviewerFor(this.db, before.projectId, before.assignee);
    const reviewer = 'id' in who ? who.id : null;
    const now = new Date().toISOString();
    this.tx(() => {
      assertActive(this.db, before.projectId, cardRef(before));
      const linked: typeof prs = [];
      for (const pr of prs) {
        if (!this.db.prepare('SELECT 1 FROM card_prs WHERE card_id = ? AND repo = ? AND number = ?').get(id, pr.repo, pr.number)) linked.push(pr);
        this.db
          .prepare(
            `INSERT INTO card_prs (card_id, repo, number, url, linked_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (card_id, repo, number) DO UPDATE SET reviewed_sha = NULL, failed_sha = NULL`,
          )
          .run(id, pr.repo, pr.number, pr.url, now);
      }
      // A new request reads the PR afresh (#263): the Review's wait never acts on the previous head's CI or conflict.
      this.db
        .prepare('UPDATE card_prs SET reviewed_sha = NULL, failed_sha = NULL, ci = NULL, ci_failed_name = NULL, ci_failed_url = NULL, mergeable = NULL, qa = NULL, qa_description = NULL, checked_at = NULL WHERE card_id = ?')
        .run(id);
      this.db.prepare("UPDATE cards SET status = 'review', reviewer = ?, updated_at = ? WHERE id = ?").run(reviewer, now, id);
      this.clearBlock(id);
      this.event(id, 'status', { from: before.status, to: 'review', by });
      this.event(id, 'review_requested', { by, summary, prs: prs.map((p) => p.url), reviewer });
      // « opened » for workflows (#258): a PR becomes known to Atlas when a task links it.
      for (const pr of linked) recordPrEvent(this.db, id, 'opened', { url: pr.url, repo: pr.repo, number: pr.number, branch: null, base: null, head: null, state: 'open', ci: null }, { by });
    });
    return this.emit(id);
  }

  /** Move a card to 'blocked' with a reason the user can act on (design §7). `stopped`: the user pressed Stop. */
  block(id: string, b: { kind: BlockKind; reason: string; options?: string[]; until?: string | null; stopped?: boolean }, by: string): Card {
    if (this.get(id).board === 'direct') throw new InvalidError(`${id} is a direct chat, not a work task: just answer in the chat`);
    if (b.kind === 'transient' && !b.stopped) return this.retryLater(id, { reason: b.reason, at: b.until ?? new Date(Date.now() + 15 * 60_000).toISOString() }, by);
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

  /**
   * A temporary failure (#131): the card waits in 'todo' until `at`, when the dispatcher moves it to 'ready'. Not the
   * user's problem: no block, no Inbox, no report to the origin chat. Kept in the block columns, so a restart keeps it.
   */
  retryLater(id: string, r: { reason: string; at: string }, by: string): Card {
    const before = this.get(id);
    if (before.board === 'direct') throw new InvalidError(`${id} is a direct chat, not a work task`);
    this.tx(() => {
      this.db
        .prepare(
          `UPDATE cards SET status = 'todo', block_kind = 'transient', block_reason = ?, block_options = '[]', block_until = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(r.reason, r.at, new Date().toISOString(), id);
      this.event(id, 'retry_later', { from: before.status, by, reason: r.reason, until: r.at });
      if (before.status !== 'todo') this.event(id, 'status', { from: before.status, to: 'todo', by, why: 'retry at ' + r.at });
    });
    return this.emit(id);
  }

  /**
   * Waiting on other tasks (task_block kind=dependency, #131): they are added to the card's parents and the card waits
   * in 'todo'. The dispatcher moves it to 'ready' once they are all done, as for any card with open parents. Not the
   * user's problem: no block, no Inbox. At least one of `on` must still be open, or there is nothing to wait for.
   */
  waitOn(id: string, on: string[], reason: string, by: string): Card {
    const before = this.get(id);
    if (before.board === 'direct') throw new InvalidError(`${id} is a direct chat, not a work task`);
    if (!on.length) throw new InvalidError('waits_on is empty: name the task(s) this one waits on (#12)');
    const targets = on.map((p) => {
      try {
        return this.get(this.resolve(p));
      } catch {
        throw new InvalidError(`task ${p} does not exist: create a task for that work first, or ask the user (needs_input) if only they can clear it`);
      }
    });
    if (!targets.some((t) => OPEN(t.status)))
      throw new InvalidError(`${targets.map(cardRef).join(', ')} ${targets.length === 1 ? 'is' : 'are'} already done: nothing to wait for, continue the work`);
    this.tx(() => {
      this.setParents(id, [...new Set([...before.parents, ...targets.map((t) => t.id)])]);
      this.db.prepare("UPDATE cards SET status = 'todo', updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      this.clearBlock(id);
      this.event(id, 'waiting', { from: before.status, by, on: targets.map(cardRef), reason });
      if (before.status !== 'todo') this.event(id, 'status', { from: before.status, to: 'todo', by, why: 'waiting on ' + targets.map(cardRef).join(', ') });
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
      .run(id, card.conversationId, next, role, author, JSON.stringify(stripData(content)), new Date().toISOString(), contextUpto);
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
   * Tell the chat a card came from that the card changed state: a `system` message in the chat, inside the status
   * change's transaction (exactly once per transition, even across a crash). It wakes nobody (#143): the agent reads it
   * on its next turn (owesTurn skips task notes), Master sees one compact row and the Inbox entry.
   */
  private reportBack(card: Card, transition: Transition, detail: { by: string; text?: string }): void {
    if (!card.originCard) return;
    const chat = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(card.originCard) as CardRow | undefined;
    if (!chat || chat.status === 'archived') return;
    const chatCard = this.toCard(chat, []);
    const text = reportText(card, transition, detail);
    const messageId = this.insertMessage(chatCard, 'user', 'system', [{ type: 'text', text }], null);
    const now = new Date().toISOString();
    // delivered_at at once: nothing is owed (before #143 the dispatcher woke the chat until it had answered).
    this.db
      .prepare('INSERT INTO card_reports (chat_id, card_id, transition, message_id, at, delivered_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(chatCard.id, card.id, transition, messageId, now, now);
    this.afterCommit.push(() => this.emitMessage(messageId, chatCard));
  }

  /** The task notes (reportBack) in a conversation: information, not something the agent owes an answer to. */
  taskNotes(conversationId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT r.message_id FROM card_reports r JOIN messages m ON m.id = r.message_id WHERE m.conversation_id = ?')
      .all(conversationId) as { message_id: string }[];
    return new Set(rows.map((r) => r.message_id));
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

  /**
   * agent_message (#96): where a message to an agent lands. Its one active task (ready or running) if it has exactly
   * one, else its main chat.
   */
  agentInbox(agentId: string, projectId?: string): Card {
    if (!this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId)) throw new NotFoundError(`agent @${agentId} does not exist`);
    // In the sender's project (#214) when the target is a member there, else its default project's main chat.
    const project = projectId && isMember(this.db, projectId, agentId) ? projectId : undefined;
    const active = this.db
      .prepare(`SELECT id FROM cards WHERE board = 'main' AND assignee = ? AND status IN ('ready', 'running')${project ? ' AND project_id = ?' : ''}`)
      .all(...(project ? [agentId, project] : [agentId])) as { id: string }[];
    return active.length === 1 ? this.get(active[0]!.id) : this.mainChat(agentId, project);
  }

  /**
   * Post an agent's message in another agent's inbox, with its outbox row in the same transaction: the dispatcher
   * wakes the target until it has answered, even after a restart (deliverAgentMessages). `fromCard`: the sender's
   * conversation, where the answer goes.
   */
  sendAgentMessage(from: string, fromCard: string, to: string, text: string): Card {
    if (to === from) throw new InvalidError('that is you: you cannot send a message to yourself');
    if (!text.trim()) throw new InvalidError('empty message: give a text');
    const source = this.get(fromCard);
    const target = this.agentInbox(to, source.projectId);
    const where = source.board === 'direct' ? 'main chat' : `task ${this.ref(fromCard)}`;
    const content: ContentBlock[] = [{ type: 'text', text: `[message from @${from} (${where}); your answer is sent back to them] ${text}` }];
    let messageId = '';
    this.tx(() => {
      messageId = this.insertMessage(target, 'user', from, content, null);
      const { seq } = this.db.prepare('SELECT seq FROM messages WHERE id = ?').get(messageId) as { seq: number };
      this.db
        .prepare('INSERT INTO agent_messages (from_agent, from_card, to_agent, to_card, message_id, seq, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(from, fromCard, to, target.id, messageId, seq, new Date().toISOString());
    });
    this.emitMessage(messageId, target);
    return target;
  }

  /** agent_message rows whose target hasn't answered yet, or whose answer the sender hasn't read yet (oldest first). */
  pendingAgentMessages(): AgentMessage[] {
    return (this.db.prepare('SELECT * FROM agent_messages WHERE reply_delivered_at IS NULL ORDER BY id').all() as AgentMessageRow[]).map((r) => ({
      id: r.id,
      from: r.from_agent,
      fromCard: r.from_card,
      to: r.to_agent,
      toCard: r.to_card,
      seq: r.seq,
      at: r.at,
      repliedAt: r.replied_at,
      replySeq: r.reply_seq,
    }));
  }

  /**
   * The target's answer (or why there is none) as a system note in the sender's conversation, in one transaction with
   * the outbox update. A sender that is gone: nothing to tell, the row is closed.
   */
  replyAgentMessage(id: number, text: string): void {
    const row = this.db.prepare('SELECT * FROM agent_messages WHERE id = ? AND replied_at IS NULL').get(id) as AgentMessageRow | undefined;
    if (!row) return;
    const now = new Date().toISOString();
    const chat = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(row.from_card) as CardRow | undefined;
    let messageId: string | null = null;
    this.tx(() => {
      if (chat) messageId = this.insertMessage(this.toCard(chat, []), 'user', 'system', [{ type: 'text', text }], null);
      const seq = messageId ? (this.db.prepare('SELECT seq FROM messages WHERE id = ?').get(messageId) as { seq: number }).seq : null;
      this.db.prepare('UPDATE agent_messages SET replied_at = ?, reply_seq = ?, reply_delivered_at = ? WHERE id = ?').run(now, seq, chat ? null : now, id);
    });
    if (messageId && chat) this.emitMessage(messageId, this.toCard(chat, []));
  }

  /**
   * An agent's side of a message in a card's conversation: null if the card is gone; `seen` once the agent wrote a
   * reply with that message in its view; `text`: the agent's last text after it.
   */
  answerTo(cardId: string, agentId: string, seq: number): { seen: boolean; text: string | null } | null {
    const row = this.db.prepare('SELECT conversation_id FROM cards WHERE id = ?').get(cardId) as { conversation_id: string } | undefined;
    if (!row) return null;
    const replies = this.db
      .prepare("SELECT content, context_upto FROM messages WHERE conversation_id = ? AND role = 'assistant' AND author = ? AND seq > ? AND rewind_id IS NULL ORDER BY seq")
      .all(row.conversation_id, agentId, seq) as { content: string; context_upto: number | null }[];
    const texts = replies
      .map((r) => (JSON.parse(r.content) as ContentBlock[]).flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim())
      .filter(Boolean);
    return { seen: replies.some((r) => (r.context_upto ?? 0) >= seq), text: texts.at(-1) ?? null };
  }

  /** The sender's agent has read the answer (or nothing is owed any more). */
  agentReplyDelivered(id: number): void {
    this.db.prepare('UPDATE agent_messages SET reply_delivered_at = ? WHERE id = ? AND reply_delivered_at IS NULL').run(new Date().toISOString(), id);
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

  /** How many events of a kind a card has. */
  eventCount(cardId: string, kind: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM card_events WHERE card_id = ? AND kind = ?').get(cardId, kind) as { n: number }).n;
  }

  event(cardId: string, kind: string, payload: unknown): void {
    this.db
      .prepare('INSERT INTO card_events (card_id, at, kind, payload) VALUES (?, ?, ?, ?)')
      .run(cardId, new Date().toISOString(), kind, JSON.stringify(payload));
    // The task events workflows start on (#258), in the same transaction as the change.
    recordTaskEvent(this.db, cardId, kind, payload);
  }

  /** `project`: the agent must also be one of its members (#213). */
  private checkAssignee(agent: string | null, project?: string): void {
    if (agent && !this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agent))
      throw new ConflictError(`agent ${agent} does not exist`);
    if (agent && project && !isMember(this.db, project, agent)) throw new InvalidError(`@${agent} is not a member of project ${projectRow(this.db, project).name}`);
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
            throw new ConflictError(`parent task ${p} does not exist`);
          }
        }),
      ),
    ];
    for (const p of unique) {
      if (p === id) throw new ConflictError(`task ${ref(id)} cannot be its own parent`);
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
