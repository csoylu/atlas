import { randomUUID } from 'node:crypto';
import { USER, type ClearEvent, type CompactResult, type SlashCommand } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { ConflictError, NotFoundError, type Kanban } from './kanban.ts';
import type { Runner } from './runner.ts';

/**
 * Composer slash commands (card #99). Both first stop a running agent, as Stop does (not a rewind), and wait for the run
 * to settle.
 * - /compact [focus]: the conversation's summary is written now, up to the last message (Runner.compactNow).
 * - /clear: the agent forgets everything before this point: the model's view starts after it (Runner.contextStart), no
 *   summary, no todo list. Nothing is deleted (append-only transcript): the chat folds the earlier messages behind a
 *   « Context cleared » row, history_search still finds them. Undo works until the next message.
 * Rule 2: a clear, and its undo, is one transaction (the context_clears row and the conversation's reset together).
 */
export class Slash {
  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private runner: Runner,
  ) {}

  async run(cardId: string, c: SlashCommand): Promise<{ clear?: ClearEvent; compact?: CompactResult }> {
    this.kanban.get(cardId);
    if (this.runner.current(cardId)) {
      this.runner.stop(cardId);
      await this.runner.settled(cardId);
    }
    if (c.command === 'clear') return { clear: this.clear(cardId) };
    const compact = await this.runner.compactNow(cardId, c.arg || undefined);
    this.changed(cardId);
    return { compact };
  }

  /** /clear: the agent starts fresh after the last message. Refused if nothing was said since the last clear. */
  clear(cardId: string): ClearEvent {
    if (this.runner.current(cardId)) throw new ConflictError('the agent is working: stop it first');
    if (this.runner.compacting(cardId)) throw new ConflictError('a /compact is running on this chat: wait for it');
    const card = this.kanban.get(cardId);
    const id = 'cl_' + randomUUID().slice(0, 8);
    const at = new Date().toISOString();
    this.db.transaction(() => {
      const start = this.runner.contextStart(cardId);
      const last = (this.db.prepare('SELECT MAX(seq) AS m FROM messages WHERE conversation_id = ? AND rewind_id IS NULL').get(card.conversationId) as { m: number | null }).m;
      if (last == null || last <= start) throw new ConflictError('nothing to clear: no message since the start or the last /clear');
      const before = this.db
        .prepare('SELECT summary, summary_upto_seq, prune_upto_seq, todos FROM conversations WHERE id = ?')
        .get(card.conversationId) as Record<string, unknown>;
      this.db
        .prepare("INSERT INTO context_clears (id, card_id, upto_seq, before, state, at) VALUES (?, ?, ?, ?, 'done', ?)")
        .run(id, cardId, last, JSON.stringify(before), at);
      this.db
        .prepare(
          `UPDATE conversations SET summary = NULL, summary_upto_seq = NULL, prune_upto_seq = NULL, todos = NULL,
             last_input_tokens = NULL, last_input_upto = NULL, memory_snapshot = NULL WHERE id = ?`,
        )
        .run(card.conversationId);
      this.kanban.event(cardId, 'context_cleared', { by: USER, clear: id, upto: last });
    })();
    this.changed(cardId);
    return this.events(cardId).find((e) => e.id === id)!;
  }

  /** Undo a clear: the agent sees the earlier messages again, with the summary and todo list it had. Until the next message. */
  undo(id: string): { cardId: string } {
    const r = this.db.prepare('SELECT * FROM context_clears WHERE id = ?').get(id) as ClearRow | undefined;
    if (!r) throw new NotFoundError(`clear ${id} not found`);
    if (r.state !== 'done') throw new ConflictError('this clear was already undone');
    if (r.rewind_id) throw new ConflictError('a rewind to a message before this clear took it away already');
    if (this.runner.current(r.card_id)) throw new ConflictError('the agent is working: stop it first');
    const card = this.kanban.get(r.card_id);
    this.db.transaction(() => {
      const latest = this.db.prepare("SELECT id FROM context_clears WHERE card_id = ? AND state = 'done' AND rewind_id IS NULL ORDER BY upto_seq DESC, at DESC LIMIT 1").get(r.card_id) as { id: string };
      if (latest.id !== id) throw new ConflictError('a later clear was made on this chat: undo that one first');
      if (this.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND seq > ? AND rewind_id IS NULL').get(card.conversationId, r.upto_seq))
        throw new ConflictError('the chat has moved on since the clear, so it can no longer be undone');
      const b = JSON.parse(r.before) as { summary: string | null; summary_upto_seq: number | null; prune_upto_seq: number | null; todos: string | null };
      this.db.prepare("UPDATE context_clears SET state = 'undone', undone_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      this.db
        .prepare(
          `UPDATE conversations SET summary = ?, summary_upto_seq = ?, prune_upto_seq = ?, todos = ?,
             last_input_tokens = NULL, last_input_upto = NULL, memory_snapshot = NULL WHERE id = ?`,
        )
        .run(b.summary, b.summary_upto_seq, b.prune_upto_seq, b.todos, card.conversationId);
      this.kanban.event(r.card_id, 'context_clear_undone', { by: USER, clear: id });
    })();
    this.changed(r.card_id);
    return { cardId: r.card_id };
  }

  /** The clears in effect on a card, oldest first: a row each in the chat, Undo on the latest while nothing was written since. */
  events(cardId: string): ClearEvent[] {
    const card = this.kanban.get(cardId);
    const rows = this.db
      .prepare("SELECT * FROM context_clears WHERE card_id = ? AND state = 'done' AND rewind_id IS NULL ORDER BY upto_seq, at")
      .all(cardId) as ClearRow[];
    const latest = rows.at(-1);
    const moved = latest ? !!this.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND seq > ? AND rewind_id IS NULL').get(card.conversationId, latest.upto_seq) : true;
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND seq <= ? AND rewind_id IS NULL AND author != 'tool'");
    return rows.map((r) => ({
      id: r.id,
      uptoSeq: r.upto_seq,
      at: r.at,
      hidden: (count.get(card.conversationId, r.upto_seq) as { n: number }).n,
      undoable: r === latest && !moved,
    }));
  }

  /** The chat reloads its messages and timeline (the same signal as a rewind: the server's view changed). */
  private changed(cardId: string): void {
    const card = this.kanban.emit(cardId);
    this.bus.emit({ type: 'conversation.rewound', cardId, conversationId: card.conversationId });
  }
}

interface ClearRow {
  id: string;
  card_id: string;
  upto_seq: number;
  before: string;
  state: 'done' | 'undone';
  rewind_id: string | null;
  at: string;
}
