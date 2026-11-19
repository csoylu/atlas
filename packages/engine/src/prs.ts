import { execFile } from 'node:child_process';
import type { Card, CardPr } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import type { Kanban } from './kanban.ts';
import { InvalidError } from './kanban.ts';
import type { Runner } from './runner.ts';
import { insertNotification } from './notifications.ts';
import { openReviewRun } from './reviewFlow.ts';
import { recordPrEvent, type PrSnapshot } from './workflowEvents.ts';

/**
 * Tasks linked to their pull requests (#189, design §7.1). A task In review has open PRs; this module reads them from
 * GitHub (`gh api`, the user's own login: no token in SQLite), stores what it read and records the PR events workflows
 * start and wait on (#258). The review itself is the project's Review workflow (#263, reviewFlow.ts): CI, the review
 * agent, validate + merge, back to the builder. What stays here is generic, outside any run:
 * - every PR merged → done; also from blocked (#231: merged outside the flow while the task waited on the user);
 * - every PR closed unmerged → ready, the reason as a note;
 * both only when no Review run is open on the task, so the two never act on one task.
 * GitHub unreadable: nothing moves on old data; the card says why, and after 15 min one Inbox item says so.
 * Everything lives in card_prs: a restart resumes from the table.
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

/** https://github.com/owner/name/pull/12 (any suffix) → its repo and number. */
export function parsePrUrl(url: string): { repo: string; number: number; url: string } {
  const m = url.trim().match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  if (!m) throw new InvalidError(`not a GitHub pull request url: ${url} (expected https://github.com/owner/repo/pull/N)`);
  return { repo: m[1]!, number: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` };
}

/**
 * The PR events between two reads (#258): a new head (pushed), CI done (ci_finished, with its result), a new conflict,
 * a qa/validated verdict (validated), merged, closed. The first read has no « before »: what it finds already done counts.
 */
export function prEvents(before: CardPr, got: GhPr): { name: string; result?: string }[] {
  const out: { name: string; result?: string }[] = [];
  const newHead = !!before.headSha && before.headSha !== got.headSha;
  if (newHead) out.push({ name: 'pushed' });
  const final = (x: string | null) => x === 'success' || x === 'failure';
  if (final(got.ci) && (newHead || before.ci !== got.ci)) out.push({ name: 'ci_finished', result: got.ci! });
  if (got.mergeable === false && (newHead || before.mergeable !== false)) out.push({ name: 'conflict' });
  if (final(got.qa) && (newHead || before.qa !== got.qa)) out.push({ name: 'validated', result: got.qa! });
  if (got.state !== before.state && got.state !== 'open') out.push({ name: got.state });
  return out;
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

export interface PrsOptions {
  read: GhRead;
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
      // A Review run ended (#263): a PR merged or closed meanwhile is GitHub's to settle now.
      if (e.type === 'workflow.run' && e.run.state !== 'running' && e.run.state !== 'waiting' && e.run.subject) {
        const id = e.run.subject.cardId;
        if (!this.polling)
          try {
            this.decide(id);
          } catch (err) {
            console.error(`pull requests of ${id}: deciding failed`, err);
          }
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
      // What changed since the last read, as PR events for workflows (#258), in this same transaction.
      const snap: PrSnapshot = { url: pr.url, repo: pr.repo, number: pr.number, branch: got.branch, base: got.base, head: got.headSha, state: got.state, ci: got.ci };
      for (const e of prEvents(pr, got)) recordPrEvent(this.db, cardId, e.name, snap, { result: e.result ?? null });
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
   * The one GitHub fact Atlas acts on outside the Review workflow (#263): every PR merged → Done, every PR closed
   * unmerged → Ready with the reason. Only when no Review run is open on the task (the run acts on its own PR: never
   * both). A blocked task (#231) only moves when its PRs are merged. Nothing moves while a PR can't be read.
   */
  decide(cardId: string): void {
    const card = this.kanban.get(cardId);
    if ((card.status !== 'review' && card.status !== 'blocked') || !card.prs.length) return;
    const prs = card.prs;
    if (prs.some((p) => p.error || !p.checkedAt)) return;
    if (prs.some((p) => p.state === 'open')) return; // the Review workflow's
    if (openReviewRun(this.db, cardId)) return; // it stops itself once the PR is merged or closed, then this moves the task
    const merged = prs.filter((p) => p.state === 'merged');
    if (card.status === 'blocked' && (!merged.length || this.runner.current(cardId))) return;
    if (merged.length) {
      const text = merged.map((p) => `PR #${p.number} merged into ${p.base ?? 'its base'} (${short(p.mergeSha)})`).join(', ');
      this.kanban.update(cardId, { status: 'done' }, 'github', text);
      this.kanban.event(cardId, 'completed', { by: 'github', summary: text });
    } else this.sendBack(card, prs.map((p) => `PR #${p.number} was closed without merging`).join(', '));
  }

  /** Back to Ready for the builder, the reason as a note in the task. */
  private sendBack(card: Card, reason: string): void {
    this.db.transaction(() => {
      this.kanban.appendMessage(card.id, 'user', 'system', [{ type: 'text', text: `${reason}. Back to Ready for @${card.assignee ?? 'nobody'}: fix it, push, then task_request_review again.` }]);
      this.kanban.event(card.id, 'review_failed', { by: 'github', reason });
    })();
    this.kanban.update(card.id, { status: 'ready' }, 'github');
  }

  /**
   * The plain-words « why isn't this moving » of a task In review: GitHub's side here, then where its Review run is
   * (reviewNow, set by the engine from the workflow), or the « No Review workflow is on » state.
   */
  reason(card: Card): string | null {
    if (!card.prs.length) return 'in review: no pull request linked';
    const bad = card.prs.find((p) => p.error);
    if (bad) return `can't read PR #${bad.number} from GitHub since ${hhmm(bad.errorSince!)}: ${bad.error}`;
    if (card.prs.some((p) => !p.checkedAt)) return 'reading the pull request from GitHub…';
    if (!card.prs.some((p) => p.state === 'open')) return 'pull request closed: moving…';
    if (card.reviewOff) return `No Review workflow is on in ${card.reviewOff.projectName}: Turn it on, or Validate by hand`;
    return this.reviewNow(card.id) ?? 'no Review run is going on it: Retry starts one';
  }

  /** Set by the engine: where the task's open Review run is, in words, or null. */
  reviewNow: (cardId: string) => string | null = () => null;

  private cardOrNull(id: string): Card | null {
    return this.db.prepare('SELECT 1 FROM cards WHERE id = ?').get(id) ? this.kanban.get(id) : null;
  }
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
