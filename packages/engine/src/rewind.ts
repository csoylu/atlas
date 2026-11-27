import { randomUUID } from 'node:crypto';
import { USER, isPaneLine, parseComment, parseDocRef, parseQuote, type Block, type CardStatus, type FileChange, type Message, type RewindEvent, type RewindPreview, type RewindResult, type SideEffect } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { ConflictError, InvalidError, NotFoundError, type Kanban } from './kanban.ts';
import type { Agents } from './agents.ts';
import { workspaceOf } from './projects.ts';
import type { Runner } from './runner.ts';
import type { FileState, Snapshots } from './snapshots.ts';
import { same, type FileLog } from './fileLog.ts';
import { owesTurn } from './context.ts';
import type { DoneEffect, SideEffects } from './sideEffects.ts';

/**
 * Rewind (card #34). Before each user message the card's state is noted (`checkpoints`). Rewinding to a user message
 * (« Rewind to here », the only way: since #374 Stop/Esc just stops the run) stops a run going on, hides that message
 * and every later one (messages.rewind_id: never deleted), drops a summary that covered them, puts the card back in its status of that
 * moment, kills background processes started since, and puts back the files this chat's tool calls changed since
 * (fileLog.ts). Only those (card #68): the workdir is shared with other cards and chats, whose work is never touched.
 * A file this chat changed that something else changed too (another card, or by hand) is a conflict: then no file is
 * restored, the conflicts are listed, nothing is overwritten. Undo replays the rewind's file operations backwards, under
 * the same rule (refused if a file changed since the rewind).
 *
 * Rule 2: the messages and card change in one transaction with a `rewinds` row in state 'restoring' ('undoing') listing
 * the file operations; they follow, then the state moves to 'done' ('undone'). A restart finishes a restore it finds
 * half done (recover; each operation is idempotent).
 */

/** The stop reason of a run ended by a rewind: the dispatcher leaves the card's status to the rewind. */
export const REWOUND = 'rewound by you';

/** Snapshots kept: the last 30 days, at most 500, the store under 1 GB (oldest dropped first). */
const KEEP_MS = 30 * 24 * 3600_000;
const KEEP_MAX = 500;
const STORE_CAP = 1024 * 1024 * 1024;
/** A rewind's « before » snapshot (for Undo, rewinds before #68) is kept a day. */
const UNDO_KEEP_MS = 24 * 3600_000;
/** Snapshots and blobs just made, whose row may not be written yet (a command still running), are never pruned. */
const FRESH_MS = 6 * 3600_000;
const PRUNE_EVERY_MS = 10 * 60_000;
const GC_EVERY_MS = 3600_000;

interface CardState {
  status: CardStatus;
  block: Block | null;
  todos: string | null;
}
interface CheckpointRow {
  id: number;
  card_id: string;
  seq: number;
  workdir: string | null;
  commit_sha: string | null;
  error: string | null;
  card_status: CardStatus;
  card_block: string | null;
  todos: string | null;
}
interface RewindRow {
  id: string;
  card_id: string;
  from_seq: number;
  upto_seq: number;
  workdir: string | null;
  target_commit: string | null;
  before_commit: string | null;
  files: string | null;
  files_error: string | null;
  card_before: string;
  ops: string | null;
  effects: string | null;
  state: 'restoring' | 'done' | 'undoing' | 'undone';
}
interface ChangeRow {
  workdir: string;
  path: string | null;
  before_sha: string | null;
  before_mode: string | null;
  after_sha: string | null;
  after_mode: string | null;
  error: string | null;
  tool: string;
  card_id: string;
  started_at: string;
  ended_at: string;
}
/** One file a rewind puts back: from the state the chat left it in, to its state before the chat's first change. */
interface FileOp {
  workdir: string;
  path: string;
  from: FileState;
  to: FileState;
}
interface Plan {
  ops: FileOp[];
  /** Files changed by this chat and something else: nothing is restored. */
  conflicts: string[];
  /** Changes that weren't tracked (and stay). */
  untracked: string[];
}

/** Taken before a user message is stored; recorded with its seq once it is. */
export interface Pending {
  workdir: string | null;
  state: CardState;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const iso = (ms: number) => new Date(ms).toISOString();
const stateOf = (sha: string | null, mode: string | null): FileState => (sha ? { sha, mode: mode ?? '100644' } : null);
const changeOf = (op: FileOp): FileChange => ({ path: op.path, change: op.to === null ? 'deleted' : op.from === null ? 'recreated' : 'restored' });
const reverse = (op: FileOp): FileOp => ({ ...op, from: op.to, to: op.from });

/** The text the user typed (a quoted document part, a comment on the pane, #304, a quote, #367, and the pane line, #305, are left out). */
export const userText = (m: Message): string =>
  m.content
    .flatMap((b) => (b.type === 'text' && !parseDocRef(b.text) && !parseComment(b.text) && !parseQuote(b.text) && !isPaneLine(b.text) ? [b.text] : []))
    .join('\n\n')
    .trim();

export class Rewinds {
  readonly snapshots: Snapshots;
  private lastPrune = 0;
  private pruning: Promise<void> | null = null;
  private lastGc = 0;

  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private agents: Agents,
    private runner: Runner,
    private dataDir: string,
    private fileLog: FileLog,
    private effects: SideEffects,
  ) {
    this.snapshots = fileLog.snapshots;
  }

  /** The card's state before a user message is stored (a rewind to it goes back there). Files are tracked per tool call. */
  beforeUserMessage(cardId: string): Pending {
    const card = this.kanban.get(cardId);
    return { workdir: this.workdir(card.assignee, card.projectId), state: this.state(cardId) };
  }

  /** The user message is stored as `seq`: keep its snapshot. */
  record(cardId: string, seq: number, p: Pending): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints (card_id, seq, workdir, commit_sha, error, card_status, card_block, todos, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(cardId, seq, p.workdir, null, null, p.state.status, p.state.block ? JSON.stringify(p.state.block) : null, p.state.todos, new Date().toISOString());
    if (!this.pruning) this.pruning = this.prune().catch((e: unknown) => console.error('snapshot pruning failed', e)).finally(() => (this.pruning = null));
  }

  /** Engine stop: wait for a prune in progress (it uses the database). */
  async shutdown(): Promise<void> {
    await this.pruning;
  }

  /** What rewinding to the user message `seq` would do. */
  async preview(cardId: string, seq: number): Promise<RewindPreview> {
    const target = this.target(cardId, seq);
    const hidden = this.hiddenCount(cardId, target.seq);
    const plan = await this.plan(cardId, target.at);
    const effects = this.effects.plan(cardId, target.at).map(shown);
    return { seq, hidden, files: plan.conflicts.length ? [] : plan.ops.map(changeOf), filesError: planError(plan), effects };
  }

  /** Rewind to the user message `seq` (« Rewind to here »). A run going on is stopped first. */
  async rewind(cardId: string, seq: number): Promise<RewindResult> {
    const target = this.target(cardId, seq);

    if (this.runner.current(cardId)) {
      this.runner.stop(cardId, REWOUND);
      await this.runner.settled(cardId);
    }
    // A command cut off by the stop records the files it changed before the plan reads them.
    await this.fileLog.idle(cardId);
    const card = this.kanban.get(cardId);
    const cp = this.checkpoint(cardId, target.seq);
    this.killBackground(cardId, target.at);

    const plan = await this.plan(cardId, target.at);
    const ops = plan.conflicts.length ? [] : plan.ops;
    let filesError = planError(plan);
    const id = 'rw_' + randomUUID().slice(0, 8);
    const hidden = this.hiddenCount(cardId, target.seq);
    const cardBefore = this.state(cardId);
    let done: DoneEffect[] = [];
    this.db.transaction(() => {
      const upto = (this.db.prepare('SELECT MAX(seq) AS m FROM messages WHERE conversation_id = ?').get(card.conversationId) as { m: number }).m;
      this.db
        .prepare(
          `INSERT INTO rewinds (id, card_id, from_seq, upto_seq, workdir, files, files_error, card_before, ops, state, at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, cardId, target.seq, upto, cp?.workdir ?? null, ops.length ? null : '[]', filesError, JSON.stringify(cardBefore), JSON.stringify(ops), ops.length ? 'restoring' : 'done', new Date().toISOString());
      this.db.prepare('UPDATE messages SET rewind_id = ? WHERE conversation_id = ? AND seq >= ? AND rewind_id IS NULL').run(id, card.conversationId, target.seq);
      // A /clear made after the target message goes with the messages it followed (#99): the agent sees them again.
      this.db.prepare("UPDATE context_clears SET rewind_id = ? WHERE card_id = ? AND upto_seq >= ? AND state = 'done' AND rewind_id IS NULL").run(id, cardId, target.seq);
      // The chat's file changes since are put back (not on a conflict: they stay in effect, a later rewind may retry them).
      if (!plan.conflicts.length) this.db.prepare('UPDATE file_changes SET rewind_id = ? WHERE card_id = ? AND started_at >= ? AND rewind_id IS NULL').run(id, cardId, target.at);
      // The model's view changes: a summary covering hidden messages goes (rebuilt when needed), so does the size reading.
      this.db
        .prepare(
          `UPDATE conversations SET
             summary = CASE WHEN summary_upto_seq >= @seq THEN NULL ELSE summary END,
             summary_upto_seq = CASE WHEN summary_upto_seq >= @seq THEN NULL ELSE summary_upto_seq END,
             prune_upto_seq = CASE WHEN prune_upto_seq >= @seq THEN NULL ELSE prune_upto_seq END,
             last_input_tokens = NULL, last_input_upto = NULL
           WHERE id = @conv`,
        )
        .run({ seq: target.seq, conv: card.conversationId });
      const back = cp ? { status: cp.card_status, block: cp.card_block ? (JSON.parse(cp.card_block) as Block) : null, todos: cp.todos } : { ...cardBefore };
      const settled = settle(back, 'Rewound by you. Write what to do next.');
      this.kanban.restoreState(cardId, settled.status, settled.block, { kind: 'rewound', payload: { by: USER, seq: target.seq, rewind: id, hidden } });
      if (cp) this.db.prepare('UPDATE conversations SET todos = ? WHERE id = ?').run(cp.todos, card.conversationId);
      // What the rewound part did elsewhere (#138): taken back where nobody acted on it yet, in this same transaction.
      done = this.effects.apply(id, cardId, target.at);
      this.db.prepare('UPDATE rewinds SET effects = ? WHERE id = ?').run(JSON.stringify(done), id);
    })();
    this.changed(cardId);
    for (const other of this.effects.touched(done)) if (other !== cardId) this.changed(other);

    let files: FileChange[] = [];
    if (ops.length) {
      ({ files, error: filesError } = await this.finish(id, ops, 'done', filesError));
      this.changed(cardId); // the chat's rewind row now lists the files
    }
    return { id, seq: target.seq, text: userText(target), hidden, files, filesError, effects: done.map(shown) };
  }

  /**
   * The rewinds in effect on a card (not undone), oldest first: a row each in the chat, with Undo on the one it works for.
   * Rewinds in a row (nothing written between them: « Rewind to here », then again further up) are one row (#138), whose
   * Undo undoes them all.
   */
  events(cardId: string): RewindEvent[] {
    const card = this.kanban.get(cardId);
    const rows = this.db.prepare("SELECT * FROM rewinds WHERE card_id = ? ORDER BY at, rowid").all(cardId) as (RewindRow & { at: string })[];
    const latest = rows.filter((r) => r.state !== 'undone').at(-1);
    const moved = latest ? !!this.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND seq > ?').get(card.conversationId, latest.upto_seq) : true;
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE rewind_id = ? AND conversation_id = ? AND author != 'tool'");
    const out: (RewindEvent & { upto: number })[] = [];
    let prev: RewindRow | null = null;
    for (const r of rows) {
      const live = r.state === 'done' || r.state === 'restoring';
      if (!live) {
        prev = null;
        continue;
      }
      const e = {
        id: r.id,
        fromSeq: r.from_seq,
        at: r.at,
        hidden: (count.get(r.id, card.conversationId) as { n: number }).n,
        files: r.files === null ? null : (JSON.parse(r.files) as FileChange[]),
        filesError: r.files_error,
        effects: r.effects ? (JSON.parse(r.effects) as DoneEffect[]).map(shown) : [],
        undoable: r === latest && r.state === 'done' && !moved,
        upto: r.upto_seq,
      };
      const last = out.at(-1);
      if (prev && last && last.upto === r.upto_seq) {
        out[out.length - 1] = {
          ...e,
          fromSeq: Math.min(last.fromSeq, e.fromSeq),
          hidden: last.hidden + e.hidden,
          files: last.files === null || e.files === null ? null : [...last.files, ...e.files],
          filesError: [last.filesError, e.filesError].filter(Boolean).join('; ') || null,
          effects: [...last.effects, ...e.effects],
        };
      } else out.push(e);
      prev = r;
    }
    return out.map(({ upto: _upto, ...e }) => e);
  }

  /**
   * Undo a rewind: its messages come back, the card's state, and the files as they were right before it. `resume`: the
   * restored conversation still owes an answer (a rewind made during a run cut the agent off mid-turn) on a card that is
   * still open, so the caller puts the agent back to work, as if the user had written.
   */
  async undo(id: string): Promise<{ cardId: string; files: FileChange[]; filesError: string | null; resume: boolean }> {
    const res = await this.undoFiles(id);
    let r = this.db.prepare('SELECT card_id, card_before, upto_seq FROM rewinds WHERE id = ?').get(id) as { card_id: string; card_before: string; upto_seq: number };
    // The rewinds just before it, in a row with it (one row in the chat), are undone with it (#138).
    for (;;) {
      const before = this.db.prepare("SELECT id, card_id, card_before, upto_seq, state FROM rewinds WHERE card_id = ? AND state != 'undone' ORDER BY at DESC, rowid DESC LIMIT 1").get(r.card_id) as
        | { id: string; card_id: string; card_before: string; upto_seq: number; state: string }
        | undefined;
      if (!before || before.state !== 'done' || before.upto_seq !== r.upto_seq) break;
      const more = await this.undoFiles(before.id);
      res.files.push(...more.files);
      res.filesError = [res.filesError, more.filesError].filter(Boolean).join('; ') || null;
      r = before;
    }
    // A direct chat is always open (its status stays 'done' between replies); a work card only if it wasn't finished.
    const open = this.kanban.get(r.card_id).board === 'direct' || !['done', 'review', 'closed', 'archived'].includes((JSON.parse(r.card_before) as CardState).status);
    return { cardId: r.card_id, ...res, resume: open && owesTurn(this.kanban.messages(r.card_id), this.kanban.taskNotes(this.kanban.get(r.card_id).conversationId)) };
  }

  private async undoFiles(id: string): Promise<{ files: FileChange[]; filesError: string | null }> {
    const r = this.db.prepare('SELECT * FROM rewinds WHERE id = ?').get(id) as RewindRow | undefined;
    if (!r) throw new NotFoundError(`rewind ${id} not found`);
    if (r.state !== 'done') throw new ConflictError(r.state === 'undone' ? 'this rewind was already undone' : 'this rewind is still being done');
    const latest = this.db.prepare("SELECT id FROM rewinds WHERE card_id = ? AND state != 'undone' ORDER BY at DESC, rowid DESC LIMIT 1").get(r.card_id) as { id: string };
    if (latest.id !== id) throw new ConflictError('a later rewind was made on this chat: undo that one first');
    const card = this.kanban.get(r.card_id);
    if (this.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND seq > ?').get(card.conversationId, r.upto_seq))
      throw new ConflictError('the chat has moved on since the rewind, so it can no longer be undone');
    if (this.runner.current(r.card_id)) throw new ConflictError('the agent is working: stop it first');
    // The files the rewind put back, back as they were before it, only if nothing changed them since (never overwrite).
    const ops = r.ops ? (JSON.parse(r.ops) as FileOp[]).map(reverse) : [];
    const effects = r.effects ? (JSON.parse(r.effects) as DoneEffect[]) : [];
    let left: string[] = [];
    const changed: string[] = [];
    for (const op of ops) if (!same(await this.snapshots.state(op.workdir, op.path), op.from)) changed.push(op.path);
    if (changed.length) throw new ConflictError(`can't undo: ${changed.join(', ')} changed since the rewind, so putting the files back would overwrite that`);
    this.db.transaction(() => {
      this.db.prepare('UPDATE rewinds SET state = ?, undone_at = ? WHERE id = ?').run(ops.length ? 'undoing' : 'undone', new Date().toISOString(), id);
      this.db.prepare('UPDATE messages SET rewind_id = NULL WHERE rewind_id = ?').run(id);
      this.db.prepare('UPDATE context_clears SET rewind_id = NULL WHERE rewind_id = ?').run(id);
      this.db.prepare('UPDATE file_changes SET rewind_id = NULL WHERE rewind_id = ?').run(id);
      this.db.prepare('UPDATE conversations SET last_input_tokens = NULL, last_input_upto = NULL WHERE id = ?').run(card.conversationId);
      const back = JSON.parse(r.card_before) as CardState;
      const settled = settle(back, 'Stopped by you. Write what to do next.');
      this.kanban.restoreState(r.card_id, settled.status, settled.block, { kind: 'rewind_undone', payload: { by: USER, rewind: id } });
      this.db.prepare('UPDATE conversations SET todos = ? WHERE id = ?').run(back.todos, card.conversationId);
      left = this.effects.undo(id, effects);
    })();
    this.changed(r.card_id);
    for (const other of this.effects.touched(effects)) if (other !== r.card_id) this.changed(other);
    const note = left.length ? left.join('; ') : null;
    if (!ops.length)
      return {
        files: [],
        filesError: [r.ops === null && r.before_commit ? 'the files were kept: this rewind was made before rewinds tracked their own files' : null, note].filter(Boolean).join('; ') || null,
      };
    const done = await this.finish(id, ops, 'undone', null);
    return { files: done.files, filesError: [done.error, note].filter(Boolean).join('; ') || null };
  }

  /** At start: finish file operations a stopped engine left half done (rule 2). */
  async recover(): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM rewinds WHERE state IN ('restoring', 'undoing')").all() as RewindRow[];
    for (const r of rows) {
      const state = r.state === 'restoring' ? 'done' : 'undone';
      // A rewind from before #68 (a whole-folder restore): finishing it could undo other chats' work, so it is left.
      if (!r.ops) {
        this.db.prepare('UPDATE rewinds SET state = ? WHERE id = ?').run(state, r.id);
        continue;
      }
      const ops = JSON.parse(r.ops) as FileOp[];
      await this.finish(r.id, state === 'done' ? ops : ops.map(reverse), state, r.files_error);
    }
    await this.prune(true);
  }

  /** Drop old snapshots (retention, then the size cap) and let git reclaim their space now and then. */
  async prune(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    const pruned = (why: string) => `the snapshot was deleted (${why}) to save space`;
    this.db.transaction(() => {
      this.db.prepare('UPDATE checkpoints SET commit_sha = NULL, error = ? WHERE commit_sha IS NOT NULL AND at < ?').run(pruned('older than 30 days'), iso(now - KEEP_MS));
      this.db
        .prepare(
          `UPDATE checkpoints SET commit_sha = NULL, error = ? WHERE commit_sha IS NOT NULL
             AND id NOT IN (SELECT id FROM checkpoints WHERE commit_sha IS NOT NULL ORDER BY id DESC LIMIT ?)`,
        )
        .run(pruned(`only the last ${KEEP_MAX} are kept`), KEEP_MAX);
      this.db.prepare("UPDATE rewinds SET before_commit = NULL WHERE before_commit IS NOT NULL AND state IN ('done', 'undone') AND at < ?").run(iso(now - UNDO_KEEP_MS));
      // A rewind reaches back as far as the oldest file change kept (30 days, like the snapshots).
      this.db.prepare('DELETE FROM file_changes WHERE ended_at < ?').run(iso(now - KEEP_MS));
      this.effects.prune(iso(now - KEEP_MS));
      this.db.prepare("UPDATE rewinds SET ops = '[]' WHERE ops IS NOT NULL AND ops != '[]' AND state IN ('done', 'undone') AND at < ?").run(iso(now - KEEP_MS));
    })();
    await this.dropUnused(now);
    const size = await this.snapshots.size();
    if (size > STORE_CAP) {
      // Over the cap: the oldest half goes; git frees the space at the next gc.
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE commit_sha IS NOT NULL').get() as { n: number }).n;
      this.db
        .prepare(`UPDATE checkpoints SET commit_sha = NULL, error = ? WHERE id IN (SELECT id FROM checkpoints WHERE commit_sha IS NOT NULL ORDER BY id LIMIT ?)`)
        .run(pruned('the snapshot store was over 1 GB'), Math.ceil(n / 2));
      const f = (this.db.prepare('SELECT COUNT(*) AS n FROM file_changes').get() as { n: number }).n;
      this.db.prepare('DELETE FROM file_changes WHERE id IN (SELECT id FROM file_changes ORDER BY id LIMIT ?)').run(Math.ceil(f / 2));
      await this.dropUnused(now);
      this.lastGc = 0;
    }
    if (now - this.lastGc > GC_EVERY_MS) {
      this.lastGc = now;
      await this.snapshots.gc();
    }
  }

  private async dropUnused(now: number): Promise<void> {
    // Listed before reading what is in use: a snapshot or blob made in between is fresh, never dropped.
    const commits = await this.snapshots.kept('k');
    const blobs = await this.snapshots.kept('b');
    const fresh = this.snapshots.fresh(now - FRESH_MS);
    const used = new Set<string>(fresh);
    for (const r of this.db.prepare('SELECT commit_sha AS c FROM checkpoints WHERE commit_sha IS NOT NULL').all() as { c: string }[]) used.add(r.c);
    for (const r of this.db.prepare('SELECT target_commit AS a, before_commit AS b, ops FROM rewinds').all() as { a: string | null; b: string | null; ops: string | null }[]) {
      if (r.a) used.add(r.a);
      if (r.b) used.add(r.b);
      for (const op of r.ops ? (JSON.parse(r.ops) as FileOp[]) : []) for (const s of [op.from?.sha, op.to?.sha]) if (s) used.add(s);
    }
    for (const r of this.db.prepare('SELECT before_sha AS a, after_sha AS b FROM file_changes').all() as { a: string | null; b: string | null }[]) {
      if (r.a) used.add(r.a);
      if (r.b) used.add(r.b);
    }
    await this.snapshots.drop(commits.filter((c) => !used.has(c)), 'k');
    await this.snapshots.drop(blobs.filter((c) => !used.has(c)), 'b');
  }

  /**
   * The files this chat's tool calls changed since `since` (not already put back by a rewind), each with the operation
   * that puts it back, and the conflicts: a file not as the chat left it, or changed by another card in the meantime.
   */
  private async plan(cardId: string, since: string): Promise<Plan> {
    const rows = this.db
      .prepare('SELECT * FROM file_changes WHERE card_id = ? AND started_at >= ? AND rewind_id IS NULL ORDER BY id')
      .all(cardId, since) as ChangeRow[];
    const untracked = rows.flatMap((r) => (r.error ? [r.error] : []));
    const tracking = this.db.prepare("SELECT applied_at AS at FROM schema_migrations WHERE name = '0031_file_changes.sql'").get() as { at: string } | undefined;
    if (tracking && since < tracking.at) untracked.unshift(`changes made before ${tracking.at.slice(0, 10)}, when rewinds started tracking their own files, stay as they are`);
    const groups = new Map<string, ChangeRow[]>();
    for (const r of rows) {
      if (r.path === null) continue;
      const key = r.workdir + '\0' + r.path;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const others = this.db.prepare('SELECT * FROM file_changes WHERE workdir = ? AND path = ? AND card_id != ? AND rewind_id IS NULL AND ended_at >= ? ORDER BY id');
    const ops: FileOp[] = [];
    const conflicts: string[] = [];
    for (const all of groups.values()) {
      const { workdir, path } = all[0]! as { workdir: string; path: string };
      const theirs = others.all(workdir, path, cardId, all[0]!.started_at) as ChangeRow[];
      // A shell command's snapshots also catch what another card wrote meanwhile: a shell change identical to a file
      // tool's change of the other side is that file tool's (theirs is dropped from ours, ours from theirs).
      const g = all.filter((r) => !(r.tool === 'shell' && theirs.some((o) => o.tool !== 'shell' && overlaps(o, r) && sameChange(o, r))));
      if (!g.length) continue;
      const first = g[0]!;
      const last = g.at(-1)!;
      const before = stateOf(first.before_sha, first.before_mode);
      const after = stateOf(last.after_sha, last.after_mode);
      const by = theirs.find((o) => o.ended_at >= first.started_at && !(o.tool === 'shell' && g.some((r) => overlaps(o, r) && sameChange(o, r))));
      if (by) {
        conflicts.push(`${path} was also changed by ${this.label(by.card_id)}`);
        continue;
      }
      if (g.some((r, i) => i > 0 && !same(stateOf(r.before_sha, r.before_mode), stateOf(g[i - 1]!.after_sha, g[i - 1]!.after_mode)))) {
        conflicts.push(`${path} was changed by something else between this chat's changes`);
        continue;
      }
      const now = await this.snapshots.state(workdir, path);
      if (same(now, before)) continue; // already as it was
      if (!same(now, after)) {
        conflicts.push(`${path} was changed by something else since this chat changed it`);
        continue;
      }
      ops.push({ workdir, path, from: after, to: before });
    }
    ops.sort((a, b) => a.path.localeCompare(b.path));
    return { ops, conflicts, untracked };
  }

  /** How another card or chat is named in a conflict. */
  private label(cardId: string): string {
    const r = this.db.prepare('SELECT number, title, board FROM cards WHERE id = ?').get(cardId) as { number: number | null; title: string; board: string } | undefined;
    if (!r) return 'a deleted task';
    return r.number !== null && r.board !== 'direct' ? `task #${r.number} (${r.title})` : `the chat « ${r.title} »`;
  }

  /**
   * Do the file operations, then mark the rewind `state`. Each is idempotent (a restart redoes them): a file already in
   * its target state counts as done; one found in neither state was changed meanwhile and is left alone (reported).
   */
  private async finish(id: string, ops: FileOp[], state: 'done' | 'undone', note: string | null): Promise<{ files: FileChange[]; error: string | null }> {
    const done: FileOp[] = [];
    const problems: string[] = [];
    for (const op of ops) {
      try {
        const now = await this.snapshots.state(op.workdir, op.path);
        if (!same(now, op.to)) {
          if (!same(now, op.from)) {
            problems.push(`${op.path} was changed meanwhile, so it was left as it is`);
            continue;
          }
          await this.snapshots.put(op.workdir, op.path, op.to);
        }
        done.push(op);
      } catch (e) {
        problems.push(`${op.path}: ${errText(e)}`);
        console.error(`rewind ${id}: putting back ${op.path} in ${op.workdir} failed`, e);
      }
    }
    const files = done.map(changeOf);
    const error = [note, ...problems].filter(Boolean).join('; ') || null;
    // Undo replays exactly what was done.
    const kept = state === 'done' ? done : done.map(reverse);
    if (state === 'done') this.db.prepare("UPDATE rewinds SET state = 'done', files = ?, files_error = ?, ops = ? WHERE id = ?").run(JSON.stringify(files), error, JSON.stringify(kept), id);
    else this.db.prepare("UPDATE rewinds SET state = 'undone' WHERE id = ?").run(id);
    return { files, error };
  }

  private changed(cardId: string): void {
    const card = this.kanban.emit(cardId);
    this.bus.emit({ type: 'conversation.rewound', cardId, conversationId: card.conversationId });
  }

  /** Background processes the card started since `at` (in the rewound part): killed. */
  private killBackground(cardId: string, at: string): void {
    const rows = this.db
      .prepare("SELECT id, agent_id FROM background_processes WHERE card_id = ? AND status = 'running' AND started_at >= ?")
      .all(cardId, at) as { id: string; agent_id: string }[];
    for (const r of rows) this.runner.background.kill(r.id, r.agent_id);
  }

  private target(cardId: string, seq: number): Message {
    const m = this.kanban.messages(cardId).find((x) => x.seq === seq);
    if (!m) throw new NotFoundError(`no visible message #${seq} on this chat`);
    if (m.author !== USER) throw new InvalidError('only your own messages can be rewound to');
    return m;
  }

  /** Messages the chat shows from `seq` on (tool results aren't shown on their own). */
  private hiddenCount(cardId: string, seq: number): number {
    return this.kanban.messages(cardId).filter((m) => m.seq >= seq && m.author !== 'tool').length;
  }

  private checkpoint(cardId: string, seq: number): CheckpointRow | null {
    return (this.db.prepare('SELECT * FROM checkpoints WHERE card_id = ? AND seq = ?').get(cardId, seq) as CheckpointRow | undefined) ?? null;
  }

  private state(cardId: string): CardState {
    const card = this.kanban.get(cardId);
    const t = this.db.prepare('SELECT todos FROM conversations WHERE id = ?').get(card.conversationId) as { todos: string | null } | undefined;
    // A retry waiting in todo (#131) lives in the block columns too: keep it, so a rewind puts it back as it was.
    const block = card.block ?? (card.retry ? { kind: 'transient' as const, reason: card.retry.reason, options: [], until: card.retry.at } : null);
    return { status: card.status, block, todos: t?.todos ?? null };
  }

  /** The agent's workspace in the card's project (#214); null when it has none ready there (nothing to snapshot). */
  private workdir(agentId: string | null, projectId: string): string | null {
    if (!agentId || !this.agents.list().some((a) => a.id === agentId)) return null;
    try {
      return workspaceOf(this.db, this.dataDir, agentId, projectId);
    } catch {
      return null; // not a member there, or its clone isn't ready: the run would fail before touching files
    }
  }
}

/** A side effect as the chat shows it (without what Undo needs). */
const shown = ({ sid: _sid, undo: _undo, ...e }: DoneEffect): SideEffect => e;

const sameChange = (a: ChangeRow, b: ChangeRow) =>
  same(stateOf(a.before_sha, a.before_mode), stateOf(b.before_sha, b.before_mode)) && same(stateOf(a.after_sha, a.after_mode), stateOf(b.after_sha, b.after_mode));
const overlaps = (a: ChangeRow, b: ChangeRow) => a.started_at <= b.ended_at && b.started_at <= a.ended_at;

/** What the rewind result says about the files: conflicts (nothing restored), or changes that stay (not tracked). */
function planError(p: Plan): string | null {
  if (p.conflicts.length) return `files not restored, to keep work done elsewhere: ${p.conflicts.join('; ')}`;
  if (p.untracked.length) return `some changes can't be put back: ${p.untracked.join('; ')}`;
  return null;
}

/** A card isn't put back to work by a rewind or its undo: a status that would start (or seem to run) a run waits for the user. */
function settle(s: CardState, reason: string): { status: CardStatus; block: Block | null } {
  if (s.status === 'running' || s.status === 'ready') return { status: 'blocked', block: { kind: 'needs_input', reason, options: [], until: null } };
  return { status: s.status, block: s.status === 'blocked' || (s.status === 'todo' && s.block?.kind === 'transient') ? s.block : null };
}
