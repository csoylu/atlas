import { execFile } from 'node:child_process';
import type { Card, CardPr, Run } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import type { Kanban } from './kanban.ts';
import { InvalidError } from './kanban.ts';
import type { Agents } from './agents.ts';
import type { Runner } from './runner.ts';
import { insertNotification } from './notifications.ts';
import { isMember, projectRow } from './projects.ts';
import type { SyncResult } from './prSync.ts';

/**
 * Tasks linked to their pull requests (#189, design §7.1). A task In review has open PRs; this module reads them from
 * GitHub (`gh api`, the user's own login: no token in SQLite) and moves the task, with no agent run:
 * - every PR merged (or closed with one merged) → done; also from blocked (#231: merged outside the flow while the task
 *   waited on the user, it needs no decision any more);
 * - CI red, a conflict with the base, `qa/validated` failed, or every PR closed unmerged → ready, the reason as a note;
 * - CI green on a head the reviewer hasn't seen → start the reviewer's run in the task's own thread.
 * GitHub unreadable: nothing moves on old data; the card says why, and after 15 min one Inbox item says so.
 * Merge queue (#236): the tasks In review of a project are reviewed one at a time, in the order they asked
 * (cards.review_queued_at). Only the head gets a reviewer run, and only once its PRs are up to date with main: Atlas
 * rebases them first (prSync.ts, in the reviewer's clone; new migrations renumbered above main's) and waits for CI on
 * the new head. A rebase that conflicts sends the task back with the files named and the queue moves on. A merge
 * (the queue's or one from Master's terminal) marks the other queued PRs to be brought up to date again.
 * Everything lives in card_prs and cards: a restart resumes from the tables.
 */

export const POLL_MS = 60_000;
export const UNREADABLE_NOTIFY_MS = 15 * 60_000;
const SHA = 7;

/** What one read of a PR returns (gh client). */
export interface GhPr {
  state: 'open' | 'merged' | 'closed';
  mergeSha: string | null;
  headSha: string;
  branch: string;
  base: string;
  mergeable: boolean | null;
  ci: CardPr['ci'];
  qa: CardPr['qa'];
  qaDescription: string | null;
  /** The failing check when ci is failure (#238): its name and link. Omitted = not known. */
  ciFailed?: CardPr['ciFailed'];
}
export type GhRead = (repo: string, number: number) => Promise<GhPr>;
/** Bring one PR of the head of a queue up to date with main (prSync.ts syncBranch in the reviewer's clone). */
export type PrSync = (a: { repo: string; branch: string; sha: string; base: string; reviewer: string; projectId: string }) => Promise<SyncResult>;

/** https://github.com/owner/name/pull/12 (any suffix) → its repo and number. */
export function parsePrUrl(url: string): { repo: string; number: number; url: string } {
  const m = url.trim().match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (!m) throw new InvalidError(`not a GitHub pull request url: ${url} (expected https://github.com/owner/repo/pull/N)`);
  return { repo: m[1]!, number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` };
}

interface PrRow {
  card_id: string;
  repo: string;
  number: number;
  url: string;
  branch: string | null;
  base: string | null;
  head_sha: string | null;
  state: CardPr['state'];
  merge_sha: string | null;
  mergeable: number | null;
  ci: CardPr['ci'];
  qa: CardPr['qa'];
  qa_description: string | null;
  checked_at: string | null;
  error: string | null;
  error_since: string | null;
  reviewed_sha: string | null;
  ci_failed_name: string | null;
  ci_failed_url: string | null;
  failed_sha: string | null;
  synced_sha: string | null;
  sync_error: string | null;
}

const toPr = (r: PrRow): CardPr => ({
  repo: r.repo,
  number: r.number,
  url: r.url,
  branch: r.branch,
  base: r.base,
  headSha: r.head_sha,
  state: r.state,
  mergeSha: r.merge_sha,
  mergeable: r.mergeable === null ? null : r.mergeable === 1,
  ci: r.ci,
  ciFailed: r.ci_failed_name ? { name: r.ci_failed_name, url: r.ci_failed_url } : null,
  qa: r.qa,
  qaDescription: r.qa_description,
  checkedAt: r.checked_at,
  error: r.error,
  errorSince: r.error_since,
  reviewedSha: r.reviewed_sha,
});

export function cardPrs(db: Db, cardId: string): CardPr[] {
  return (db.prepare('SELECT * FROM card_prs WHERE card_id = ? ORDER BY linked_at, number').all(cardId) as PrRow[]).map(toPr);
}

const short = (sha: string | null) => (sha ?? '').slice(0, SHA);
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** The kick of a reviewer run: what to check, and how the task moves after. */
export function reviewKick(card: Card, prs: CardPr[], again = false): string {
  const list = prs.map((p) => `PR #${p.number} (${p.url}, branch ${p.branch}, head ${p.headSha})`).join(', ');
  return (
    (again ? 'Your last review run of this head ended without a verdict: nothing was validated or failed on GitHub. ' : '') +
    `You review this task's pull request${prs.length > 1 ? 's' : ''}: ${list}. CI is green. ` +
    `@${card.assignee ?? 'nobody'} built it: the earlier messages marked @${card.assignee ?? 'nobody'} are theirs, not yours. ` +
    "Check it the way the project says (its CLAUDE.md), then give your verdict with pr_validate (ok with the head sha you checked and merge: true, " +
    "or fail with the reason for the builder): it applies the project's gate. A review ends with one of the two on the head. " +
    'The task moves by itself: merged → done, failed → back to the builder with your reason.'
  );
}

/** Review runs per head before a review that ends without a verdict is shown as stalled instead of started again. */
export const REVIEW_TRIES = 2;

export interface PrsOptions {
  read: GhRead;
  sync: PrSync;
  /** false: no timer (tests call poll()). */
  intervalMs?: number | false;
  now?: () => number;
}

export class Prs {
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private polling: Promise<void> | null = null;
  private again = false;
  private readonly now: () => number;

  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private agents: Agents,
    private runner: Runner,
    private opts: PrsOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.stop();
    if (this.opts.intervalMs !== false) {
      this.timer = setInterval(() => void this.poll(), this.opts.intervalMs ?? POLL_MS);
      this.timer.unref();
    }
    // Read right away when a task is handed to review (its PRs never read yet) and when a reviewer's run ends.
    this.unsubscribe = this.bus.on((e) => {
      if (e.type === 'card.updated' && e.card.status === 'review' && e.card.prs.some((p) => !p.checkedAt && !p.error)) void this.poll();
      if (e.type === 'run.updated' && e.run.status !== 'running') {
        const c = this.cardOrNull(e.run.cardId);
        if (c?.status === 'review' && c.reviewer === e.run.agentId) void this.poll();
      }
    });
    void this.poll();
  }

  stop(): void {
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Wait for the poll in progress (stop before closing the db). */
  async idle(): Promise<void> {
    while (this.polling) await this.polling;
  }

  /** Read every open PR of the tasks In review, then move them. One poll at a time; a request during one runs another after. */
  poll(): Promise<void> {
    if (this.polling) {
      this.again = true;
      return this.polling;
    }
    this.polling = (async () => {
      try {
        do {
          this.again = false;
          await this.pollOnce();
        } while (this.again);
      } finally {
        this.polling = null;
      }
    })();
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    // Blocked too (#231): a PR merged while its task waits on the user leaves no decision, so it must not stay in « Needs you ».
    for (const card of this.kanban.list().filter((c) => (c.status === 'review' || c.status === 'blocked') && c.prs.length)) {
      for (const pr of card.prs.filter((p) => p.state === 'open')) await this.read(card.id, pr);
      try {
        this.decide(card.id);
      } catch (e) {
        console.error(`pull requests of ${card.id}: deciding failed`, e);
      }
    }
    const projects = this.db.prepare("SELECT DISTINCT project_id AS id FROM cards WHERE status = 'review'").all() as { id: string }[];
    for (const { id } of projects) {
      try {
        await this.advance(id);
      } catch (e) {
        console.error(`merge queue of project ${id}: advancing failed`, e);
      }
    }
  }

  /** The tasks In review of a project with a PR, in queue order (#236). */
  queue(projectId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT id FROM cards WHERE project_id = ? AND status = 'review' AND EXISTS (SELECT 1 FROM card_prs p WHERE p.card_id = cards.id)
           ORDER BY review_queued_at IS NULL, review_queued_at, rowid`,
        )
        .all(projectId) as { id: string }[]
    ).map((r) => r.id);
  }

  private row(cardId: string, p: CardPr): PrRow {
    return this.db.prepare('SELECT * FROM card_prs WHERE card_id = ? AND repo = ? AND number = ?').get(cardId, p.repo, p.number) as PrRow;
  }

  /**
   * The head of the project's queue: up to date with main first, then decide() may start its review. A head whose
   * rebase conflicts goes back to its builder and the next one comes up, in the same poll.
   */
  private async advance(projectId: string): Promise<void> {
    const at = () => new Date(this.now()).toISOString();
    // Moved to review without task_request_review: at the end of the queue.
    this.db.prepare("UPDATE cards SET review_queued_at = ? WHERE project_id = ? AND status = 'review' AND review_queued_at IS NULL").run(at(), projectId);
    try {
      await this.advanceHead(projectId, at);
    } finally {
      // Positions shown on the cards (« 2nd in the queue… »): when the queue changed, every member's card is re-sent.
      const q = this.queue(projectId);
      if (this.shown.get(projectId) !== q.join(',')) {
        this.shown.set(projectId, q.join(','));
        for (const id of q) this.kanban.emit(id);
      }
    }
  }

  /** The queue's order as last shown, per project (display only: re-sent on change, rebuilt after a restart). */
  private shown = new Map<string, string>();

  private async advanceHead(projectId: string, at: () => string): Promise<void> {
    for (;;) {
      const headId = this.queue(projectId)[0];
      if (!headId) return;
      if (this.db.prepare('UPDATE cards SET review_head_at = ? WHERE id = ? AND review_head_at IS NULL').run(at(), headId).changes) this.kanban.emit(headId);
      const card = this.kanban.get(headId);
      if (card.prs.some((p) => p.error || !p.checkedAt)) return; // nothing moves on old data
      const open = card.prs.filter((p) => p.state === 'open');
      let gone = false;
      for (const p of open.filter((x) => x.headSha && this.row(headId, x).synced_sha !== x.headSha)) {
        let r: SyncResult;
        try {
          if (!card.reviewer) throw new Error('no reviewer: set the review agent in Settings → Board & triage');
          r = await this.opts.sync({ repo: p.repo, branch: p.branch ?? '', sha: p.headSha!, base: p.base ?? 'main', reviewer: card.reviewer, projectId });
        } catch (e) {
          const why = (e instanceof Error ? e.message : String(e)).trim().split('\n')[0] || 'unknown error';
          this.db.prepare('UPDATE card_prs SET sync_error = ? WHERE card_id = ? AND repo = ? AND number = ?').run(why, headId, p.repo, p.number);
          this.kanban.emit(headId);
          return; // shown on the card, tried again at the next poll
        }
        if (!this.cardOrNull(headId) || this.kanban.get(headId).status !== 'review') return;
        const set = (sha: string | null) => this.db.prepare('UPDATE card_prs SET synced_sha = ?, sync_error = NULL WHERE card_id = ? AND repo = ? AND number = ?').run(sha, headId, p.repo, p.number);
        if (r.kind === 'current') set(p.headSha);
        else if (r.kind === 'moved') set(null); // a new head: read it first
        else if (r.kind === 'pushed') {
          const what = [
            r.rebased ? `PR #${p.number} rebased onto ${p.base ?? 'main'} ${short(r.onto)}` : `PR #${p.number} updated`,
            ...r.renamed.map((m) => `migration ${m.fromStem} renamed ${m.toStem}`),
          ];
          this.db.transaction(() => {
            set(r.newHead);
            this.kanban.appendMessage(headId, 'user', 'system', [
              { type: 'text', text: `Merge queue: ${what.join('; ')}. New head ${short(r.newHead)} (was ${short(r.oldHead)}): the review starts when CI is green on it.` },
            ]);
            this.kanban.event(headId, 'queue_updated', { by: 'github', pr: p.number, from: r.oldHead, to: r.newHead, onto: r.onto, renamed: r.renamed.map((m) => ({ from: m.from, to: m.to })) });
          })();
        } else {
          this.sendBack(card, p, `PR #${p.number} conflicts with ${p.base ?? 'main'} in ${r.files.join(', ')}: rebase it on ${p.base ?? 'main'}`);
          gone = true;
          break;
        }
        this.kanban.emit(headId);
      }
      if (gone) continue; // the next task in the queue comes up
      this.decide(headId);
      return;
    }
  }

  /** Main moved (a merge): every queued PR of the project is brought up to date again before its review. */
  private mainMoved(projectId: string): void {
    this.db.prepare("UPDATE card_prs SET synced_sha = NULL WHERE card_id IN (SELECT id FROM cards WHERE project_id = ? AND status = 'review')").run(projectId);
  }

  private async read(cardId: string, pr: CardPr): Promise<void> {
    const at = new Date(this.now()).toISOString();
    let got: GhPr;
    try {
      got = await this.opts.read(pr.repo, pr.number);
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).trim().split('\n')[0] || 'unknown error';
      this.db
        .prepare('UPDATE card_prs SET error = ?, error_since = COALESCE(error_since, ?) WHERE card_id = ? AND repo = ? AND number = ?')
        .run(why, at, cardId, pr.repo, pr.number);
      this.unreadable(cardId, pr.number, why);
      this.kanban.emit(cardId);
      return;
    }
    if (!this.cardOrNull(cardId)) return; // deleted while reading
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE card_prs SET state = ?, merge_sha = ?, head_sha = ?, branch = ?, base = ?, mergeable = ?, ci = ?, ci_failed_name = ?,
             ci_failed_url = ?, qa = ?, qa_description = ?, checked_at = ?, error = NULL, error_since = NULL WHERE card_id = ? AND repo = ? AND number = ?`,
        )
        .run(
          got.state, got.mergeSha, got.headSha, got.branch, got.base, got.mergeable === null ? null : got.mergeable ? 1 : 0, got.ci,
          got.ci === 'failure' ? (got.ciFailed?.name ?? null) : null, got.ci === 'failure' ? (got.ciFailed?.url ?? null) : null,
          got.qa, got.qaDescription, at, cardId, pr.repo, pr.number,
        );
      // GitHub reads again: its « can't read » item leaves the Inbox.
      const { changes } = this.db
        .prepare("UPDATE notifications SET archived_at = ?, read_at = COALESCE(read_at, ?) WHERE kind = 'github.unreadable' AND card_id = ? AND archived_at IS NULL")
        .run(at, at, cardId);
      if (changes) this.bus.emit({ type: 'inbox.changed' });
    })();
    this.kanban.emit(cardId);
  }

  /** After UNREADABLE_NOTIFY_MS of failed reads: one Inbox item per stretch of failures (archived when a read works). */
  private unreadable(cardId: string, number: number, why: string): void {
    const row = this.db.prepare('SELECT error_since FROM card_prs WHERE card_id = ? AND number = ?').get(cardId, number) as { error_since: string } | undefined;
    if (!row || this.now() - Date.parse(row.error_since) < UNREADABLE_NOTIFY_MS) return;
    if (this.db.prepare("SELECT 1 FROM notifications WHERE kind = 'github.unreadable' AND card_id = ? AND at >= ?").get(cardId, row.error_since)) return;
    const card = this.kanban.get(cardId);
    const n = insertNotification(
      this.db,
      { kind: 'github.unreadable', title: `Atlas can't read GitHub: ${why}`, body: `PR #${number} of “${card.title}” has not been read since ${hhmm(row.error_since)}. The task waits; nothing moves on old data.`, cardId },
      new Date(this.now()),
    );
    this.bus.emit({ type: 'notification.created', notification: n });
  }

  /**
   * Move a task In review from what its PRs say. Nothing moves while a PR can't be read. A blocked task (#231) only
   * moves when its PRs are merged (→ done): anything else stays the user's call.
   */
  decide(cardId: string): void {
    const card = this.kanban.get(cardId);
    if ((card.status !== 'review' && card.status !== 'blocked') || !card.prs.length) return;
    const prs = card.prs;
    if (prs.some((p) => p.error || !p.checkedAt)) return;
    const open = prs.filter((p) => p.state === 'open');
    const merged = prs.filter((p) => p.state === 'merged');
    if (card.status === 'blocked' && (open.length || !merged.length || this.runner.current(cardId))) return;
    if (!open.length) {
      if (merged.length) {
        const text = merged.map((p) => `PR #${p.number} merged into ${p.base ?? 'its base'} (${short(p.mergeSha)})`).join(', ');
        this.kanban.update(cardId, { status: 'done' }, 'github', text);
        this.kanban.event(cardId, 'completed', { by: 'github', summary: text });
        this.mainMoved(card.projectId);
      } else this.sendBack(card, null, prs.map((p) => `PR #${p.number} was closed without merging`).join(', '));
      return;
    }
    for (const p of open) {
      if (p.headSha === null || p.headSha === this.failedSha(cardId, p)) continue;
      const why =
        p.ci === 'failure'
          ? p.ciFailed // the repo's own rules (tests, changelog entry…) are its CI checks (#238): name and link the red one
            ? `CI check "${p.ciFailed.name}" failed on ${short(p.headSha)}${p.ciFailed.url ? ` (${p.ciFailed.url})` : ''}: its log says what to fix`
            : `CI failed on ${short(p.headSha)}`
          : p.mergeable === false
            ? `conflicts with ${p.base ?? 'its base'}: rebase`
            : p.qa === 'failure'
              ? `Validation failed${card.reviewer ? ` (@${card.reviewer})` : ''}: ${p.qaDescription ?? 'no reason given'}`
              : null;
      if (why) return this.sendBack(card, p, `PR #${p.number}: ${why}`);
    }
    // The merge queue (#236): only its head is reviewed, once its PRs are up to date with main (advance()).
    if (card.status !== 'review' || this.queue(card.projectId)[0] !== cardId) return;
    if (open.some((p) => this.row(cardId, p).synced_sha !== p.headSha)) return;
    // The reviewer's run ended and GitHub says nothing about the head (#221): not a review. Once more, then shown.
    const stall = this.stall(card);
    let again = false;
    if (stall && stall.tries < REVIEW_TRIES) {
      this.db.transaction(() => {
        for (const p of stall.prs) this.db.prepare('UPDATE card_prs SET reviewed_sha = NULL WHERE card_id = ? AND repo = ? AND number = ?').run(cardId, p.repo, p.number);
        this.kanban.event(cardId, 'review_retry', { by: 'github', reviewer: stall.by, runId: stall.run.id, prs: stall.prs.map((p) => ({ number: p.number, sha: p.headSha })) });
      })();
      again = true;
    } else if (stall) this.stalled(card, stall);
    const fresh = again ? this.kanban.get(cardId) : card;
    // CI green on every open PR, none validated yet on this head: the reviewer's turn.
    const openNow = fresh.prs.filter((p) => p.state === 'open');
    const due = openNow.filter((p) => p.ci === 'success' && p.mergeable !== false && p.qa !== 'success' && p.reviewedSha !== p.headSha);
    if (!due.length || due.length !== openNow.filter((p) => p.qa !== 'success').length) return;
    if (this.reviewerProblem(fresh)) return;
    if (this.runner.current(cardId)) return; // a chat reply or the builder's last words: after it
    const runId = this.runner.wake(cardId, { agentId: fresh.reviewer!, kind: 'work', kickAlways: true, kick: reviewKick(fresh, due, again || due.some((p) => this.tries(cardId, p) > 0)) });
    if (!runId) return;
    for (const p of due) this.db.prepare('UPDATE card_prs SET reviewed_sha = ? WHERE card_id = ? AND repo = ? AND number = ?').run(p.headSha, cardId, p.repo, p.number);
    this.kanban.event(cardId, 'review_started', { by: fresh.reviewer, runId, prs: due.map((p) => ({ number: p.number, sha: p.headSha })) });
    this.kanban.emit(cardId);
  }

  /** The reviewer runs started on this PR's current head (review_started events). */
  private tries(cardId: string, p: CardPr): number {
    return this.reviewEvents(cardId).filter((e) => e.prs.some((x) => x.number === p.number && x.sha === p.headSha)).length;
  }

  private reviewEvents(cardId: string): { at: string; by: string; runId?: string; prs: { number: number; sha: string }[] }[] {
    return (this.db.prepare("SELECT at, payload FROM card_events WHERE card_id = ? AND kind = 'review_started' ORDER BY id DESC").all(cardId) as { at: string; payload: string }[]).map(
      (r) => ({ at: r.at, ...(JSON.parse(r.payload) as { by: string; runId?: string; prs: { number: number; sha: string }[] }) }),
    );
  }

  /**
   * The latest review run ended (done or failed) and none of the PRs it was started on has a verdict on that head yet
   * (still open, same head, no qa/validated success or failure): what it was, or null.
   */
  private stall(card: Card): { by: string; run: Run; prs: CardPr[]; tries: number } | null {
    const last = this.reviewEvents(card.id)[0];
    if (!last || this.runner.current(card.id)) return null;
    const runs = this.runner.runs(card.id);
    // Events from before #221 have no run id: the reviewer's newest run started before the event.
    const run = last.runId ? runs.find((r) => r.id === last.runId) : runs.find((r) => r.agentId === last.by && r.startedAt <= last.at);
    if (!run || (run.status !== 'done' && run.status !== 'failed')) return null;
    const prs = last.prs.map((x) => card.prs.find((p) => p.number === x.number && p.headSha === x.sha && p.reviewedSha === x.sha));
    if (!prs.length || prs.some((p) => !p || p.state !== 'open' || p.qa === 'success' || p.qa === 'failure' || p.ci !== 'success')) return null;
    const ok = prs as CardPr[];
    return { by: last.by, run, prs: ok, tries: Math.max(...ok.map((p) => this.tries(card.id, p))) };
  }

  /** A review that keeps ending without a verdict: one Inbox item per stalled review (the card says why, Retry restarts it). */
  private stalled(card: Card, s: NonNullable<ReturnType<Prs['stall']>>): void {
    const seen = this.db.prepare("SELECT payload FROM card_events WHERE card_id = ? AND kind = 'review_stalled'").all(card.id) as { payload: string }[];
    if (seen.some((r) => (JSON.parse(r.payload) as { runId?: string }).runId === s.run.id)) return;
    const n = this.db.transaction(() => {
      this.kanban.event(card.id, 'review_stalled', { by: 'github', reviewer: s.by, runId: s.run.id, tries: s.tries, prs: s.prs.map((p) => ({ number: p.number, sha: p.headSha })) });
      return insertNotification(
        this.db,
        {
          kind: 'review.stalled',
          title: `Review by @${s.by} ended without a verdict`,
          body: `${s.prs.map((p) => `PR #${p.number} (${short(p.headSha)})`).join(', ')} of “${card.title}”: ${s.tries} review run${s.tries > 1 ? 's' : ''} ended without validating or failing it${s.run.status === 'failed' ? ` (the last one failed: ${s.run.error ?? 'the run failed'})` : ''}. The task waits In review: Retry starts the review again.`,
          cardId: card.id,
        },
        new Date(this.now()),
      );
    })();
    this.bus.emit({ type: 'notification.created', notification: n });
    this.kanban.emit(card.id);
  }

  private failedSha(cardId: string, p: CardPr): string | null {
    return (this.db.prepare('SELECT failed_sha FROM card_prs WHERE card_id = ? AND repo = ? AND number = ?').get(cardId, p.repo, p.number) as { failed_sha: string | null }).failed_sha;
  }

  /** Back to Ready for the builder, the reason as a note in the task (once per head). */
  private sendBack(card: Card, pr: CardPr | null, reason: string): void {
    this.db.transaction(() => {
      if (pr) this.db.prepare('UPDATE card_prs SET failed_sha = ? WHERE card_id = ? AND repo = ? AND number = ?').run(pr.headSha, card.id, pr.repo, pr.number);
      this.kanban.appendMessage(card.id, 'user', 'system', [{ type: 'text', text: `${reason}. Back to Ready for @${card.assignee ?? 'nobody'}: fix it, push, then task_request_review again.` }]);
      this.kanban.event(card.id, 'review_failed', { by: 'github', reason });
    })();
    this.kanban.update(card.id, { status: 'ready' }, 'github');
  }

  /** Why the reviewer can't start now, or null. */
  private reviewerProblem(card: Card): string | null {
    if (!card.reviewer) return 'no reviewer: set the review agent in Settings → Board & triage';
    const agent = this.agents.list().find((a) => a.id === card.reviewer);
    if (!agent) return `reviewer @${card.reviewer} does not exist`;
    if (!agent.enabled) return `reviewer @${agent.id} is disabled`;
    // The review runs in the reviewer's workspace for the task's project (#216): a non-member has none.
    if (!isMember(this.db, card.projectId, agent.id)) return `review agent @${agent.id} is not a member of project ${projectRow(this.db, card.projectId).name}: add it in Settings → Projects`;
    const busy = this.runner.workRuns(agent.id).filter((r) => r.cardId !== card.id);
    if (busy.length >= agent.maxRuns) return `waiting for @${agent.id} (busy with ${busy.map((r) => this.kanban.ref(r.cardId)).join(', ')})`;
    return null;
  }

  /** The plain-words « why isn't this moving » of a task In review. */
  reason(card: Card): string | null {
    if (!card.prs.length) return 'in review: no pull request linked';
    const bad = card.prs.find((p) => p.error);
    if (bad) return `can't read PR #${bad.number} from GitHub since ${hhmm(bad.errorSince!)}: ${bad.error}`;
    const open = card.prs.filter((p) => p.state === 'open');
    if (card.prs.some((p) => !p.checkedAt)) return 'reading the pull request from GitHub…';
    if (!open.length) return 'pull request closed: moving…';
    // The merge queue (#236): its position, and how long the head has been there.
    const q = this.queue(card.projectId);
    const pos = q.indexOf(card.id);
    if (pos > 0) return `${ordinal(pos + 1)} in the queue, behind ${refs(q.slice(0, pos).map((id) => this.kanban.ref(id)))}`;
    const since = (this.db.prepare('SELECT review_head_at AS at FROM cards WHERE id = ?').get(card.id) as { at: string | null } | undefined)?.at;
    const why = this.headReason(card, open);
    return pos === 0 && since ? `1st in the queue for ${ago(this.now() - Date.parse(since))} · ${why}` : why;
  }

  private headReason(card: Card, open: CardPr[]): string {
    const rows = open.map((p) => ({ p, r: this.row(card.id, p) }));
    const failing = rows.find((x) => x.r.sync_error);
    if (failing) return `can't bring PR #${failing.p.number} up to date with ${failing.p.base ?? 'main'}: ${failing.r.sync_error} (tried again every minute)`;
    const behind = rows.filter((x) => x.r.synced_sha !== x.p.headSha);
    if (behind.length) return `bringing ${behind.map((x) => `PR #${x.p.number}`).join(', ')} up to date with ${behind[0]!.p.base ?? 'main'}…`;
    const cur = this.runner.current(card.id);
    if (cur && cur.agentId === card.reviewer) return `@${card.reviewer} is checking ${open.map((p) => short(p.headSha)).join(', ')}`;
    if (open.some((p) => p.ci === 'pending' || p.ci === null)) return 'QA starts when CI is green';
    if (open.some((p) => p.mergeable === null)) return 'GitHub is checking for conflicts…';
    if (open.every((p) => p.qa === 'success')) return 'validated: waiting for the merge';
    const stall = this.stall(card);
    if (stall && stall.tries >= REVIEW_TRIES)
      return `review by @${stall.by} ended without a verdict on ${stall.prs.map((p) => short(p.headSha)).join(', ')} (${stall.tries} runs${stall.run.status === 'failed' ? `, the last failed: ${stall.run.error ?? 'the run failed'}` : ''}): Retry starts it again`;
    if (open.some((p) => p.reviewedSha === p.headSha)) {
      const last = this.runner.runs(card.id).find((r) => r.agentId === card.reviewer);
      if (last?.status === 'failed') return `@${card.reviewer}'s check failed: ${last.error ?? 'the run failed'}. Retry starts it again.`;
      return `@${card.reviewer} checked it: waiting for the validation on GitHub`;
    }
    return this.reviewerProblem(card) ?? `waiting for @${card.reviewer}`;
  }

  /** Retry on a task In review: the reviewer checks the current head again. */
  recheck(cardId: string): void {
    this.db.prepare('UPDATE card_prs SET reviewed_sha = NULL WHERE card_id = ?').run(cardId);
    this.kanban.emit(cardId);
    void this.poll();
  }

  private cardOrNull(id: string): Card | null {
    return this.db.prepare('SELECT 1 FROM cards WHERE id = ?').get(id) ? this.kanban.get(id) : null;
  }
}

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
/** #214, #215 and #216; past three: « #214, #215, #216 and 2 more ». */
const refs = (r: string[]) => (r.length > 3 ? `${r.slice(0, 3).join(', ')} and ${r.length - 3} more` : r.length > 1 ? `${r.slice(0, -1).join(', ')} and ${r.at(-1)}` : (r[0] ?? ''));
/** 0 min, 25 min, 2 h, 2 h 5 min, 3 d 4 h. */
function ago(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`;
}

/** The real reader: `gh api` with the user's own gh login (env: the login shell's PATH, so Homebrew's gh is found). */
export function ghReader(env: () => Promise<NodeJS.ProcessEnv>, gh = 'gh'): GhRead {
  const api = async (path: string): Promise<unknown> => {
    const e = await env();
    return new Promise((resolve, reject) => {
      execFile(gh, ['api', path], { env: e, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return reject(new Error('gh not found on PATH (install the GitHub CLI and run gh auth login)'));
          const msg = String(stderr).trim().split('\n').find((l) => l.trim()) ?? err.message;
          return reject(new Error(`gh: ${msg}`));
        }
        try {
          resolve(JSON.parse(String(stdout)));
        } catch (pe) {
          reject(new Error(`gh api ${path}: not JSON (${pe instanceof Error ? pe.message : String(pe)})`));
        }
      });
    });
  };
  return async (repo, number) => {
    const pr = (await api(`repos/${repo}/pulls/${number}`)) as {
      state: string;
      merged: boolean;
      merge_commit_sha: string | null;
      mergeable: boolean | null;
      head: { sha: string; ref: string };
      base: { ref: string };
    };
    const state = pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed';
    let ci: CardPr['ci'] = null;
    let qa: CardPr['qa'] = null;
    let qaDescription: string | null = null;
    let ciFailed: CardPr['ciFailed'] = null;
    if (state === 'open') {
      const runs = (await api(`repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`)) as { check_runs: CheckRun[] };
      ci = combineChecks(runs.check_runs);
      ciFailed = failedCheck(runs.check_runs);
      const st = (await api(`repos/${repo}/commits/${pr.head.sha}/status`)) as { statuses: { context: string; state: string; description: string | null }[] };
      const v = st.statuses.find((s) => s.context === 'qa/validated'); // newest first
      if (v) {
        qa = v.state === 'success' ? 'success' : v.state === 'pending' ? 'pending' : 'failure';
        qaDescription = v.description;
      }
    }
    return { state, mergeSha: pr.merged ? pr.merge_commit_sha : null, headSha: pr.head.sha, branch: pr.head.ref, base: pr.base.ref, mergeable: pr.mergeable, ci, ciFailed, qa, qaDescription };
  };
}

interface CheckRun {
  name?: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
}
const RED = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];
const isRed = (r: CheckRun) => r.status === 'completed' && RED.includes(r.conclusion ?? '');

/** The head's check runs as one state: any failure → failure, any not finished → pending, else success (none: null). */
export function combineChecks(runs: CheckRun[]): CardPr['ci'] {
  if (!runs.length) return null;
  if (runs.some(isRed)) return 'failure';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  return 'success';
}

/** The first red check run, named and linked (#238): what the builder opens to see which rule of the repo failed. */
export function failedCheck(runs: CheckRun[]): CardPr['ciFailed'] {
  const r = runs.find(isRed);
  return r ? { name: r.name || 'a check', url: r.html_url || r.details_url || null } : null;
}
