import { cardRef, WORKFLOW_EXITS, type Card, WORKFLOW_FAILING_EXITS, type TriggerConfig, type Workflow, type WorkflowEdge, type WorkflowNode, type WorkflowNodeKind, type WorkflowRun, type WorkflowRunStep } from '@atlas/shared';

/**
 * Pure helpers of the Workflows page and canvas (#171, mockup /api/files/paris/pages/workflows-165.html): titles and
 * one-line descriptions of steps, the order of the steps (phone list, list chains), what each node shows in a run,
 * the SVG path of an edge, and the trigger form's cron patterns (moved from the Schedules page).
 */

export const KIND_LABEL: Record<WorkflowNodeKind, string> = { trigger: 'Trigger', agent: 'Agent step', approval: 'Approval', condition: 'Condition' };
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

/** « Weekdays at 09:00 », « Every Monday at 18:30 », « Once, … », « By hand only »… or the cron itself. */
export function describeTrigger(t: TriggerConfig): string {
  if (t.kind === 'manual') return 'By hand only';
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
  }
}

function conditionText(c: Extract<WorkflowNode, { kind: 'condition' }>['config'], nodes: WorkflowNode[]): string {
  if (c.test === 'summaryContains') return `Previous summary has « ${c.text} »`;
  const counted = nodes.find((x) => x.id === c.node);
  return `${counted ? nodeTitle(counted, []) : c.node} ran < ${c.times} times`;
}

/** The faint line under a step's title. */
export function nodeMeta(n: WorkflowNode, nodes: WorkflowNode[] = []): string {
  switch (n.kind) {
    case 'trigger':
      return n.config.kind === 'time' ? `At set times · ${n.config.timezone}` : 'Run now, from here or a chat';
    case 'agent':
      return n.config.agentId ? `@${n.config.agentId} · ${n.config.newTaskEachRun ? 'new task' : 'one task'}` : 'Pick an agent and a prompt';
    case 'approval':
      return 'You, in the Inbox';
    case 'condition':
      return n.config.title ? conditionText(n.config, nodes) : n.config.test === 'ranFewer' ? 'Counts the rounds' : 'Reads the previous summary';
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
  return (WORKFLOW_EXITS[n.kind] as readonly string[]).map((exit) => ({
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
export type NodeRunState = 'working' | 'waiting' | 'done' | 'failed' | 'approved' | 'rejected' | 'yes' | 'no' | 'stopped' | 'skipped' | 'not-reached';

export function stepState(s: WorkflowRunStep): Exclude<NodeRunState, 'skipped' | 'not-reached'> {
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
  if (s === 'failed' || s === 'rejected') return 'bad';
  if (s === 'skipped') return 'skip';
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
  const lane = r1(dstTop > srcBottom ? (srcBottom + dstTop) / 2 : bottom + 22);
  const x1 = r1(ax + 12);
  const x2 = r1(bx - 14);
  const r = 8;
  const up = by < lane;
  return (
    `M${ax},${ay} H${x1 - r} Q${x1},${ay} ${x1},${ay + r} V${lane - r} Q${x1},${lane} ${x1 - r},${lane}` +
    ` H${x2 + r} Q${x2},${lane} ${x2},${lane + (up ? -r : r)} V${by + (up ? r : -r)} Q${x2},${by} ${x2 + r},${by} H${bx}`
  );
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
