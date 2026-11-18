import { USER, cardRef, type Block, type CardStatus, type SideEffect } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Kanban } from './kanban.ts';
import type { Memories } from './memory.ts';
import type { Schedules } from './schedules.ts';

/**
 * Side effects (card #138): what a chat's tool calls did outside the chat and its files. The runner records them right
 * after each call; a rewind lists those of the part it hides, takes back what nobody has acted on yet and lists the rest
 * as kept. Everything here is a database change, done in the rewind's (or its undo's) transaction: a kill never leaves
 * half of it done (rule 2).
 */

type Kind = SideEffect['kind'];

interface Row {
  id: number;
  card_id: string;
  at: string;
  kind: Kind;
  ref: string | null;
  label: string;
  data: string | null;
}

/** What a rewind did with one side effect: shown, and replayed backwards by its undo. */
export interface DoneEffect extends SideEffect {
  sid: number;
  /** What Undo puts back (outcome 'undone' only). */
  undo?: { status?: CardStatus; block?: Block | null; messageId?: string; agentMessage?: number; memory?: number; schedule?: string };
}

/** The ids each table had reached before a tool call: what is above them was made by the call. */
export interface Mark {
  cards: number;
  messages: number;
  agentMessages: number;
  memories: number;
  schedules: number;
  documents: number;
}

const PUSH = /\bgit\b[^\n;&|]*\bpush\b/;
const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

export class SideEffects {
  constructor(
    private db: Db,
    private kanban: Kanban,
    private memories: Memories,
    private schedules: Schedules,
  ) {}

  /** Taken right before a synchronous tool call (nothing else writes in between). */
  mark(): Mark {
    const max = (t: string) => (this.db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ${t}`).get() as { n: number }).n;
    return { cards: max('cards'), messages: max('messages'), agentMessages: max('agent_messages'), memories: max('memories'), schedules: max('schedules'), documents: max('documents') };
  }

  /** After a tool call that succeeded: record what it did outside the chat, if anything. */
  record(cardId: string, agentId: string, tool: string, input: unknown, mark: Mark | null): void {
    const i = (input ?? {}) as Record<string, unknown>;
    const at = new Date().toISOString();
    const add = (kind: Kind, ref: string | null, label: string, data?: unknown) =>
      this.db.prepare('INSERT INTO side_effects (card_id, at, kind, ref, label, data) VALUES (?, ?, ?, ?, ?, ?)').run(cardId, at, kind, ref, label, data === undefined ? null : JSON.stringify(data));
    const newer = <T>(table: string, after: number, cols: string) => this.db.prepare(`SELECT ${cols} FROM ${table} WHERE rowid > ? ORDER BY rowid`).all(after) as T[];
    const cardLabel = (id: string) => {
      const c = this.kanban.get(id);
      return `${cardRef(c)} ${c.title}`;
    };
    if (tool === 'shell') {
      if (typeof i.command === 'string' && PUSH.test(i.command)) add('push', null, short(i.command.match(PUSH)![0], 80));
      return;
    }
    if (!mark) return;
    switch (tool) {
      case 'task_create':
        for (const c of newer<{ id: string }>('cards', mark.cards, 'id')) add('task', c.id, cardLabel(c.id));
        return;
      case 'task_update': {
        if (i.id === undefined) return;
        let id: string;
        try {
          id = this.kanban.resolve(String(i.id));
        } catch {
          return;
        }
        if (id !== cardId) add('task_change', id, cardLabel(id));
        return;
      }
      case 'task_message':
        for (const m of this.db.prepare('SELECT id, conversation_id FROM messages WHERE rowid > ? AND author = ? ORDER BY rowid').all(mark.messages, agentId) as { id: string; conversation_id: string }[]) {
          const c = this.db.prepare('SELECT id FROM cards WHERE conversation_id = ?').get(m.conversation_id) as { id: string } | undefined;
          if (c && c.id !== cardId) add('message', m.id, cardRef(this.kanban.get(c.id)), { toCard: c.id });
        }
        return;
      case 'agent_message':
        for (const a of newer<{ id: number; to_agent: string; to_card: string; message_id: string }>('agent_messages', mark.agentMessages, 'id, to_agent, to_card, message_id'))
          add('message', a.message_id, '@' + a.to_agent, { toCard: a.to_card, agentMessage: a.id });
        return;
      case 'memory_add':
        if (i.update !== undefined) {
          const id = Number(String(i.update).replace(/^m/i, ''));
          if (Number.isInteger(id) && id > 0) add('memory_change', String(id), `m${id} changed`);
          return;
        }
        for (const m of newer<{ id: number; text: string }>('memories', mark.memories, 'id, text')) add('memory', String(m.id), `m${m.id} « ${short(m.text, 50)} »`);
        return;
      case 'memory_update':
      case 'memory_forget': {
        const id = Number(String(i.id ?? '').replace(/^m/i, ''));
        if (Number.isInteger(id) && id > 0) add('memory_change', String(id), `m${id} ${tool === 'memory_forget' ? 'forgotten' : 'changed'}`);
        return;
      }
      case 'schedule_create':
        for (const s of newer<{ id: string; title: string }>('schedules', mark.schedules, 'id, title')) add('schedule', s.id, s.title);
        return;
      case 'schedule_delete':
        if (typeof i.id === 'string') add('schedule_delete', i.id, i.id);
        return;
      case 'artifact_create':
        for (const d of newer<{ id: string; title: string }>('documents', mark.documents, 'id, title')) add('artifact', d.id, `${d.title} created`);
        return;
      case 'artifact_update': {
        const key = typeof i.artifact === 'string' ? i.artifact : typeof i.path === 'string' ? i.path : null;
        if (!key) return;
        const d = this.db.prepare('SELECT id, title FROM documents WHERE id = ? OR path = ?').get(key, key) as { id: string; title: string } | undefined;
        add('artifact', d?.id ?? key, `${d?.title ?? key} updated`);
        return;
      }
    }
  }

  /** The side effects of a chat since `since` not already taken by a rewind, with what a rewind would do now. */
  plan(cardId: string, since: string): DoneEffect[] {
    const rows = this.db.prepare('SELECT * FROM side_effects WHERE card_id = ? AND at >= ? AND rewind_id IS NULL ORDER BY id').all(cardId, since) as Row[];
    return rows.map((r) => this.decide(r));
  }

  /** Do the plan (inside the rewind's transaction): take back what it says, mark the rows as the rewind's. */
  apply(rewindId: string, cardId: string, since: string): DoneEffect[] {
    const plan = this.plan(cardId, since);
    const now = new Date().toISOString();
    for (const e of plan) {
      if (e.outcome !== 'undone' || !e.undo) continue;
      const u = e.undo;
      if (e.kind === 'task' && e.cardId) this.kanban.restoreState(e.cardId, 'closed', null, { kind: 'rewound', payload: { by: USER, rewind: rewindId, from: cardId } });
      if (u.messageId) this.db.prepare('UPDATE messages SET rewind_id = ? WHERE id = ? AND rewind_id IS NULL').run(rewindId, u.messageId);
      if (u.agentMessage) this.db.prepare('UPDATE agent_messages SET replied_at = ?, reply_delivered_at = ? WHERE id = ? AND replied_at IS NULL').run(now, now, u.agentMessage);
      if (u.memory) this.memories.forget(u.memory, USER);
      if (u.schedule) this.schedules.update(u.schedule, { enabled: false });
    }
    this.db.prepare('UPDATE side_effects SET rewind_id = ? WHERE card_id = ? AND at >= ? AND rewind_id IS NULL').run(rewindId, cardId, since);
    return plan;
  }

  /**
   * Undo a rewind's side effects (inside its transaction): what it took back comes back, unless it was changed since
   * (then it is left as it is, and the returned list says so).
   */
  undo(rewindId: string, done: DoneEffect[]): string[] {
    const left: string[] = [];
    for (const e of done) {
      if (e.outcome !== 'undone' || !e.undo) continue;
      const u = e.undo;
      try {
        if (e.kind === 'task' && e.cardId) {
          const c = this.db.prepare('SELECT status FROM cards WHERE id = ?').get(e.cardId) as { status: CardStatus } | undefined;
          if (c?.status === 'closed') this.kanban.restoreState(e.cardId, u.status ?? 'todo', u.block ?? null, { kind: 'rewind_undone', payload: { by: USER, rewind: rewindId } });
          else left.push(`${e.label} was ${c ? 'reopened' : 'deleted'} since, so it was left as it is`);
        }
        if (u.messageId) this.db.prepare('UPDATE messages SET rewind_id = NULL WHERE id = ? AND rewind_id = ?').run(u.messageId, rewindId);
        if (u.agentMessage) this.db.prepare('UPDATE agent_messages SET replied_at = NULL, reply_delivered_at = NULL, reply_seq = NULL WHERE id = ?').run(u.agentMessage);
        if (u.memory) {
          if (this.memories.get(u.memory).status === 'archived') this.memories.update(u.memory, { status: 'active' }, USER);
          else left.push(`${e.label} was changed since, so it was left as it is`);
        }
        if (u.schedule) {
          const s = this.schedules.list().find((x) => x.id === u.schedule);
          if (s && !s.enabled) this.schedules.update(u.schedule, { enabled: true });
          else left.push(`schedule ${e.label} was ${s ? 'turned on' : 'deleted'} since`);
        }
      } catch (err) {
        left.push(`${e.label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.db.prepare('UPDATE side_effects SET rewind_id = NULL WHERE rewind_id = ?').run(rewindId);
    return left;
  }

  /** Cards whose chat changed (a message withdrawn or brought back): their UI reloads. */
  touched(done: DoneEffect[]): string[] {
    return [...new Set(done.flatMap((e) => (e.outcome === 'undone' && e.cardId ? [e.cardId] : [])))];
  }

  /** Records older than `before` go (like file changes, a rewind reaches back 30 days). */
  prune(before: string): void {
    this.db.prepare('DELETE FROM side_effects WHERE at < ? AND rewind_id IS NULL').run(before);
  }

  /** What a rewind would do with one side effect, now. */
  private decide(r: Row): DoneEffect {
    const kept = (why: string | null, cardId: string | null = null): DoneEffect => ({ sid: r.id, kind: r.kind, label: r.label, cardId, outcome: 'kept', action: 'stays', why });
    const undone = (action: string, undo: DoneEffect['undo'], cardId: string | null = null): DoneEffect => ({ sid: r.id, kind: r.kind, label: r.label, cardId, outcome: 'undone', action, why: null, undo });
    switch (r.kind) {
      case 'task': {
        const c = r.ref ? this.card(r.ref) : null;
        if (!c) return kept('deleted since');
        const label = `${cardRef(c)} ${c.title}`;
        const run = this.db.prepare('SELECT agent_id FROM runs WHERE card_id = ? ORDER BY started_at LIMIT 1').get(c.id) as { agent_id: string } | undefined;
        if (run) return { ...kept(`@${run.agent_id} already worked on it`, c.id), label };
        if (['done', 'closed', 'archived', 'running'].includes(c.status)) return { ...kept(`already ${c.status}`, c.id), label };
        return { ...undone('closed', { status: c.status, block: c.block }, c.id), label };
      }
      case 'task_change':
        return kept(null, r.ref && this.card(r.ref) ? r.ref : null);
      case 'message': {
        const d = (r.data ? JSON.parse(r.data) : {}) as { toCard?: string; agentMessage?: number };
        const to = d.toCard && this.card(d.toCard) ? d.toCard : null;
        if (!to) return kept('its chat was deleted');
        const am = d.agentMessage ? (this.db.prepare('SELECT replied_at FROM agent_messages WHERE id = ?').get(d.agentMessage) as { replied_at: string | null } | undefined) : undefined;
        const read = !!am?.replied_at || !!this.db.prepare('SELECT 1 FROM runs WHERE card_id = ? AND started_at >= ?').get(to, r.at);
        if (read) return kept('already read', to);
        return undone('withdrawn', { messageId: r.ref ?? undefined, ...(d.agentMessage ? { agentMessage: d.agentMessage } : {}) }, to);
      }
      case 'memory': {
        const id = Number(r.ref);
        let status: string;
        try {
          status = this.memories.get(id).status;
        } catch {
          return kept('deleted since');
        }
        if (status !== 'active') return kept(`already ${status}`);
        const later = this.db.prepare("SELECT 1 FROM memory_changes WHERE memory_id = ? AND action NOT IN ('add', 'confirm') AND at > ?").get(id, r.at);
        if (later) return kept('changed since');
        return undone('archived', { memory: id });
      }
      case 'schedule': {
        const s = this.db.prepare('SELECT enabled, last_fired_at FROM schedules WHERE id = ?').get(r.ref) as { enabled: number; last_fired_at: string | null } | undefined;
        if (!s) return kept('deleted since');
        if (s.last_fired_at) return kept('already ran');
        if (!s.enabled) return kept('already off');
        return undone('turned off', { schedule: r.ref! });
      }
      default:
        return kept(null);
    }
  }

  private card(id: string): { id: string; number: number | null; board: string; title: string; status: CardStatus; block: Block | null } | null {
    try {
      return this.kanban.get(id);
    } catch {
      return null;
    }
  }
}
