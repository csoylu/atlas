import { cardRef, workflowExits, type Card, WORKFLOW_FAILING_EXITS, type TriggerConfig, type Workflow, type WorkflowEdge, type WorkflowNode, type WorkflowNodeKind, type WorkflowRun, type WorkflowRunStep } from '@atlas/shared';

/**
 * Pure helpers of the Workflows page and canvas (#171, mockup /api/files/paris/pages/workflows-165.html): titles and
 * one-line descriptions of steps, the order of the steps (phone list, list chains), what each node shows in a run,
 * the SVG path of an edge, and the trigger form's cron patterns (moved from the Schedules page).
 */

export const KIND_LABEL: Record<WorkflowNodeKind, string> = { trigger: 'Trigger', agent: 'Agent step', approval: 'Approval', condition: 'Condition', action: 'Action', wait: 'Wait' };
/** Width of a node on the canvas (px at 100 %), as in the mockup. */
export const NODE_W = 176;

export const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number | string) => String(n).padStart(2, '0');

/* ── Trigger: the cron patterns the form offers ── */

/** The repeat patterns the form offers; anything else is « custom » (raw cron). */
export type Repeat = 'weekdays' | 'daily' | 'weekly' | 'hourly' | 'custom';
export interface TimeDraft {
  kind: 'cron' | 'at';
  repeat: Repeat;
  time: string; // HH:MM
  weekday: number;
  minute: number; // hourly
  cron: string; // custom
  at: string; // datetime-local value, browser time
  timezone: string;
}

/** Read a cron expression back into the form's pattern, when it is one of them. */
export function patternOf(cron: string): Pick<TimeDraft, 'repeat' | 'time' | 'weekday' | 'minute'> | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || !/^\d+$/.test(f[0]!)) return null;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  if (h === '*' && dom === '*' && mon === '*' && dow === '*') return { repeat: 'hourly', minute: +mi, time: '09:00', weekday: 1 };
  if (!/^\d+$/.test(h) || dom !== '*' || mon !== '*') return null;
  const time = `${pad(h)}:${pad(mi)}`;
  if (dow === '*') return { repeat: 'daily', time, weekday: 1, minute: 0 };
  if (dow === '1-5') return { repeat: 'weekdays', time, weekday: 1, minute: 0 };
  if (/^[0-6]$/.test(dow)) return { repeat: 'weekly', time, weekday: +dow, minute: 0 };
  return null;
}

export function cronOf(d: Pick<TimeDraft, 'repeat' | 'time' | 'weekday' | 'minute' | 'cron'>): string {
  const [h, m] = d.time.split(':').map(Number) as [number, number];
  switch (d.repeat) {
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly':
      return `${m} ${h} * * ${d.weekday}`;
    case 'hourly':
      return `${d.minute} * * * *`;
    default:
      return d.cron.trim();
  }
}

/** datetime-local (browser time) from an ISO instant. */
export const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function timeDraftOf(t: TriggerConfig): TimeDraft {
  const base: TimeDraft = { kind: 'cron', repeat: 'weekdays', time: '09:00', weekday: 1, minute: 0, cron: '0 9 * * 1-5', at: toLocalInput(new Date(Date.now() + 3_600_000).toISOString()), timezone: BROWSER_TZ };
  if (t.kind !== 'time') return base;
  const p = t.cron ? patternOf(t.cron) : null;
  return {
    ...base,
    kind: t.repeat,
    ...(p ?? (t.cron ? { repeat: 'custom' as const } : {})),
    cron: t.cron ?? base.cron,
    at: t.at ? toLocalInput(t.at) : base.at,
    timezone: t.timezone,
  };
}

export function triggerOf(d: TimeDraft): TriggerConfig {
  return d.kind === 'cron'
    ? { kind: 'time', repeat: 'cron', cron: cronOf(d) || null, at: null, timezone: d.timezone }
    : { kind: 'time', repeat: 'at', cron: null, at: d.at ? new Date(d.at).toISOString() : null, timezone: d.timezone };
}

const EVENT_WORDS: Record<string, string> = {
  created: 'is created',
  status_changed: 'changes status',
  assignee_changed: 'changes assignee',
  review_requested: 'asks for review',
  blocked: 'is blocked',
  done: 'is done',
  opened: 'is opened',
  pushed: 'gets a new commit',
  ci_finished: 'finishes CI',
  conflict: 'has a conflict',
  validated: 'is validated or refused by QA',
  merged: 'is merged',
  closed: 'is closed',
};
/** « When a task is done », « When a PR is merged » (#258; the editor for these comes in 2/6). */
export function eventText(t: Extract<TriggerConfig, { kind: 'task' | 'pr' }>): string {
  if (t.kind === 'pr' && t.event === 'ci_finished' && t.result) return `When CI turns ${t.result === 'failure' ? 'red' : 'green'} on a PR`;
  return `When a ${t.kind === 'task' ? 'task' : 'PR'} ${EVENT_WORDS[t.event] ?? t.event}`;
}

/** « Weekdays at 09:00 », « Every Monday at 18:30 », « Once, … », « By hand only »… or the cron itself. */
export function describeTrigger(t: TriggerConfig): string {
  if (t.kind === 'manual') return 'By hand only';
  if (t.kind === 'task' || t.kind === 'pr') return eventText(t);
  if (t.kind === 'webhook') return 'On a webhook call';
  if (t.repeat === 'at') return t.at ? 'Once, ' + when(t.at) : 'Once';
  const p = patternOf(t.cron ?? '');
  if (!p) return `cron ${t.cron ?? ''}`.trim();
  if (p.repeat === 'hourly') return `Every hour at :${pad(p.minute)}`;
  if (p.repeat === 'weekdays') return `Weekdays at ${p.time}`;
  if (p.repeat === 'daily') return `Every day at ${p.time}`;
  return `Every ${DAYS[p.weekday]} at ${p.time}`;
}

/** « today 09:00 », « tomorrow 09:00 », else « Tue 11 Nov, 09:00 », in the browser's zone. */
export function when(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => x.toDateString();
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (day(d) === day(now)) return `today ${time}`;
  if (day(d) === day(tomorrow)) return `tomorrow ${time}`;
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** « in 5 min », « 3 h ago », « just now ». */
export function relative(iso: string, now = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const a = Math.abs(s);
  if (a < 45) return 'just now';
  const t = a < 90 ? `${a} s` : a < 5400 ? `${Math.round(a / 60)} min` : a < 129_600 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86_400)} d`;
  return s >= 0 ? `in ${t}` : `${t} ago`;
}

/** « 52 min », « 3 h », « 40 s ». */
export function duration(fromIso: string, toIso: string): string {
  const a = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000));
  return a < 90 ? `${a} s` : a < 5400 ? `${Math.round(a / 60)} min` : a < 129_600 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86_400)} d`;
}

/* ── Steps ── */

const firstLine = (s: string) => s.trim().split('\n')[0]!.trim();

/** A step's title as the canvas shows it (its own title, else something said from its settings). */
export function nodeTitle(n: WorkflowNode, nodes: WorkflowNode[] = []): string {
  switch (n.kind) {
    case 'trigger':
      return describeTrigger(n.config);
    case 'agent':
      return n.config.title || firstLine(n.config.prompt).slice(0, 80) || 'New agent step';
    case 'approval':
      return n.config.title || firstLine(n.config.question).slice(0, 80) || 'Approval';
    case 'condition':
      return n.config.title || conditionText(n.config, nodes);
    case 'action':
      return n.config.title || actionText(n.config);
    case 'wait':
      return n.config.title || `Wait: ${WAIT_TEXT[n.config.for]}${n.config.for === 'status' ? ` ${n.config.status ?? '?'}` : ''}`;
  }
}

const WAIT_TEXT = { ciFinished: 'CI finished', ciGreen: 'CI green', conflict: 'a conflict', merged: 'the PR merged', unblocked: 'the task unblocked', status: 'the task in' } as const;
const OP_TEXT = { is: 'is', isNot: 'is not', contains: 'contains', notContains: 'does not contain', isEmpty: 'is empty', isNotEmpty: 'is not empty', gt: '>', lt: '<' } as const;

function actionText(c: Extract<WorkflowNode, { kind: 'action' }>['config']): string {
  if (c.do === 'setStatus') return `Task → ${c.status}`;
  if (c.do === 'setAssignee') return c.assignee ? `Assign to @${c.assignee}` : 'Unassign the task';
  if (c.do === 'mergePr') return 'Validate + merge the PR';
  if (c.do === 'command') return firstLine(c.command).slice(0, 80) || 'Run a command';
  return firstLine(c.text).slice(0, 80) || 'Notify Master';
}

function conditionText(c: Extract<WorkflowNode, { kind: 'condition' }>['config'], nodes: WorkflowNode[]): string {
  if (c.test === 'summaryContains') return `Previous summary has « ${c.text} »`;
  if (c.test === 'fields') return c.tests.map((t) => `${t.field} ${OP_TEXT[t.op]}${t.op === 'isEmpty' || t.op === 'isNotEmpty' ? '' : ` ${t.value}`}`).join(c.match === 'all' ? ' and ' : ' or ');
  const counted = nodes.find((x) => x.id === c.node);
  return `${counted ? nodeTitle(counted, []) : c.node} ran < ${c.times} times`;
}

/** The faint line under a step's title. */
export function nodeMeta(n: WorkflowNode, nodes: WorkflowNode[] = []): string {
  switch (n.kind) {
    case 'trigger':
      return n.config.kind === 'time'
        ? `At set times · ${n.config.timezone}`
        : n.config.kind === 'task' || n.config.kind === 'pr'
          ? eventMeta(n.config)
          : n.config.kind === 'webhook'
            ? ['Webhook', ...(n.config.filters.length ? n.config.filters.map((f) => `${f.field} ${OP_TEXT[f.op]} ${f.value}`.trim()) : ['any call'])].join(' · ')
            : 'Run now, from here or a chat';
    case 'agent':
      if (n.config.reviewAgent) return 'The review agent · in the task thread';
      return n.config.agentId ? `@${n.config.agentId} · ${n.config.inThread ? 'in the task thread' : n.config.newTaskEachRun ? 'new task' : 'one task'}` : 'Pick an agent and a prompt';
    case 'approval':
      return 'You, in the Inbox';
    case 'condition':
      return n.config.title ? conditionText(n.config, nodes) : n.config.test === 'ranFewer' ? 'Counts the rounds' : n.config.test === 'fields' ? 'Tests the run’s fields' : 'Reads the previous summary';
    case 'action':
      if (n.config.do === 'command') return `Clean checkout · at most ${n.config.limitMin} min`;
      return n.config.title ? actionText(n.config) : 'Atlas does it, no model';
    case 'wait':
      return `At most ${n.config.limitMin % 60 === 0 ? `${n.config.limitMin / 60} h` : `${n.config.limitMin} min`}`;
  }
}

export interface Exit {
  exit: string;
  /** The wired step, or null: the run ends there. */
  to: string | null;
  /** An unwired failing exit ends the run Failed. */
  failing: boolean;
}

export function exitsOf(n: WorkflowNode, edges: WorkflowEdge[]): Exit[] {
  return workflowExits(n).map((exit) => ({
    exit,
    to: edges.find((e) => e.from === n.id && e.exit === exit)?.to ?? null,
    failing: (WORKFLOW_FAILING_EXITS as readonly string[]).includes(exit),
  }));
}

/** What an exit leads to, in words: « Merge PR? » or « ends the run ». */
export function exitTarget(x: Exit, nodes: WorkflowNode[]): string {
  if (!x.to) return x.failing ? 'ends the run (failed)' : 'ends the run';
  const t = nodes.find((n) => n.id === x.to);
  return t ? nodeTitle(t, nodes) : x.to;
}

/** The steps in the order a run meets them (from the trigger, exits in their order), then the unreachable ones by position. */
export function stepOrder(w: Pick<Workflow, 'nodes' | 'edges'>): WorkflowNode[] {
  const byId = new Map(w.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const out: WorkflowNode[] = [];
  const queue: WorkflowNode[] = w.nodes.filter((n) => n.kind === 'trigger');
  while (queue.length) {
    const n = queue.shift()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    for (const x of exitsOf(n, w.edges)) {
      const t = x.to ? byId.get(x.to) : undefined;
      if (t && !seen.has(t.id)) queue.push(t);
    }
  }
  const rest = w.nodes.filter((n) => !seen.has(n.id)).sort((a, b) => a.y - b.y || a.x - b.x);
  return [...out, ...rest];
}

/** The list row's chain: the steps of the main path (the first exit of each step), « +N more » after `max`. */
export function chainOf(w: Pick<Workflow, 'nodes' | 'edges'>, max = 4): { steps: WorkflowNode[]; more: number } {
  const byId = new Map(w.nodes.map((n) => [n.id, n]));
  const path: WorkflowNode[] = [];
  const seen = new Set<string>();
  let n: WorkflowNode | undefined = w.nodes.find((x) => x.kind === 'trigger');
  while (n && !seen.has(n.id)) {
    seen.add(n.id);
    if (n.kind !== 'trigger') path.push(n);
    const first: Exit | undefined = exitsOf(n, w.edges)[0];
    n = first?.to ? byId.get(first.to) : undefined;
  }
  const others = w.nodes.length - 1 - path.length;
  return { steps: path.slice(0, max), more: Math.max(0, path.length - max) + others };
}

/* ── Runs ── */

/** What a node shows in a run, from its latest step (earlier rounds stay listed inside the node). */
/** couldnt: the step couldn't run (#261, no outcome yet): the run waits on it, Atlas retries. */
export type NodeRunState = 'couldnt' | 'working' | 'waiting' | 'done' | 'failed' | 'approved' | 'rejected' | 'yes' | 'no' | 'stopped' | 'skipped' | 'not-reached';

export function stepState(s: WorkflowRunStep): Exclude<NodeRunState, 'skipped' | 'not-reached'> {
  if (s.couldntRun && !s.endedAt) return 'couldnt';
  if (s.state === 'running') return 'working';
  if (s.state === 'waiting') return 'waiting';
  if (s.state === 'stopped') return 'stopped';
  if (s.kind === 'approval') return s.exit === 'approved' ? 'approved' : 'rejected';
  if (s.kind === 'condition' && (s.exit === 'yes' || s.exit === 'no')) return s.exit;
  return s.state === 'failed' ? 'failed' : 'done';
}

export function nodeRunState(run: WorkflowRun, nodeId: string): { state: NodeRunState; steps: WorkflowRunStep[] } {
  const steps = (run.steps ?? []).filter((s) => s.nodeId === nodeId);
  const last = steps.at(-1);
  if (last) return { state: stepState(last), steps };
  const open = run.state === 'running' || run.state === 'waiting';
  return { state: open ? 'not-reached' : 'skipped', steps };
}

export const STATE_LABEL: Record<NodeRunState, string> = {
  couldnt: "Couldn't run",
  working: 'Working',
  waiting: 'Waiting for you',
  done: 'Done',
  failed: 'Failed',
  approved: 'Approved',
  rejected: 'Rejected',
  yes: 'yes',
  no: 'no',
  stopped: 'Stopped',
  skipped: 'Skipped',
  'not-reached': 'Not reached',
};

/** The chip class (styles.css .st-chip.*) of a state. */
export function chipClass(s: NodeRunState | WorkflowRun['state']): string {
  switch (s) {
    case 'working':
    case 'running':
      return 'working';
    case 'waiting':
      return 'blocked';
    case 'done':
    case 'approved':
    case 'yes':
    case 'no':
      return 'done';
    case 'failed':
    case 'rejected':
    case 'couldnt':
      return 'failed';
    default:
      return 'idle';
  }
}

export const RUN_LABEL: Record<WorkflowRun['state'], string> = { running: 'Running', waiting: 'Waiting for you', done: 'Done', failed: 'Failed', stopped: 'Stopped', skipped: 'Skipped' };

/** The node border class in Runs mode, from its latest state. */
export function nodeClass(s: NodeRunState): string {
  if (s === 'working') return 'now';
  if (s === 'waiting') return 'wait';
  if (s === 'failed' || s === 'rejected' || s === 'couldnt') return 'bad';
  if (s === 'skipped') return 'skip';
  if (s === 'not-reached') return 'unreached';
  return '';
}

/** Edges a run went through, as `from:exit`. */
export function takenEdges(run: WorkflowRun): Set<string> {
  return new Set((run.steps ?? []).flatMap((s) => (s.exit ? [`${s.nodeId}:${s.exit}`] : [])));
}

/** The task of a run to link to: the step going now, else the last step with a task. */
export function runTask(run: WorkflowRun | null): string | null {
  const steps = run?.steps ?? [];
  const open = steps.find((s) => (s.state === 'running' || s.state === 'waiting') && s.cardId);
  return open?.cardId ?? steps.filter((s) => s.cardId).at(-1)?.cardId ?? null;
}

/* ── Canvas geometry ── */

export type Pt = [number, number];
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The SVG path of an edge from exit point `a` to input point `b`: forward (b well to the right) a bezier; backward or
 * down a rounded orthogonal path through a lane: between the two nodes when the target is below the source, else
 * under every node (`bottom` = lowest node edge). `srcBottom` / `dstTop`: the source's bottom and the target's top.
 */
export function edgePath(a: Pt, b: Pt, srcBottom: number, dstTop: number, bottom: number): string {
  const [ax, ay] = [r1(a[0]), r1(a[1])];
  const [bx, by] = [r1(b[0]), r1(b[1])];
  if (bx > ax + 20) {
    const c = r1(Math.max(28, (bx - ax) / 2));
    return `M${ax},${ay} C${r1(ax + c)},${ay} ${r1(bx - c)},${by} ${bx},${by}`;
  }
  const lane = laneOf(srcBottom, dstTop, bottom);
  const x1 = r1(ax + 12);
  const x2 = r1(bx - 14);
  const r = 8;
  const up = by < lane;
  return (
    `M${ax},${ay} H${x1 - r} Q${x1},${ay} ${x1},${ay + r} V${lane - r} Q${x1},${lane} ${x1 - r},${lane}` +
    ` H${x2 + r} Q${x2},${lane} ${x2},${lane + (up ? -r : r)} V${by + (up ? r : -r)} Q${x2},${by} ${x2 + r},${by} H${bx}`
  );
}

/**
 * The lane of an edge going back to an earlier column: just above the target's row when it is lower (#262: not through
 * the rows in between, as in the mockup), else under everything.
 */
function laneOf(srcBottom: number, dstTop: number, bottom: number): number {
  return r1(dstTop > srcBottom ? Math.max((srcBottom + dstTop) / 2, dstTop - 26) : bottom + 22);
}

/** The draft line while wiring: a bezier from the exit to the pointer. */
export function draftPath(a: Pt, b: Pt): string {
  return `M${r1(a[0])},${r1(a[1])} C${r1(a[0] + 60)},${r1(a[1])} ${r1(b[0] - 60)},${r1(b[1])} ${r1(b[0])},${r1(b[1])}`;
}

/** Where a new step goes: right of `near` (or of everything), moved down until it overlaps no node. */
export function freeSpot(nodes: Pick<WorkflowNode, 'x' | 'y'>[], near?: Pick<WorkflowNode, 'x' | 'y'>): { x: number; y: number } {
  let x = near ? near.x + 240 : Math.max(40, ...nodes.map((n) => n.x + 240));
  let y = near ? near.y : 120;
  if (!near && !nodes.length) x = 40;
  const hit = () => nodes.some((n) => Math.abs(n.x - x) < NODE_W + 20 && Math.abs(n.y - y) < 130);
  for (let i = 0; i < 50 && hit(); i++) y += 140;
  return { x, y };
}

/** A node id not used yet: step1, step2… */
export function newNodeId(nodes: Pick<WorkflowNode, 'id'>[]): string {
  const used = new Set(nodes.map((n) => n.id));
  let i = 1;
  while (used.has('step' + i)) i++;
  return 'step' + i;
}

/** Remove a node and every edge touching it. */
export function withoutNode(g: Pick<Workflow, 'nodes' | 'edges'>, id: string): Pick<Workflow, 'nodes' | 'edges'> {
  return { nodes: g.nodes.filter((n) => n.id !== id), edges: g.edges.filter((e) => e.from !== id && e.to !== id) };
}

/** Wire `from`'s `exit` to `to` (one edge per exit: replaces the old one); `to` null unwires it. */
export function wire(g: Pick<Workflow, 'nodes' | 'edges'>, from: string, exit: string, to: string | null): Pick<Workflow, 'nodes' | 'edges'> {
  const edges = g.edges.filter((e) => !(e.from === from && e.exit === exit));
  return { nodes: g.nodes, edges: to ? [...edges, { from, exit, to }] : edges };
}

/** « #12 » for a task id, from the cards the UI has (the id itself when unknown). */
export function refOf(id: string, cards: Card[]): string {
  const c = cards.find((x) => x.id === id);
  return c ? cardRef(c) : "its task";
}

/* ── The list page (#234, mockup /api/files/paris/pages/workflows-234.html) ── */

export type ListGroup = 'on' | 'off' | 'past';

/** A one-off (« Once ») workflow whose date has gone. */
export function isPastOnce(w: Workflow, now = new Date()): boolean {
  const t = w.nodes.find((n) => n.kind === 'trigger');
  return t?.kind === 'trigger' && t.config.kind === 'time' && t.config.repeat === 'at' && !!t.config.at && new Date(t.config.at) < now;
}

/** On, Off, or Past: a one-off that is off and whose date has gone (it can't run on its own again). */
export function listGroup(w: Workflow, now = new Date()): ListGroup {
  if (w.enabled) return 'on';
  return isPastOnce(w, now) ? 'past' : 'off';
}

/** The header's count: « 5 on · 1 off · 2 past », only the non-empty groups. */
export function groupCount(ws: Workflow[], now = new Date()): string {
  const n = { on: 0, off: 0, past: 0 };
  for (const w of ws) n[listGroup(w, now)]++;
  return (['on', 'off', 'past'] as const)
    .filter((g) => n[g])
    .map((g) => `${n[g]} ${g}`)
    .join(' · ');
}

/** The run strip: 10 slots, the latest run on the right, empty slots on the left. */
export function runStrip(states: WorkflowRun['state'][], slots = 10): (WorkflowRun['state'] | null)[] {
  const last = states.slice(-slots);
  return [...Array<null>(slots - last.length).fill(null), ...last];
}

export interface Template {
  key: string;
  name: string;
  description: string;
  /** The workflow it creates, for the given agents (the first ones in the list). */
  build(agents: string[]): { name: string; nodes: WorkflowNode[]; edges: WorkflowEdge[] };
}

const tplAgent = (id: string, x: number, title: string, agentId: string | null, prompt: string): WorkflowNode => ({ id, kind: 'agent', x, y: 80, config: { title, agentId, prompt, newTaskEachRun: true } });
const tplTime = (cron: string): WorkflowNode => ({ id: 'trigger', kind: 'trigger', x: 40, y: 80, config: { kind: 'time', repeat: 'cron', cron, at: null, timezone: BROWSER_TZ } });

/** The empty page's three examples (#234). Time ones are created off: Master reads them on the canvas, then turns them on. */
export const TEMPLATES: Template[] = [
  {
    key: 'morning',
    name: 'Morning report',
    description: 'An agent writes a short report of what happened since yesterday.',
    build: ([a = null]) => ({
      name: 'Morning report',
      nodes: [tplTime('0 9 * * 1-5'), tplAgent('step1', 300, 'Morning report', a, 'Write a short report of what happened since yesterday: tasks finished, tasks blocked, anything that needs me.')],
      edges: [{ from: 'trigger', exit: 'start', to: 'step1' }],
    }),
  },
  {
    key: 'weekly',
    name: 'Weekly check',
    description: 'An agent checks something every week (dependencies, costs, memory) and opens a task if it finds a problem.',
    build: ([a = null]) => ({
      name: 'Weekly check',
      nodes: [tplTime('0 9 * * 1'), tplAgent('step1', 300, 'Weekly check', a, 'Check the project dependencies for updates and security advisories. If something needs work, open a task for it.')],
      edges: [{ from: 'trigger', exit: 'start', to: 'step1' }],
    }),
  },
  {
    key: 'approve',
    name: 'Task with your OK',
    description: 'One agent does the work, you approve it, then a second agent finishes it.',
    build: ([a = null, b = a]) => ({
      name: 'Task with your OK',
      nodes: [
        { id: 'trigger', kind: 'trigger', x: 40, y: 80, config: { kind: 'manual' } },
        tplAgent('step1', 300, 'Do the work', a, 'Describe the work here.'),
        { id: 'ok', kind: 'approval', x: 560, y: 80, config: { title: 'Your OK', question: 'Approve this? {{previous.summary}}' } },
        tplAgent('step2', 820, 'Finish it', b, 'Finish the approved work: {{previous.summary}}'),
      ],
      edges: [
        { from: 'trigger', exit: 'start', to: 'step1' },
        { from: 'step1', exit: 'done', to: 'ok' },
        { from: 'ok', exit: 'approved', to: 'step2' },
      ],
    }),
  },
];

/* ── Workflows v2 stage 1 (#259): the trigger picker, its filters, fields, back-edge labels ── */

export type TriggerKind = TriggerConfig['kind'];
/** The trigger picker, in the mockup's order (Webhook comes with 3/6). */
export const TRIGGER_KINDS: { kind: TriggerKind; label: string; help: string; isNew?: boolean }[] = [
  { kind: 'time', label: 'At set times', help: 'Every day, weekdays, weekly, hourly, once, or cron' },
  { kind: 'task', label: 'Task event', help: 'Created, status changed to…, blocked, asks for review', isNew: true },
  { kind: 'pr', label: 'Pull request event', help: 'Opened, CI green or red, conflict, merged', isNew: true },
  { kind: 'webhook', label: 'Webhook', help: 'A secret URL; its JSON body is the payload', isNew: true },
  { kind: 'manual', label: 'Only by hand', help: 'Run now, from the workflow or on a task' },
];

type EventTrigger = Extract<TriggerConfig, { kind: 'task' | 'pr' }>;
/** One event button: the event, and for CI the result it implies (« CI turns red » = ci_finished + failure). */
export interface EventChoice {
  key: string;
  label: string;
  event: EventTrigger['event'];
  result?: 'success' | 'failure';
}
export const TASK_EVENT_CHOICES: EventChoice[] = [
  { key: 'created', label: 'is created', event: 'created' },
  { key: 'status_changed', label: 'changes status', event: 'status_changed' },
  { key: 'assignee_changed', label: 'changes assignee', event: 'assignee_changed' },
  { key: 'blocked', label: 'is blocked', event: 'blocked' },
  { key: 'review_requested', label: 'asks for review', event: 'review_requested' },
  { key: 'done', label: 'is done', event: 'done' },
];
export const PR_EVENT_CHOICES: EventChoice[] = [
  { key: 'opened', label: 'is opened', event: 'opened' },
  { key: 'pushed', label: 'gets a new commit', event: 'pushed' },
  { key: 'ci_red', label: 'CI turns red', event: 'ci_finished', result: 'failure' },
  { key: 'ci_green', label: 'CI turns green', event: 'ci_finished', result: 'success' },
  { key: 'ci_any', label: 'CI finishes', event: 'ci_finished' },
  { key: 'conflict', label: 'has a conflict', event: 'conflict' },
  { key: 'validated', label: 'is validated by QA', event: 'validated' },
  { key: 'merged', label: 'is merged', event: 'merged' },
  { key: 'closed', label: 'is closed', event: 'closed' },
];

/** The event button that is on for a trigger. */
export function eventChoiceOf(t: EventTrigger): string {
  if (t.kind === 'pr' && t.event === 'ci_finished') return t.result === 'failure' ? 'ci_red' : t.result === 'success' ? 'ci_green' : 'ci_any';
  return t.event;
}

/** The trigger after a click on an event button: filters kept, the result follows the CI choice. */
export function withEvent(t: EventTrigger, choice: EventChoice): EventTrigger {
  if (t.kind === 'task') return { ...t, event: choice.event as Extract<TriggerConfig, { kind: 'task' }>['event'], from: choice.event === 'status_changed' ? t.from : [] };
  const keepResult = choice.event === 'validated' ? t.result : '';
  return { ...t, event: choice.event as Extract<TriggerConfig, { kind: 'pr' }>['event'], result: choice.result ?? keepResult };
}

/** A fresh trigger of a kind, keeping what can be kept (the loop guard). */
export function blankTrigger(kind: TriggerKind, prev: TriggerConfig, tz = BROWSER_TZ): TriggerConfig {
  const guard = prev.kind === 'task' || prev.kind === 'pr' || prev.kind === 'webhook' ? prev.maxRunsPerHour : 5;
  if (kind === 'manual') return { kind: 'manual' };
  if (kind === 'webhook') return { kind: 'webhook', filters: [], maxRunsPerHour: guard };
  if (kind === 'time') return { kind: 'time', repeat: 'cron', cron: '0 9 * * 1-5', at: null, timezone: tz };
  if (kind === 'task') return { kind: 'task', event: 'review_requested', from: [], status: [], assignee: [], maxRunsPerHour: guard };
  return { kind: 'pr', event: 'ci_finished', repo: '', base: '', result: 'failure', status: [], assignee: [], maxRunsPerHour: guard };
}

/** One « Only if » row: a field and one value; several rows of one field mean « any of them ». */
export type FilterKey = 'status' | 'from' | 'assignee' | 'repo' | 'base' | 'result';
export interface FilterRow {
  key: FilterKey;
  value: string;
}
export const FILTER_LABEL: Record<FilterKey, string> = {
  status: 'Task › Status',
  from: 'Task › Status before',
  assignee: 'Task › Assignee',
  repo: 'PR › Repo',
  base: 'PR › Base branch',
  result: 'PR › Result',
};

/** The filters a trigger can take (the result only for a QA validation; CI's comes with its event button). */
export function filterKeys(t: EventTrigger): FilterKey[] {
  if (t.kind === 'task') return t.event === 'status_changed' ? ['status', 'from', 'assignee'] : ['status', 'assignee'];
  return t.event === 'validated' ? ['repo', 'base', 'result', 'status', 'assignee'] : ['repo', 'base', 'status', 'assignee'];
}

/** An event trigger's line on the canvas: its kind and its filters in short (« Pull request event · base main »). */
export function eventMeta(t: EventTrigger): string {
  const rows = filterRows(t).map((r) => `${FILTER_LABEL[r.key].split(' › ')[1]!.toLowerCase()} ${r.key === 'assignee' ? '@' + r.value : r.value}`);
  return [t.kind === 'task' ? 'Task event' : 'Pull request event', ...(rows.length ? rows : [t.kind === 'task' ? 'any task' : 'any PR'])].join(' · ');
}

export function filterRows(t: EventTrigger): FilterRow[] {
  const rows: FilterRow[] = [];
  if (t.kind === 'pr') {
    if (t.repo) rows.push({ key: 'repo', value: t.repo });
    if (t.base) rows.push({ key: 'base', value: t.base });
    if (t.event === 'validated' && t.result) rows.push({ key: 'result', value: t.result });
  }
  if (t.kind === 'task') for (const v of t.from) rows.push({ key: 'from', value: v });
  for (const v of t.status) rows.push({ key: 'status', value: v });
  for (const v of t.assignee) rows.push({ key: 'assignee', value: v });
  return rows;
}

/** The trigger with these « Only if » rows (rows of a field the trigger can't take are dropped). */
export function withFilters(t: EventTrigger, rows: FilterRow[]): EventTrigger {
  const ok = new Set(filterKeys(t));
  const of = (k: FilterKey) => [...new Set(rows.filter((r) => r.key === k && ok.has(k) && r.value).map((r) => r.value))];
  const status = of('status') as EventTrigger['status'];
  const assignee = of('assignee');
  if (t.kind === 'task') return { ...t, status, assignee, from: of('from') as EventTrigger['status'] };
  const result = t.event === 'validated' ? ((of('result')[0] ?? '') as '' | 'success' | 'failure') : t.result;
  return { ...t, status, assignee, repo: of('repo')[0] ?? '', base: of('base')[0] ?? '', result };
}

/** What a run of this trigger knows, as the groups of « The run gets ». */
export function runGets(t: TriggerConfig, hasProject: boolean): string[] {
  if (t.kind === 'task') return ['project', 'task'];
  if (t.kind === 'pr') return ['project', 'pr', 'task'];
  if (t.kind === 'manual') return [...(hasProject ? ['project'] : []), 'task', 'pr'];
  if (t.kind === 'webhook') return ['payload', 'payload.…', ...(hasProject ? ['project'] : [])];
  return hasProject ? ['project'] : [];
}

/** The « Insert a field » groups, in the mockup's order. */
export const FIELD_GROUPS: { key: string; label: string }[] = [
  { key: 'task', label: 'Task' },
  { key: 'pr', label: 'Pull request' },
  { key: 'event', label: 'Event' },
  { key: 'payload', label: 'Payload' },
  { key: 'steps', label: 'Earlier steps' },
  { key: 'previous', label: 'Earlier steps' },
  { key: 'project', label: 'Project' },
  { key: 'run', label: 'This run' },
  { key: 'workflow', label: 'This run' },
];
/** Group the fields: { label, fields } in FIELD_GROUPS order, groups with the same label merged. */
export function groupFields<F extends { field: string; label: string }>(fields: F[], query = ''): { label: string; fields: F[] }[] {
  const q = query.trim().toLowerCase();
  const out: { label: string; fields: F[] }[] = [];
  for (const f of fields) {
    if (q && !f.label.toLowerCase().includes(q) && !f.field.toLowerCase().includes(q)) continue;
    const prefix = f.field.split('.')[0]!;
    const label = FIELD_GROUPS.find((g) => g.key === prefix)?.label ?? 'Other';
    let g = out.find((x) => x.label === label);
    if (!g) out.push((g = { label, fields: [] }));
    g.fields.push(f);
  }
  const order = (l: string) => {
    const i = FIELD_GROUPS.findIndex((g) => g.label === l);
    return i < 0 ? 99 : i;
  };
  return out.sort((a, b) => order(a.label) - order(b.label));
}

/** Split step text into plain parts and {{field}} parts (the chips). */
export function fieldParts(text: string): { text: string; field: boolean }[] {
  const out: { text: string; field: boolean }[] = [];
  const re = /\{\{\s*[\w.-]+\s*\}\}/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), field: false });
    out.push({ text: m[0], field: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), field: false });
  return out;
}

/** Where an edge's exit name goes when the edge leaves the node's column backwards or downwards: the middle of its lane. Null for a forward edge. */
export function edgeLabelAt(a: Pt, b: Pt, srcBottom: number, dstTop: number, bottom: number): Pt | null {
  if (b[0] > a[0] + 20) return null;
  const lane = laneOf(srcBottom, dstTop, bottom);
  return [r1((a[0] + 12 + b[0] - 14) / 2), lane];
}

/** What started a run, in words, after its subject's ref: « asks for review », « by hand », « at its set time ». */
export function startedBy(run: Pick<WorkflowRun, 'trigger' | 'event'>): string {
  if (run.trigger === 'time') return 'at its set time';
  if (run.trigger === 'manual') return 'by hand';
  return (run.event && EVENT_WORDS[run.event]) || run.event || run.trigger;
}

/** A PR url → « PR #74 ». */
export function prLabel(url: string): string {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? `PR #${m[1]}` : url;
}

/** A workflow stopped by the loop guard: off, and its last error says so. */
export function loopGuardHit(w: Pick<Workflow, 'enabled' | 'lastError'>): boolean {
  return !w.enabled && !!w.lastError && w.lastError.startsWith('loop guard');
}

/* ── Workflows v2 stage 2 (#262, mockup doc_bf5e40e1 « Add step ») ── */

export type AddKind = Exclude<WorkflowNodeKind, 'trigger'>;
/** The « Add step » menu: each kind says its exits, so the wiring is known before adding. */
export const ADD_STEPS: { kind: AddKind; label: string; help: string; isNew?: boolean }[] = [
  { kind: 'agent', label: 'Agent step', help: 'An agent works, in the task thread (new) or as a new task. Exits: done, not done.' },
  { kind: 'approval', label: 'Approval', help: 'A question to you, in the Inbox. Exits: approved, rejected.' },
  { kind: 'condition', label: 'Condition', help: 'An exact test on task, PR or payload fields (new), a summary, or rounds. Exits: yes, no.' },
  { kind: 'action', label: 'Action', help: 'Atlas does it, no model: set status or assignee, merge a PR, notify you, run a command. Exits name the outcome: merged / refused, exit 0 / other exit…', isNew: true },
  { kind: 'wait', label: 'Wait', help: 'Until an event (CI finished, merged, unblocked…), with a time limit. Exits: event, timed out.', isNew: true },
];

/** The run's own task exists for task and PR triggers only: an agent step works in its thread by default there. */
export function hasRunTask(g: Pick<Workflow, 'nodes'>): boolean {
  const t = g.nodes.find((n) => n.kind === 'trigger');
  return t?.kind === 'trigger' && (t.config.kind === 'task' || t.config.kind === 'pr');
}

/** A new step of `kind`, with settings that save as they are (the save refuses an invalid step). */
export function blankStep(kind: AddKind, id: string, at: { x: number; y: number }, g: Pick<Workflow, 'nodes'>): WorkflowNode {
  const pos = { id, x: Math.round(at.x), y: Math.round(at.y) };
  const thread = hasRunTask(g);
  switch (kind) {
    case 'agent':
      return { ...pos, kind, config: { title: '', agentId: null, prompt: '', newTaskEachRun: !thread, ...(thread ? { inThread: true } : {}) } };
    case 'approval':
      return { ...pos, kind, config: { title: '', question: '' } };
    case 'condition': {
      const t = g.nodes.find((n) => n.kind === 'trigger');
      const field = t?.kind === 'trigger' && t.config.kind === 'webhook' ? 'payload.ref' : t?.kind === 'trigger' && t.config.kind === 'pr' ? 'pr.ci' : 'task.status';
      return { ...pos, kind, config: { test: 'fields', title: '', match: 'all', tests: [{ field, op: 'is', value: '' }] } };
    }
    case 'action':
      return { ...pos, kind, config: { do: 'setStatus', title: '', status: 'ready', note: '' } };
    case 'wait':
      return { ...pos, kind, config: { title: '', for: 'ciFinished', status: null, limitMin: 120 } };
  }
}

/** The first exit of `n` that leads nowhere yet, or null. */
export function firstFreeExit(n: WorkflowNode, edges: WorkflowEdge[]): string | null {
  return workflowExits(n).find((x) => !edges.some((e) => e.from === n.id && e.exit === x)) ?? null;
}

/**
 * Add a step (#262). From the header: right of the selected step, wired to its first free exit (none selected: right
 * of everything, unwired). From a dragged exit: at the drop point, wired to that exit (replacing its old link).
 */
export function addStep(g: Pick<Workflow, 'nodes' | 'edges'>, kind: AddKind, where: { from: WorkflowNode; exit?: string; at?: { x: number; y: number } } | null): { graph: Pick<Workflow, 'nodes' | 'edges'>; id: string } {
  const id = newNodeId(g.nodes);
  const at = where?.at ?? freeSpot(g.nodes, where?.from);
  const node = blankStep(kind, id, at, g);
  const exit = where ? (where.exit ?? firstFreeExit(where.from, g.edges)) : null;
  const added = { nodes: [...g.nodes, node], edges: g.edges };
  return { graph: where && exit ? wire(added, where.from.id, exit, id) : added, id };
}

/** The exits that lead into `n` (« Comes from · N exits »), with their step. */
export function incomingOf(n: Pick<WorkflowNode, 'id'>, g: Pick<Workflow, 'nodes' | 'edges'>): { exit: string; from: WorkflowNode; failing: boolean }[] {
  return g.edges.flatMap((e) => {
    const from = e.to === n.id ? g.nodes.find((x) => x.id === e.from) : undefined;
    return from ? [{ exit: e.exit, from, failing: (WORKFLOW_FAILING_EXITS as readonly string[]).includes(e.exit) }] : [];
  });
}

/** The env vars a command reads from the run (#273: every run field is one, never pasted into the text): $PAYLOAD_AFTER… */
export function runVarsOf(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(/\$\{?((?:PAYLOAD|TASK|PR|PROJECT|EVENT|RUN|WORKFLOW|STEPS|PREVIOUS)_[A-Z0-9_]*)/g)) out.add(m[1]!);
  return [...out];
}

/** The env var of a run field: payload.ref → PAYLOAD_REF (#273). */
export function envOf(field: string): string {
  return field.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** A box of `w` × `h` at `p`, moved inside `area` (the canvas): the add menu never leaves the canvas (#262). */
export function clampBox(p: { x: number; y: number }, w: number, h: number, area: { w: number; h: number }, pad = 8): { x: number; y: number } {
  return { x: Math.max(pad, Math.min(p.x, area.w - w - pad)), y: Math.max(pad, Math.min(p.y, area.h - h - pad)) };
}

/** Minutes as the Wait panel's « At most »: a number and a unit. */
export function limitParts(min: number): { n: number; unit: 'minutes' | 'hours' | 'days' } {
  if (min % 1440 === 0) return { n: min / 1440, unit: 'days' };
  if (min % 60 === 0) return { n: min / 60, unit: 'hours' };
  return { n: min, unit: 'minutes' };
}
export const UNIT_MIN = { minutes: 1, hours: 60, days: 1440 } as const;

const TRIGGER_SHORT: Record<string, string> = { time: 'At set times', task: 'Task event', pr: 'Pull request event', webhook: 'Webhook', manual: 'By hand' };
/** A node's kind line on the canvas (#262): « Action · Command », « Trigger · Webhook », « Wait ». */
export function kindLine(n: WorkflowNode): string {
  if (n.kind === 'action') return n.config.do === 'command' ? `${KIND_LABEL.action} · Command` : KIND_LABEL.action;
  if (n.kind === 'trigger') return `${KIND_LABEL.trigger} · ${TRIGGER_SHORT[n.config.kind]}`;
  return KIND_LABEL[n.kind];
}
