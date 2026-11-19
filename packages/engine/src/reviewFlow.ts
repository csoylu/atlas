import type { Card, Notification, Workflow, WorkflowEdge, WorkflowNodeInput } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { ConflictError, InvalidError, type Kanban } from './kanban.ts';
import type { Workflows } from './workflows.ts';
import { insertNotification } from './notifications.ts';
import { projectRow } from './projects.ts';
import { validate, type Gh } from '../../../scripts/pr/validate.mjs';

/**
 * The default Review workflow (#263, design §9): how a task's pull request is checked and merged, one per project with
 * a GitHub repo (workflows.origin = 'review', shown « default »). It replaced the hardcoded review of prs.ts: what
 * stays there is generic (reading PRs from GitHub, merged → Done when no Review run is open).
 *
 *   1 A task asks for review → 2 CI finished on the PR (at most 2 h) → 3 CI green, no conflict? → 4 Review the PR (the
 *   project's review agent, in the task thread) → 5 Validate + merge → 6 Task → Done. Timed out, no, changes asked
 *   and refused all go to 7 Back to the builder (Ready, the reason as a note).
 */

export const REVIEW_NAME = 'Review';
/** The loop guard of the default Review (Master, #263): a builder fixing fast CI several times an hour stays under it. */
export const REVIEW_LOOP_GUARD = 10;
/** Step 2's time limit, in minutes. */
export const REVIEW_CI_LIMIT_MIN = 120;

/** The review step's prompt ({{fields}} filled when the step starts). The agent gives a verdict; step 5 merges. */
export const REVIEW_PROMPT =
  'You review the pull request of this task: {{pr.url}} (branch {{pr.branch}}, head {{pr.head}}). CI is green. ' +
  '@{{task.assignee}} built it: the earlier messages marked @{{task.assignee}} are theirs, not yours. ' +
  "Check it the way the project says (its CLAUDE.md), then give your verdict with pr_validate: ok with the head sha you checked and merge: false " +
  "(the workflow's next step merges it), or fail with the reason for the builder. A review ends with one of the two on the head.";

/** The note step 7 leaves in the task: the step that sent it back, and why (whichever of the four exits it was). */
export const BACK_NOTE = '{{last.title}}: {{last.exit}} ({{last.summary}}). Back to Ready for @{{task.assignee}}: fix it, push, then task_request_review again.';

/** Positions (Master's approved layout, design v47): three columns, « Back to the builder » alone on the bottom row. */
const COLX = [40, 272, 504];
const ROWS = [24, 232, 440];
const at = (c: number, r: number) => ({ x: COLX[c]!, y: ROWS[r]! });

/** The seven steps and their links, as a fresh project gets them and « Reset to default » restores them. */
export function reviewGraph(): { nodes: WorkflowNodeInput[]; edges: WorkflowEdge[] } {
  const nodes: WorkflowNodeInput[] = [
    { id: 'trigger', kind: 'trigger', ...at(0, 0), config: { kind: 'task', event: 'review_requested', maxRunsPerHour: REVIEW_LOOP_GUARD } },
    { id: 'ci', kind: 'wait', ...at(1, 0), config: { title: 'CI finished on the PR', for: 'ciFinished', limitMin: REVIEW_CI_LIMIT_MIN } },
    {
      id: 'checks',
      kind: 'condition',
      ...at(2, 0),
      config: {
        test: 'fields',
        title: 'CI green, no conflict?',
        match: 'all',
        // « is not failure »: a project with no CI job and a PR with no check goes on (#263, atlas 1); a real conflict
        // is « yes », GitHub's « not computed yet » is empty and the merge gate refuses a conflict anyway.
        tests: [
          { field: 'pr.ci', op: 'isNot', value: 'failure' },
          { field: 'pr.conflict', op: 'isNot', value: 'yes' },
        ],
      },
    },
    { id: 'review', kind: 'agent', ...at(0, 1), config: { title: 'Review the PR', agentId: null, prompt: REVIEW_PROMPT, newTaskEachRun: false, inThread: true, reviewAgent: true } },
    { id: 'merge', kind: 'action', ...at(1, 1), config: { do: 'mergePr', title: 'Validate + merge the PR' } },
    { id: 'done', kind: 'action', ...at(2, 1), config: { do: 'setStatus', title: 'Task → Done', status: 'done', note: '' } },
    { id: 'back', kind: 'action', ...at(0, 2), config: { do: 'setStatus', title: 'Back to the builder', status: 'ready', note: BACK_NOTE } },
  ];
  const edges: WorkflowEdge[] = [
    { from: 'trigger', exit: 'start', to: 'ci' },
    { from: 'ci', exit: 'event', to: 'checks' },
    { from: 'ci', exit: 'timed out', to: 'back' },
    { from: 'checks', exit: 'yes', to: 'review' },
    { from: 'checks', exit: 'no', to: 'back' },
    { from: 'review', exit: 'approved', to: 'merge' },
    { from: 'review', exit: 'changes asked', to: 'back' },
    { from: 'merge', exit: 'merged', to: 'done' },
    { from: 'merge', exit: 'refused', to: 'back' },
  ];
  return { nodes, edges };
}

/** The project's Review workflow: its id and whether it is on, or null (never made, or deleted). */
export function reviewWorkflowOf(db: Db, projectId: string): { id: string; enabled: boolean } | null {
  const r = db.prepare("SELECT id, enabled FROM workflows WHERE project_id = ? AND origin = 'review' ORDER BY created_at LIMIT 1").get(projectId) as
    | { id: string; enabled: number }
    | undefined;
  return r ? { id: r.id, enabled: !!r.enabled } : null;
}

/** The task's open run of its project's Review workflow, if any. */
export function openReviewRun(db: Db, cardId: string): string | null {
  const r = db
    .prepare(
      `SELECT r.id FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
        WHERE w.origin = 'review' AND r.subject_card = ? AND r.state IN ('running', 'waiting') ORDER BY r.started_at DESC LIMIT 1`,
    )
    .get(cardId) as { id: string } | undefined;
  return r?.id ?? null;
}

/**
 * A task In review that nothing reviews (#263, item 5): its project has a repo and no Review workflow on, and no Review
 * run is open on it. The task says so, with Turn it on and Validate by hand; never a silent wait.
 */
export function reviewOffOf(db: Db, card: Pick<Card, 'id' | 'status' | 'board' | 'projectId'>): Card['reviewOff'] {
  if (card.board !== 'main' || card.status !== 'review') return null;
  const p = db.prepare('SELECT name, repo FROM projects WHERE id = ?').get(card.projectId) as { name: string; repo: string | null } | undefined;
  if (!p?.repo) return null;
  const w = reviewWorkflowOf(db, card.projectId);
  if (w?.enabled || openReviewRun(db, card.id)) return null;
  return { projectId: card.projectId, projectName: p.name, workflowId: w?.id ?? null };
}

/** How a Review run started on a task that was already In review says so on its trigger step. */
export const AT_UPDATE = 'started at the update (the task was already In review)';
export const TURNED_ON = 'started when the Review workflow was turned on (the task was waiting In review)';

export interface ReviewFlowOptions {
  /** The GitHub client « Validate by hand » uses (the user's gh login), the same as a merge step's. */
  gh?: () => Gh | Promise<Gh>;
  now?: () => Date;
}

/**
 * The default Review workflow's life around the generic workflow engine (#263): seeded once per project with a repo,
 * a run for each task already In review at the update, « Turn it on », « Reset to default », and the « No Review
 * workflow is on » state with its one Inbox item per task and « Validate by hand ».
 */
export class ReviewFlow {
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private pending = false;
  private readonly now: () => Date;
  /** Set by the engine: read the task's PRs from GitHub now (after a merge by hand). */
  poll: () => void = () => {};

  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private workflows: Workflows,
    private opts: ReviewFlowOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  start(intervalMs = 60_000): void {
    this.stop();
    this.seed();
    this.check();
    this.unsubscribe = this.bus.on((e) => {
      if (e.type === 'project.updated' || e.type === 'workflow.updated' || e.type === 'workflow.deleted' || (e.type === 'card.updated' && (e.card.status === 'review' || e.card.reviewOff === null)))
        this.soon(e.type === 'project.updated');
    });
    this.timer = setInterval(() => this.check(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private soon(seed: boolean): void {
    if (seed) this.seedLater = true;
    if (this.pending) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      if (!this.unsubscribe) return;
      try {
        if (this.seedLater) this.seed();
        this.seedLater = false;
        this.check();
      } catch (e) {
        console.error('review workflow check failed', e);
      }
    });
  }
  private seedLater = false;

  /**
   * Every active project with a repo that never had its Review workflow gets it, on, in one transaction with a run for
   * each of its tasks already In review (the switch-over). Once per project: one Master deletes is not made again.
   */
  seed(): string[] {
    const todo = this.db.prepare("SELECT id FROM projects WHERE status = 'active' AND repo IS NOT NULL AND repo != '' AND review_seeded = 0 ORDER BY created_at").all() as { id: string }[];
    const made: string[] = [];
    for (const { id } of todo) {
      this.db.transaction(() => {
        const wf = reviewWorkflowOf(this.db, id)?.id ?? this.workflows.createReview(id);
        this.db.prepare('UPDATE projects SET review_seeded = 1 WHERE id = ?').run(id);
        for (const c of this.waiting(id)) this.workflows.startReview(wf, c, AT_UPDATE);
        made.push(wf);
      })();
    }
    return made;
  }

  /** Tasks In review of the project, with a PR, that no Review run is on. */
  private waiting(projectId: string): string[] {
    const rows = this.db
      .prepare("SELECT id FROM cards WHERE project_id = ? AND board = 'main' AND status = 'review' AND EXISTS (SELECT 1 FROM card_prs p WHERE p.card_id = cards.id) ORDER BY created_at")
      .all(projectId) as { id: string }[];
    return rows.map((r) => r.id).filter((id) => !openReviewRun(this.db, id));
  }

  /**
   * The « No Review workflow is on » state (item 5): one Inbox item per task that enters it, archived when it leaves;
   * a task that leaves it because its project's Review is on again gets its run.
   */
  check(): void {
    const items = this.db
      .prepare("SELECT id, card_id FROM notifications WHERE kind = 'review.off' AND archived_at IS NULL AND card_id IS NOT NULL")
      .all() as { id: number; card_id: string }[];
    const open = new Map(items.map((i) => [i.card_id, i.id]));
    const cards = this.db.prepare("SELECT id FROM cards WHERE board = 'main' AND status = 'review'").all() as { id: string }[];
    const created: Notification[] = [];
    const iso = this.now().toISOString();
    let changed = false;
    for (const { id } of cards) {
      const card = this.kanban.get(id);
      const item = open.get(id);
      open.delete(id);
      if (card.reviewOff && item === undefined) {
        const off = card.reviewOff;
        created.push(
          insertNotification(
            this.db,
            {
              kind: 'review.off',
              title: `No Review workflow is on in ${off.projectName}`,
              body: `“${card.title}” waits In review and nothing reviews it. Turn it on (${off.workflowId ? 'Workflows → Review' : 'it was deleted: Turn it on makes it again'}), or Validate by hand.`,
              cardId: id,
            },
            this.now(),
          ),
        );
        this.kanban.emit(id);
      } else if (!card.reviewOff && item !== undefined) {
        // Review is on again: this task gets its run (the task left the state, its item leaves the Inbox).
        const w = reviewWorkflowOf(this.db, card.projectId);
        if (w?.enabled && !openReviewRun(this.db, id)) {
          try {
            this.workflows.startReview(w.id, id, TURNED_ON);
          } catch (e) {
            console.error(`review run on ${id} failed to start`, e);
          }
        }
        this.archive(item, iso);
        changed = true;
      }
    }
    for (const item of open.values()) {
      this.archive(item, iso); // the task left In review
      changed = true;
    }
    for (const n of created) this.bus.emit({ type: 'notification.created', notification: n });
    if (changed) this.bus.emit({ type: 'inbox.changed' });
  }

  private archive(id: number, iso: string): void {
    this.db.prepare('UPDATE notifications SET archived_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ?').run(iso, iso, id);
  }

  /** « Turn it on » (item 5): the project's Review workflow on again, or made again from the default if deleted. */
  turnOn(projectId: string): Workflow {
    const p = projectRow(this.db, projectId);
    if (!p.repo) throw new InvalidError(`project ${p.name} has no GitHub repo: a Review workflow reviews a repo's pull requests (Settings → Projects)`);
    const w = reviewWorkflowOf(this.db, projectId);
    const id = w ? w.id : this.workflows.createReview(projectId);
    if (w && !w.enabled) this.workflows.update(id, { enabled: true });
    this.check();
    return this.workflows.get(id);
  }

  /**
   * Retry on a task In review (#221, #237): its Review run's step that couldn't run is tried now; with no run on it, a
   * new one starts. In the « No Review workflow is on » state: Turn it on first.
   */
  retry(cardId: string): void {
    const card = this.kanban.get(cardId);
    const run = openReviewRun(this.db, cardId);
    if (run) {
      if (this.workflows.run(run).steps?.some((s) => s.couldntRun && !s.endedAt)) this.workflows.retryNow(run);
      return;
    }
    const w = reviewWorkflowOf(this.db, card.projectId);
    if (!w?.enabled) throw new ConflictError(`No Review workflow is on in ${projectRow(this.db, card.projectId).name}: Turn it on, or Validate by hand`);
    this.workflows.startReview(w.id, cardId, 'started again by you (Retry)');
  }

  /**
   * « Validate by hand » (item 5, Master only: the HTTP route calls it, no agent tool does): the gate of Master's
   * terminal command (scripts/pr/validate.mjs --as master --merge) on the task's PR at the head Atlas last read.
   */
  async validateByHand(cardId: string, sha: string): Promise<string[]> {
    const card = this.kanban.get(cardId);
    if (card.status !== 'review') throw new InvalidError(`${this.kanban.ref(cardId)} is not In review (${card.status})`);
    const pr = card.prs.find((p) => p.state === 'open');
    if (!pr) throw new InvalidError(`${this.kanban.ref(cardId)} has no open pull request`);
    if (!pr.headSha || pr.headSha !== sha)
      throw new ConflictError(`PR #${pr.number}'s head is ${pr.headSha?.slice(0, 7) ?? 'not read yet'}, not ${sha.slice(0, 7)}: reload the task and check it again`);
    if (!this.opts.gh) throw new InvalidError('this engine has no GitHub client');
    const project = projectRow(this.db, card.projectId);
    const gh = await this.opts.gh();
    const out = await validate({ pr: pr.number, verdict: 'success', sha, as: 'master', reason: 'validated by hand in Atlas', merge: true, base: null, repo: pr.repo, ciJob: project.ci_job }, gh);
    this.kanban.event(cardId, 'pr_verdict', { by: 'user', verdict: 'ok', pr: pr.number, sha, reason: 'validated by hand' });
    this.poll();
    return out;
  }
}
