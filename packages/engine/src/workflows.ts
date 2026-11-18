import { randomUUID } from 'node:crypto';
import {
  cardRef,
  CreateWorkflow,
  SaveWorkflowGraph,
  UpdateWorkflow,
  WORKFLOW_EXITS,
  WORKFLOW_FAILING_EXITS,
  type Card,
  type ScheduleKind,
  type TriggerConfig,
  type Workflow,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowRun,
  type WorkflowRunState,
  type WorkflowRunStep,
  type WorkflowStepState,
} from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { ConflictError, InvalidError, NotFoundError, type Kanban } from './kanban.ts';
import { APPROVE, REJECT, cut, describeTrigger, firstLine, localTimeZone, stamp, stepTitle, triggerWhen, upcoming } from './workflowTime.ts';

export { describeTrigger, describeWhen, localTimeZone, oneStep, upcoming } from './workflowTime.ts';

/** A firing this much after its due time (engine was off) says so in the prompt. */
const LATE_MS = 2 * 60_000;
/** Steps one run may take: a loop without a guard stops here, Failed. */
export const MAX_STEPS = 200;
const OPEN_RUN = "state IN ('running', 'waiting')";

interface WfRow {
  id: string;
  name: string;
  enabled: number;
  origin: string | null;
  revision: number;
  next_run_at: string | null;
  last_fired_at: string | null;
  last_error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface NodeRow {
  workflow_id: string;
  id: string;
  kind: WorkflowNodeKind;
  x: number;
  y: number;
  config: string;
  own_card_id: string | null;
}
interface RunRow {
  id: string;
  workflow_id: string;
  number: number;
  state: WorkflowRunState;
  trigger: 'time' | 'manual';
  reason: string | null;
  started_at: string;
  ended_at: string | null;
}
interface StepRow {
  id: number;
  run_id: string;
  node_id: string;
  kind: WorkflowNodeKind;
  round: number;
  state: WorkflowStepState;
  exit: string | null;
  card_id: string | null;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
}

const toNode = (r: NodeRow): WorkflowNode => ({ id: r.id, kind: r.kind, x: r.x, y: r.y, config: JSON.parse(r.config) }) as WorkflowNode;
const toRun = (r: RunRow): WorkflowRun => ({
  id: r.id,
  workflowId: r.workflow_id,
  number: r.number,
  state: r.state,
  trigger: r.trigger,
  reason: r.reason,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});
const toStep = (r: StepRow): WorkflowRunStep => ({
  id: r.id,
  nodeId: r.node_id,
  kind: r.kind,
  round: r.round,
  state: r.state,
  exit: r.exit,
  cardId: r.card_id,
  summary: r.summary,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A one-step workflow, as schedules and the schedule_* tools describe it. */
export interface OneStep {
  agentId: string;
  title?: string;
  prompt: string;
  kind: ScheduleKind;
  cron?: string | null;
  at?: string | null;
  timezone?: string;
  createCard?: boolean;
  enabled?: boolean;
}

/**
 * Workflows (#170, design §9). A trigger (time or manual) starts a run; the run walks the graph one step at a time: an
 * agent step is a task, an approval a task blocked on the user, a condition picks yes/no at once. Every move is one
 * transaction on the run's stored step, and each open run is reconciled with its task's state at every tick (and after
 * any card change), so a restart at any instant carries on from the stored step (rule 2).
 */
export class Workflows {
  private timer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private ticking = false;
  private again = false;
  private pending = false;
  /** Runs and workflows touched in the current transaction: announced once it has committed. */
  private touched = { runs: new Set<string>(), workflows: new Set<string>() };

  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private now: () => Date = () => new Date(),
  ) {}

  start(intervalMs = 15_000): void {
    this.stop();
    this.unsubscribe = this.bus.on((e) => {
      if (e.type === 'card.updated' || e.type === 'card.deleted' || e.type === 'message.appended') this.soon();
    });
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Coalesce a burst of card events into one tick. */
  private soon(): void {
    if (this.pending) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      if (this.unsubscribe) this.tick();
    });
  }

  /* ── Reading ── */

  list(): Workflow[] {
    const rows = this.db.prepare('SELECT * FROM workflows ORDER BY enabled DESC, next_run_at IS NULL, next_run_at, created_at').all() as WfRow[];
    return rows.map((r) => this.toWorkflow(r));
  }

  get(id: string): Workflow {
    return this.toWorkflow(this.row(id));
  }

  runs(workflowId: string, limit = 50): WorkflowRun[] {
    this.row(workflowId);
    return (this.db.prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY number DESC LIMIT ?').all(workflowId, limit) as RunRow[]).map(toRun);
  }

  run(runId: string): WorkflowRun {
    return { ...toRun(this.runRow(runId)), steps: this.steps(runId).map(toStep) };
  }

  /** The workflow a card belongs to (a step's task, or an agent step's own task), for notifications. */
  workflowOfCard(cardId: string): { id: string; name: string } | null {
    const r = this.db
      .prepare(
        `SELECT w.id, w.name FROM workflow_run_steps s JOIN workflow_runs r ON r.id = s.run_id JOIN workflows w ON w.id = r.workflow_id WHERE s.card_id = ?
         UNION ALL SELECT w.id, w.name FROM workflow_nodes n JOIN workflows w ON w.id = n.workflow_id WHERE n.own_card_id = ? LIMIT 1`,
      )
      .get(cardId, cardId) as { id: string; name: string } | undefined;
    return r ?? null;
  }

  /** An agent step's own task (« one task, keeps history »), once created. */
  ownTask(workflowId: string, nodeId: string): string | null {
    const r = this.db.prepare('SELECT own_card_id FROM workflow_nodes WHERE workflow_id = ? AND id = ?').get(workflowId, nodeId) as { own_card_id: string | null } | undefined;
    return r?.own_card_id ?? null;
  }

  /* ── Editing ── */

  /** `id`: a fixed one for a built-in workflow (the memory cleanup), else a random one. */
  create(input: CreateWorkflow, by: string, id = 'wf_' + randomUUID().slice(0, 8)): Workflow {
    const c = CreateWorkflow.parse(input);
    const now = this.now().toISOString();
    this.tx(() => {
      if (this.db.prepare('SELECT 1 FROM workflows WHERE id = ?').get(id)) throw new ConflictError(`workflow ${id} already exists`);
      const trigger = this.check(c);
      const next = c.enabled ? this.firstRun(trigger) : null;
      this.db
        .prepare('INSERT INTO workflows (id, name, enabled, origin, revision, next_run_at, created_by, created_at, updated_at) VALUES (?, ?, ?, NULL, 1, ?, ?, ?, ?)')
        .run(id, c.name, c.enabled ? 1 : 0, next, by, now, now);
      this.writeGraph(id, c);
      this.touched.workflows.add(id);
    });
    return this.get(id);
  }

  /** A « trigger → one agent step » workflow: what a schedule was. Used by the schedule_* tools and built-ins. */
  createOneStep(s: OneStep, by: string, id?: string): Workflow {
    const title = s.title?.trim() || firstLine(s.prompt);
    const trigger: TriggerConfig = { kind: 'time', repeat: s.kind, cron: s.kind === 'cron' ? (s.cron ?? null) : null, at: s.kind === 'at' ? (s.at ?? null) : null, timezone: s.timezone ?? localTimeZone() };
    return this.create(
      {
        name: title,
        enabled: s.enabled ?? true,
        nodes: [
          { id: 'trigger', kind: 'trigger', x: 40, y: 120, config: trigger },
          { id: 'step1', kind: 'agent', x: 300, y: 120, config: { title, agentId: s.agentId, prompt: s.prompt, newTaskEachRun: s.createCard ?? false } },
        ],
        edges: [{ from: 'trigger', exit: 'start', to: 'step1' }],
      },
      by,
      id,
    );
  }

  /** Replace the graph. Refused if `revision` is not the stored one (saved since by someone else) or the graph is invalid. */
  saveGraph(id: string, input: SaveWorkflowGraph): Workflow {
    const g = SaveWorkflowGraph.parse(input);
    this.tx(() => {
      const w = this.row(id);
      if (g.revision !== w.revision) throw new ConflictError(`workflow "${w.name}" was saved since you opened it (revision ${w.revision}, yours ${g.revision}): reload it`);
      const trigger = this.check(g);
      const before = this.nodes(id).find((n) => n.kind === 'trigger');
      const timingChanged = !before || before.config !== JSON.stringify(trigger);
      const next = !w.enabled ? null : timingChanged ? this.firstRun(trigger) : w.next_run_at;
      this.writeGraph(id, g);
      this.db.prepare('UPDATE workflows SET revision = revision + 1, next_run_at = ?, updated_at = ? WHERE id = ?').run(next, this.now().toISOString(), id);
      this.touched.workflows.add(id);
    });
    return this.get(id);
  }

  /** Rename, or turn on/off (on: the next firing is computed from now; a one-shot in the past is refused). */
  update(id: string, patch: UpdateWorkflow): Workflow {
    const p = UpdateWorkflow.parse(patch);
    this.tx(() => {
      const w = this.row(id);
      const now = this.now().toISOString();
      if (p.name !== undefined) this.db.prepare('UPDATE workflows SET name = ?, updated_at = ? WHERE id = ?').run(p.name, now, id);
      if (p.enabled !== undefined && p.enabled !== !!w.enabled) {
        const next = p.enabled ? this.firstRun(this.trigger(id)) : null;
        this.db.prepare('UPDATE workflows SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?').run(p.enabled ? 1 : 0, next, now, id);
      }
      this.touched.workflows.add(id);
    });
    return this.get(id);
  }

  /** Delete the workflow and its runs. An open run is stopped first (its open tasks closed); the tasks stay. */
  remove(id: string, by = 'user'): void {
    this.tx(() => {
      this.row(id);
      for (const r of this.db.prepare(`SELECT id FROM workflow_runs WHERE workflow_id = ? AND ${OPEN_RUN}`).all(id) as { id: string }[]) this.stopIn(r.id, by);
      this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
      this.touched.workflows.delete(id);
      this.deleted.push(id);
    });
  }
  private deleted: string[] = [];

  /* ── Running ── */

  /** Run now, by hand: works even when the workflow is off. With a run still going, the new one is a skipped run. */
  runNow(id: string): WorkflowRun {
    let runId: string | null = null;
    this.tx(() => {
      runId = this.fire(this.row(id), 'manual');
    });
    return this.run(runId!);
  }

  /** Stop a run: its open tasks are closed, the run ends Stopped. */
  stopRun(runId: string, by = 'user'): WorkflowRun {
    this.tx(() => {
      const r = this.runRow(runId);
      if (r.state !== 'running' && r.state !== 'waiting') throw new ConflictError(`run ${r.number} already ended (${r.state})`);
      this.stopIn(runId, by);
    });
    return this.run(runId);
  }

  /** Fire due triggers, then move every open run on from its task's state. One failure is recorded where it happened. */
  tick(): void {
    if (this.ticking) {
      this.again = true; // a card event during our own writes: go round once more
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        this.fireDue();
        for (const r of this.db.prepare(`SELECT id FROM workflow_runs WHERE ${OPEN_RUN} ORDER BY started_at`).all() as { id: string }[]) {
          try {
            this.tx(() => this.reconcile(r.id));
          } catch (e) {
            console.error(`workflow run ${r.id} failed`, errText(e));
            this.tx(() => this.endRun(r.id, 'failed', errText(e)));
          }
        }
      } while (this.again);
    } finally {
      this.ticking = false;
    }
  }

  private fireDue(): void {
    const now = this.now().toISOString();
    for (const w of this.db.prepare('SELECT * FROM workflows WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at').all(now) as WfRow[]) {
      try {
        this.tx(() => void this.fire(w, 'time'));
      } catch (e) {
        const error = errText(e);
        console.error(`workflow ${w.id} failed to start`, error);
        // Move past this slot anyway, or it would fail again every tick. A broken trigger turns the workflow off.
        let next: string | null = null;
        try {
          const when = triggerWhen(this.trigger(w.id));
          next = when?.kind === 'cron' ? (upcoming(when, this.now())[0] ?? null) : null;
        } catch {
          next = null; // the error is shown on the workflow, which is turned off
        }
        this.tx(() => {
          this.db.prepare('UPDATE workflows SET last_error = ?, next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ?').run(error, next, next ? 1 : 0, now, w.id);
          this.touched.workflows.add(w.id);
        });
      }
    }
  }

  /** Start a run (inside a transaction). Returns its id, or null if another tick already claimed this time slot. */
  private fire(w: WfRow, trigger: 'time' | 'manual'): string | null {
    const now = this.now();
    const iso = now.toISOString();
    const t = this.trigger(w.id);
    if (trigger === 'time') {
      const when = triggerWhen(t);
      const next = when?.kind === 'cron' ? upcoming(when, now)[0]! : null;
      const claimed = this.db
        .prepare('UPDATE workflows SET next_run_at = ?, enabled = ?, last_fired_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?')
        .run(next, next ? 1 : 0, iso, w.id, w.next_run_at);
      if (claimed.changes === 0) return null;
    } else this.db.prepare('UPDATE workflows SET last_fired_at = ? WHERE id = ?').run(iso, w.id);
    this.db.prepare('UPDATE workflows SET last_error = NULL, updated_at = ? WHERE id = ?').run(iso, w.id);
    this.touched.workflows.add(w.id);

    const { n } = this.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM workflow_runs WHERE workflow_id = ?').get(w.id) as { n: number };
    const id = 'wr_' + randomUUID().slice(0, 8);
    this.touched.runs.add(id);
    const open = this.db.prepare(`SELECT number FROM workflow_runs WHERE workflow_id = ? AND ${OPEN_RUN} ORDER BY number LIMIT 1`).get(w.id) as { number: number } | undefined;
    if (open) {
      this.db
        .prepare("INSERT INTO workflow_runs (id, workflow_id, number, state, trigger, reason, started_at, ended_at) VALUES (?, ?, ?, 'skipped', ?, ?, ?, ?)")
        .run(id, w.id, n, trigger, `skipped: run ${open.number} was still going`, iso, iso);
      return id;
    }
    this.db.prepare("INSERT INTO workflow_runs (id, workflow_id, number, state, trigger, started_at) VALUES (?, ?, ?, 'running', ?, ?)").run(id, w.id, n, trigger, iso);
    const due = w.next_run_at ? new Date(w.next_run_at) : now;
    const zone = t.kind === 'time' ? t.timezone : localTimeZone();
    const late = trigger === 'time' && now.getTime() - due.getTime() > LATE_MS ? `, due ${stamp(due, zone)}: Atlas was not running then` : '';
    const how = `${trigger === 'manual' ? 'run by hand' : describeTrigger(t)}${late}`;
    const node = this.nodes(w.id).find((x) => x.kind === 'trigger')!;
    this.insertStep(id, node.id, 'trigger', 'done', { exit: 'start', summary: how, ended: true });
    this.follow(id, node.id, 'start');
    return id;
  }

  /** Take `exit` of `fromNode`: enter the step it is wired to, or end the run if nothing is. */
  private follow(runId: string, fromNode: string, exit: string): void {
    const run = this.runRow(runId);
    const edge = this.db.prepare('SELECT to_node FROM workflow_edges WHERE workflow_id = ? AND from_node = ? AND exit = ?').get(run.workflow_id, fromNode, exit) as { to_node: string } | undefined;
    const from = this.node(run.workflow_id, fromNode);
    const name = from ? `« ${stepTitle(from)} »` : `step ${fromNode}`;
    if (!edge) {
      if ((WORKFLOW_FAILING_EXITS as readonly string[]).includes(exit)) {
        const last = this.steps(runId).filter((s) => s.node_id === fromNode).at(-1);
        this.endRun(runId, 'failed', `${name} ${exit}${last?.summary ? `: ${last.summary}` : ''} (nothing is linked to « ${exit} »)`);
      } else this.endRun(runId, 'done', exit === 'start' ? 'nothing to run: the trigger is linked to no step' : `ended after ${name} (${exit})`);
      return;
    }
    const to = this.node(run.workflow_id, edge.to_node);
    if (!to) return this.endRun(runId, 'failed', `exit « ${exit} » of ${name} goes to step ${edge.to_node}, which does not exist`);
    this.enter(runId, to);
  }

  /** Start a step (inside the run's transaction). */
  private enter(runId: string, node: WorkflowNode): void {
    const run = this.runRow(runId);
    const w = this.row(run.workflow_id);
    const all = this.steps(runId);
    if (all.length >= MAX_STEPS) return this.endRun(runId, 'failed', `more than ${MAX_STEPS} steps: a loop with no condition to end it?`);
    const name = `« ${stepTitle(node)} »`;
    const by = 'workflow:' + w.id;
    // « previous »: the last agent step that finished (approvals and conditions pass it on).
    const prev = all.filter((s) => s.kind === 'agent' && (s.state === 'done' || s.state === 'failed')).at(-1);
    const fill = (text: string) =>
      text
        .replaceAll('{{run.id}}', runId)
        .replaceAll('{{previous.summary}}', prev?.summary ?? '(no previous step)')
        .replaceAll('{{previous.task}}', prev?.card_id ? this.kanban.ref(prev.card_id) : '(no previous task)');
    const how = all.find((s) => s.kind === 'trigger')?.summary ?? 'started';
    const why = `\n\n— from workflow ${w.id}, « ${w.name} » run ${run.number}, ${how}.`;

    if (node.kind === 'agent') {
      const c = node.config;
      if (!c.agentId) return this.endRun(runId, 'failed', `${name} has no agent chosen`);
      if (!this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(c.agentId)) return this.endRun(runId, 'failed', `${name}: agent @${c.agentId} does not exist`);
      if (!c.prompt.trim()) return this.endRun(runId, 'failed', `${name} has no prompt`);
      const prompt = fill(c.prompt) + why;
      let card: Card;
      if (c.newTaskEachRun) {
        const title = `${stepTitle(node)} · ${stamp(this.now(), this.zone(w.id), true)}`.slice(0, 200);
        card = this.kanban.create({ title, body: prompt, assignee: c.agentId, status: 'ready' }, by);
      } else {
        card = this.ownCard(w.id, node, by);
        if (card.assignee !== c.agentId) card = this.kanban.update(card.id, { assignee: c.agentId }, by);
        this.kanban.appendMessage(card.id, 'user', 'workflow', [{ type: 'text', text: prompt }]);
        // Reopen a finished card. Running: the agent reads it at its next turn. Blocked or in review: it waits for the user.
        if (card.status === 'done' || card.status === 'todo' || card.status === 'closed') this.kanban.update(card.id, { status: 'ready' }, by);
      }
      this.insertStep(runId, node.id, 'agent', 'running', { card: card.id });
      this.setRunState(runId, 'running');
      // Already blocked or in review (own task): the step waits for the user from the start.
      this.reconcile(runId);
      return;
    }
    if (node.kind === 'approval') {
      const q = fill(node.config.question).trim() || `Continue workflow « ${w.name} »?`;
      const card = this.kanban.create({ title: stepTitle(node).slice(0, 200), body: q + why, assignee: null, status: 'todo' }, by);
      this.kanban.block(card.id, { kind: 'needs_input', reason: q, options: ['Approve', 'Reject'] }, by);
      this.insertStep(runId, node.id, 'approval', 'waiting', { card: card.id });
      this.setRunState(runId, 'waiting');
      return;
    }
    if (node.kind === 'condition') {
      const c = node.config;
      let yes: boolean;
      let summary: string;
      if (c.test === 'ranFewer') {
        const n = all.filter((s) => s.node_id === c.node).length;
        yes = n < c.times;
        summary = `step ${c.node} ran ${n} time${n === 1 ? '' : 's'}: ${yes ? 'fewer than' : 'not fewer than'} ${c.times}`;
      } else {
        yes = (prev?.summary ?? '').toLowerCase().includes(c.text.toLowerCase());
        summary = `the previous summary ${yes ? 'contains' : 'does not contain'} « ${c.text} »`;
      }
      const exit = yes ? 'yes' : 'no';
      this.insertStep(runId, node.id, 'condition', 'done', { exit, summary, ended: true });
      this.follow(runId, node.id, exit);
      return;
    }
    this.endRun(runId, 'failed', `${name}: a trigger cannot be a step`);
  }

  /** Move an open run on from its current step's task (inside a transaction). */
  private reconcile(runId: string): void {
    const step = this.steps(runId).filter((s) => s.state === 'running' || s.state === 'waiting').at(-1);
    if (!step) {
      if (this.runRow(runId).state === 'running' || this.runRow(runId).state === 'waiting') this.endRun(runId, 'failed', 'the run has no current step');
      return;
    }
    const card = step.card_id ? this.cardOrNull(step.card_id) : null;
    if (!card) return this.finishStep(runId, step, step.kind === 'approval' ? 'rejected' : 'failed', 'its task was deleted');
    const by = 'workflow:' + this.runRow(runId).workflow_id;

    if (step.kind === 'agent') {
      if (card.status === 'done') return this.finishStep(runId, step, 'done', this.handoff(card.id, step.started_at));
      if (card.status === 'closed' || card.status === 'archived') return this.finishStep(runId, step, 'failed', `task ${cardRef(card)} was ${card.status}`);
      // The run failed, or the agent said it can't do it: the failed exit (the task is closed, its work moves on).
      if (card.status === 'blocked' && card.block?.kind === 'capability') {
        const why = card.block.reason;
        this.kanban.update(card.id, { status: 'closed' }, by);
        return this.finishStep(runId, step, 'failed', why);
      }
      const waiting = card.status === 'blocked' || card.status === 'review';
      this.setStepState(step, waiting ? 'waiting' : 'running');
      this.setRunState(runId, waiting ? 'waiting' : 'running');
      return;
    }
    if (step.kind === 'approval') {
      if (card.status === 'done') return this.finishStep(runId, step, 'approved', 'approved by you');
      if (card.status === 'closed' || card.status === 'archived') return this.finishStep(runId, step, 'rejected', `rejected by you (task ${card.status})`);
      if (card.status === 'blocked') return;
      // The user answered in the task (an Inbox option or their own words): the dispatcher moved it out of blocked.
      const said = this.lastUserText(card.id, step.started_at);
      const answer = said === null ? null : APPROVE.test(said) ? 'approved' : REJECT.test(said) ? 'rejected' : null;
      if (answer) {
        this.kanban.update(card.id, { status: answer === 'approved' ? 'done' : 'closed' }, 'user');
        const extra = said && !/^\s*(approve|reject)\s*$/i.test(said) ? `: ${cut(said.trim(), 200)}` : '';
        return this.finishStep(runId, step, answer, `${answer} by you${extra}`);
      }
      const reason = said === null ? (card.block?.reason ?? 'Approve or reject?') : `Not understood (« ${cut(said.trim(), 60)} »): answer Approve or Reject.`;
      this.kanban.block(card.id, { kind: 'needs_input', reason, options: ['Approve', 'Reject'] }, by);
      return;
    }
    this.endRun(runId, 'failed', `a ${step.kind} step cannot wait`);
  }

  private finishStep(runId: string, step: StepRow, exit: string, summary: string | null): void {
    const state: WorkflowStepState = exit === 'failed' || exit === 'rejected' ? 'failed' : 'done';
    this.db.prepare('UPDATE workflow_run_steps SET state = ?, exit = ?, summary = ?, ended_at = ? WHERE id = ?').run(state, exit, summary, this.now().toISOString(), step.id);
    this.touched.runs.add(runId);
    this.follow(runId, step.node_id, exit);
  }

  private endRun(runId: string, state: 'done' | 'failed' | 'stopped', reason: string): void {
    const now = this.now().toISOString();
    this.db.prepare(`UPDATE workflow_runs SET state = ?, reason = ?, ended_at = ? WHERE id = ? AND ${OPEN_RUN}`).run(state, reason, now, runId);
    this.db.prepare("UPDATE workflow_run_steps SET state = ?, ended_at = ? WHERE run_id = ? AND state IN ('running', 'waiting')").run(state === 'stopped' ? 'stopped' : 'failed', now, runId);
    this.touched.runs.add(runId);
    this.touched.workflows.add(this.runRow(runId).workflow_id);
  }

  private stopIn(runId: string, by: string): void {
    // Ended first, so the card events of the closes below find nothing open to move on.
    const open = this.steps(runId).filter((x) => x.state === 'running' || x.state === 'waiting');
    this.endRun(runId, 'stopped', by === 'user' ? 'stopped by you' : `stopped by ${by}`);
    for (const s of open) {
      const c = s.card_id ? this.cardOrNull(s.card_id) : null;
      if (c && !['done', 'closed', 'archived'].includes(c.status)) this.kanban.update(c.id, { status: 'closed' }, by);
    }
  }

  /* ── Helpers ── */

  /** Validate a graph; returns its trigger. Every reason is one the user can act on. */
  private check(g: WorkflowGraph): TriggerConfig {
    const byId = new Map<string, WorkflowNode>();
    for (const n of g.nodes) {
      if (byId.has(n.id)) throw new InvalidError(`two steps have the id ${n.id}`);
      byId.set(n.id, n);
    }
    const triggers = g.nodes.filter((n) => n.kind === 'trigger');
    if (triggers.length !== 1) throw new InvalidError(triggers.length ? 'a workflow has exactly one trigger' : 'a workflow needs a trigger');
    const wired = new Set<string>();
    for (const e of g.edges) {
      const from = byId.get(e.from);
      if (!from) throw new InvalidError(`a link starts at step ${e.from}, which does not exist`);
      if (!(WORKFLOW_EXITS[from.kind] as readonly string[]).includes(e.exit))
        throw new InvalidError(`« ${stepTitle(from)} » has no exit « ${e.exit} » (its exits: ${WORKFLOW_EXITS[from.kind].join(', ')})`);
      const to = byId.get(e.to);
      if (!to) throw new InvalidError(`exit « ${e.exit} » of « ${stepTitle(from)} » goes to step ${e.to}, which does not exist`);
      if (to.kind === 'trigger') throw new InvalidError(`exit « ${e.exit} » of « ${stepTitle(from)} » goes back to the trigger: link it to a step`);
      const key = `${e.from}\u0000${e.exit}`;
      if (wired.has(key)) throw new InvalidError(`exit « ${e.exit} » of « ${stepTitle(from)} » is linked twice: one link per exit`);
      wired.add(key);
    }
    for (const n of g.nodes) {
      if (n.kind === 'agent' && n.config.agentId && !this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(n.config.agentId))
        throw new InvalidError(`« ${stepTitle(n)} »: agent @${n.config.agentId} does not exist`);
      if (n.kind === 'condition' && n.config.test === 'ranFewer' && !byId.has(n.config.node))
        throw new InvalidError(`« ${stepTitle(n)} » counts step ${n.config.node}, which does not exist`);
    }
    const t = triggers[0]!.config as TriggerConfig;
    if (t.kind === 'time') {
      if (t.repeat === 'cron' && !t.cron) throw new InvalidError('the trigger repeats on a cron: give the cron expression');
      if (t.repeat === 'at' && !t.at) throw new InvalidError('the trigger runs once: give the date and time');
      upcoming(triggerWhen(t)!, this.now()); // a bad cron expression is refused here
    }
    return t;
  }

  /** Replace nodes and edges, keeping each agent step's own task (by node id). Inside a transaction. */
  private writeGraph(id: string, g: WorkflowGraph): void {
    const own = new Map(this.nodes(id).map((n) => [n.id, n.own_card_id]));
    this.db.prepare('DELETE FROM workflow_nodes WHERE workflow_id = ?').run(id);
    this.db.prepare('DELETE FROM workflow_edges WHERE workflow_id = ?').run(id);
    const ins = this.db.prepare('INSERT INTO workflow_nodes (workflow_id, id, kind, x, y, config, own_card_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const n of g.nodes) ins.run(id, n.id, n.kind, n.x, n.y, JSON.stringify(n.config), own.get(n.id) ?? null);
    const e = this.db.prepare('INSERT INTO workflow_edges (workflow_id, from_node, exit, to_node) VALUES (?, ?, ?, ?)');
    for (const x of g.edges) e.run(id, x.from, x.exit, x.to);
  }

  private firstRun(t: TriggerConfig): string | null {
    const when = triggerWhen(t);
    if (!when) return null;
    const [next] = upcoming(when, this.now());
    if (!next) throw new InvalidError(`${when.at} is in the past: pick a later time`);
    return next;
  }

  /** An agent step's own task, created on first use (again if the user deleted or archived it). */
  private ownCard(workflowId: string, node: Extract<WorkflowNode, { kind: 'agent' }>, by: string): Card {
    const row = this.db.prepare('SELECT own_card_id FROM workflow_nodes WHERE workflow_id = ? AND id = ?').get(workflowId, node.id) as { own_card_id: string | null };
    if (row.own_card_id && this.db.prepare("SELECT 1 FROM cards WHERE id = ? AND status != 'archived'").get(row.own_card_id)) return this.kanban.get(row.own_card_id);
    const card = this.kanban.create(
      {
        title: stepTitle(node).slice(0, 200),
        body: `The task of step « ${stepTitle(node)} » in workflow ${workflowId}. Each run posts the prompt in this chat and reopens the task, so the conversation keeps what earlier runs did.`,
        assignee: node.config.agentId,
        status: 'todo',
      },
      by,
    );
    this.db.prepare('UPDATE workflow_nodes SET own_card_id = ? WHERE workflow_id = ? AND id = ?').run(card.id, workflowId, node.id);
    return card;
  }

  /** The handoff the agent wrote (task_complete or task_request_review) since the step started. */
  private handoff(cardId: string, since: string): string | null {
    const r = this.db
      .prepare("SELECT payload FROM card_events WHERE card_id = ? AND kind IN ('completed', 'review_requested') AND at >= ? ORDER BY rowid DESC LIMIT 1")
      .get(cardId, since) as { payload: string } | undefined;
    return r ? ((JSON.parse(r.payload) as { summary?: string }).summary ?? null) : null;
  }

  private lastUserText(cardId: string, since: string): string | null {
    const m = this.kanban.messages(cardId).filter((x) => x.author === 'user' && x.at >= since).at(-1);
    return m ? m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n') : null;
  }

  private insertStep(runId: string, nodeId: string, kind: WorkflowNodeKind, state: WorkflowStepState, o: { card?: string; exit?: string; summary?: string; ended?: boolean }): void {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM workflow_run_steps WHERE run_id = ? AND node_id = ?').get(runId, nodeId) as { n: number };
    const now = this.now().toISOString();
    this.db
      .prepare('INSERT INTO workflow_run_steps (run_id, node_id, kind, round, state, exit, card_id, summary, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(runId, nodeId, kind, n + 1, state, o.exit ?? null, o.card ?? null, o.summary ?? null, now, o.ended ? now : null);
    this.touched.runs.add(runId);
  }

  private setStepState(step: StepRow, state: WorkflowStepState): void {
    if (step.state === state) return;
    this.db.prepare('UPDATE workflow_run_steps SET state = ? WHERE id = ?').run(state, step.id);
    this.touched.runs.add(step.run_id);
  }

  private setRunState(runId: string, state: 'running' | 'waiting'): void {
    const r = this.db.prepare(`UPDATE workflow_runs SET state = ? WHERE id = ? AND ${OPEN_RUN} AND state != ?`).run(state, runId, state);
    if (r.changes) {
      this.touched.runs.add(runId);
      this.touched.workflows.add(this.runRow(runId).workflow_id);
    }
  }

  private cardOrNull(id: string): Card | null {
    return this.db.prepare('SELECT 1 FROM cards WHERE id = ?').get(id) ? this.kanban.get(id) : null;
  }

  private row(id: string): WfRow {
    const r = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WfRow | undefined;
    if (!r) throw new NotFoundError(`workflow ${id} not found`);
    return r;
  }

  private runRow(id: string): RunRow {
    const r = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!r) throw new NotFoundError(`workflow run ${id} not found`);
    return r;
  }

  private nodes(workflowId: string): NodeRow[] {
    return this.db.prepare('SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY rowid').all(workflowId) as NodeRow[];
  }

  private node(workflowId: string, id: string): WorkflowNode | null {
    const r = this.db.prepare('SELECT * FROM workflow_nodes WHERE workflow_id = ? AND id = ?').get(workflowId, id) as NodeRow | undefined;
    return r ? toNode(r) : null;
  }

  private trigger(workflowId: string): TriggerConfig {
    const n = this.nodes(workflowId).find((x) => x.kind === 'trigger');
    if (!n) throw new InvalidError(`workflow ${workflowId} has no trigger`);
    return JSON.parse(n.config) as TriggerConfig;
  }

  private zone(workflowId: string): string {
    const t = this.trigger(workflowId);
    return t.kind === 'time' ? t.timezone : localTimeZone();
  }

  private steps(runId: string): StepRow[] {
    return this.db.prepare('SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY id').all(runId) as StepRow[];
  }

  private toWorkflow(r: WfRow): Workflow {
    // The latest run that ran: a skipped firing doesn't hide the run it was skipped for (lists show its step and task).
    const last = this.db.prepare("SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY state = 'skipped', number DESC LIMIT 1").get(r.id) as RunRow | undefined;
    const edges = this.db.prepare('SELECT from_node, exit, to_node FROM workflow_edges WHERE workflow_id = ? ORDER BY rowid').all(r.id) as { from_node: string; exit: string; to_node: string }[];
    return {
      id: r.id,
      name: r.name,
      enabled: !!r.enabled,
      origin: r.origin === 'schedules' ? 'schedules' : null,
      revision: r.revision,
      nextRunAt: r.next_run_at,
      lastFiredAt: r.last_fired_at,
      lastError: r.last_error,
      lastRun: last ? { ...toRun(last), steps: this.steps(last.id).map(toStep) } : null,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      nodes: this.nodes(r.id).map(toNode),
      edges: edges.map((e): WorkflowEdge => ({ from: e.from_node, exit: e.exit, to: e.to_node })),
    };
  }

  /** One transaction (a savepoint when nested); what it touched is announced once the outermost one commits. */
  private tx(fn: () => void): void {
    const outer = !this.db.inTransaction;
    try {
      this.db.transaction(fn)();
    } catch (e) {
      if (outer) this.reset();
      throw e;
    }
    if (!outer) return;
    const { runs, workflows } = this.touched;
    // A workflow's lastRun carries its steps: lists follow every step of a run.
    for (const id of runs) {
      const r = this.db.prepare('SELECT workflow_id FROM workflow_runs WHERE id = ?').get(id) as { workflow_id: string } | undefined;
      if (r) workflows.add(r.workflow_id);
    }
    const deleted = this.deleted;
    this.reset();
    for (const id of deleted) this.bus.emit({ type: 'workflow.deleted', id });
    for (const id of runs) if (this.db.prepare('SELECT 1 FROM workflow_runs WHERE id = ?').get(id)) this.bus.emit({ type: 'workflow.run', run: this.run(id) });
    for (const id of workflows) if (this.db.prepare('SELECT 1 FROM workflows WHERE id = ?').get(id)) this.bus.emit({ type: 'workflow.updated', workflow: this.get(id) });
  }

  private reset(): void {
    this.touched = { runs: new Set(), workflows: new Set() };
    this.deleted = [];
  }
}
