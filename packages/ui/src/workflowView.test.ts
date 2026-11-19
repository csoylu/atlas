import { describe, expect, it } from 'vitest';
import type { TriggerConfig, Workflow, WorkflowEdge, WorkflowNode, WorkflowRun, WorkflowRunStep } from '@atlas/shared';
import { chainOf, groupCount, listGroup, runStrip, TEMPLATES, cronOf, describeTrigger, edgePath, exitTarget, exitsOf, freeSpot, newNodeId, nodeRunState, nodeTitle, patternOf, runTask, stepOrder, takenEdges, timeDraftOf, triggerOf, wire, withoutNode , TRIGGER_KINDS, PR_EVENT_CHOICES, TASK_EVENT_CHOICES, blankTrigger, edgeLabelAt, eventChoiceOf, fieldParts, filterKeys, filterRows, groupFields, loopGuardHit, prLabel, runGets, startedBy, withEvent, withFilters } from './workflowView.ts';

const trigger: WorkflowNode = { id: 'trigger', kind: 'trigger', x: 40, y: 120, config: { kind: 'time', repeat: 'cron', cron: '0 9 * * 1-5', at: null, timezone: 'Europe/Paris' } };
const agent = (id: string, title: string, x = 300, y = 120): WorkflowNode => ({ id, kind: 'agent', x, y, config: { title, agentId: 'zurich', prompt: 'do it', newTaskEachRun: true } });
const approval: WorkflowNode = { id: 'ok', kind: 'approval', x: 560, y: 120, config: { title: 'Merge?', question: '' } };
const cond: WorkflowNode = { id: 'c', kind: 'condition', x: 560, y: 300, config: { test: 'ranFewer', title: '', node: 'v', times: 3 } };
const nodes = [trigger, agent('v', 'Validate'), approval, agent('fix', 'Fix', 300, 300), cond];
const edges: WorkflowEdge[] = [
  { from: 'trigger', exit: 'start', to: 'v' },
  { from: 'v', exit: 'done', to: 'ok' },
  { from: 'v', exit: 'failed', to: 'fix' },
  { from: 'fix', exit: 'done', to: 'c' },
  { from: 'c', exit: 'yes', to: 'v' },
];
const step = (nodeId: string, kind: WorkflowRunStep['kind'], state: WorkflowRunStep['state'], exit: string | null, round = 1, cardId: string | null = null): WorkflowRunStep => ({ id: 0, nodeId, kind, round, state, exit, cardId, summary: null, startedAt: '2026-11-18T08:00:00Z', endedAt: null, deadlineAt: null, couldntRun: null });
const run = (state: WorkflowRun['state'], steps: WorkflowRunStep[]): WorkflowRun => ({ id: 'r', workflowId: 'w', number: 1, state, trigger: 'manual', subject: null, event: null, reason: null, startedAt: '2026-11-18T08:00:00Z', endedAt: null, steps });

describe('workflow view helpers (#171)', () => {
  it('cron patterns round-trip through the trigger form', () => {
    for (const cron of ['0 9 * * 1-5', '30 18 * * *', '5 7 * * 1', '15 * * * *']) {
      const p = patternOf(cron)!;
      expect(cronOf({ ...p, cron: '' })).toBe(cron);
    }
    expect(patternOf('*/30 * * * *')).toBeNull();
    const d = timeDraftOf(trigger.config);
    expect(d).toMatchObject({ kind: 'cron', repeat: 'weekdays', time: '09:00', timezone: 'Europe/Paris' });
    expect(triggerOf(d)).toEqual(trigger.config);
    expect(describeTrigger(trigger.config as never)).toBe('Weekdays at 09:00');
    expect(describeTrigger({ kind: 'manual' })).toBe('By hand only');
    expect(describeTrigger({ kind: 'time', repeat: 'cron', cron: '*/30 * * * *', at: null, timezone: 'UTC' })).toBe('cron */30 * * * *');
  });

  it('titles fall back to what the step does', () => {
    expect(nodeTitle(agent('a', ''))).toBe('do it');
    expect(nodeTitle(cond, nodes)).toBe('Validate ran < 3 times');
  });

  it('exits: wired target or « ends the run », failing ones said', () => {
    const v = exitsOf(nodes[1]!, edges);
    expect(v).toEqual([
      { exit: 'done', to: 'ok', failing: false },
      { exit: 'failed', to: 'fix', failing: true },
    ]);
    const ok = exitsOf(approval, edges);
    expect(ok.map((x) => exitTarget(x, nodes))).toEqual(['ends the run', 'ends the run (failed)']);
    expect(exitTarget(v[1]!, nodes)).toBe('Fix');
  });

  it('step order follows the wires from the trigger, unreachable steps last', () => {
    const lone = agent('lone', 'Lone', 900, 0);
    expect(stepOrder({ nodes: [lone, ...nodes].reverse(), edges }).map((n) => n.id)).toEqual(['trigger', 'v', 'ok', 'fix', 'c', 'lone']);
    expect(chainOf({ nodes, edges })).toEqual({ steps: [nodes[1], approval], more: 2 });
    expect(chainOf({ nodes, edges }, 1).more).toBe(3);
  });

  it("a node shows its LATEST state in a run; earlier rounds stay listed", () => {
    const r = run('done', [
      step('trigger', 'trigger', 'done', 'start'),
      step('v', 'agent', 'failed', 'failed', 1, 'c_1'),
      step('fix', 'agent', 'done', 'done', 1, 'c_2'),
      step('c', 'condition', 'done', 'yes'),
      step('v', 'agent', 'done', 'done', 2, 'c_3'),
      step('ok', 'approval', 'done', 'approved', 1, 'c_4'),
    ]);
    const v = nodeRunState(r, 'v');
    expect(v.state).toBe('done'); // not the red of round 1
    expect(v.steps.map((s) => s.round)).toEqual([1, 2]);
    expect(nodeRunState(r, 'ok').state).toBe('approved');
    expect(nodeRunState(r, 'c').state).toBe('yes');
    expect(nodeRunState(r, 'lone').state).toBe('skipped');
    expect(nodeRunState(run('running', []), 'lone').state).toBe('not-reached');
    expect([...takenEdges(r)]).toEqual(['trigger:start', 'v:failed', 'fix:done', 'c:yes', 'v:done', 'ok:approved']);
    expect(runTask(r)).toBe('c_4');
    expect(runTask(run('running', [step('v', 'agent', 'running', null, 1, 'c_9'), step('x', 'agent', 'done', 'done', 1, 'c_8')]))).toBe('c_9');
    expect(runTask(null)).toBeNull();
  });

  it('edges: bezier forward, an orthogonal lane backward or down', () => {
    expect(edgePath([100, 50], [300, 60], 100, 40, 200)).toBe('M100,50 C200,50 200,60 300,60');
    // backward, target above: lane under every node
    const back = edgePath([300, 50], [100, 60], 100, 40, 200);
    expect(back.startsWith('M300,50 H304')).toBe(true);
    expect(back).toContain('V214'); // lane at bottom + 22, minus the radius
    // down: lane between the two nodes
    expect(edgePath([300, 50], [100, 260], 100, 240, 400)).toContain('V162');
  });

  it('editing: new ids, free spots, wiring replaces the exit, deleting drops its edges', () => {
    expect(newNodeId(nodes)).toBe('step1');
    expect(newNodeId([...nodes, { id: 'step1' }])).toBe('step2');
    const spot = freeSpot(nodes, nodes[1]);
    expect(spot.x).toBe(540);
    expect(nodes.some((n) => Math.abs(n.x - spot.x) < 196 && Math.abs(n.y - spot.y) < 130)).toBe(false);
    const g = wire({ nodes, edges }, 'v', 'done', 'fix');
    expect(g.edges.filter((e) => e.from === 'v' && e.exit === 'done')).toEqual([{ from: 'v', exit: 'done', to: 'fix' }]);
    expect(wire({ nodes, edges }, 'v', 'done', null).edges.some((e) => e.from === 'v' && e.exit === 'done')).toBe(false);
    const w = withoutNode({ nodes, edges }, 'fix');
    expect(w.nodes.some((n) => n.id === 'fix')).toBe(false);
    expect(w.edges.some((e) => e.from === 'fix' || e.to === 'fix')).toBe(false);
  });

  it('the list groups (#234): on, off, past one-offs; the header count; the run strip; the templates', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    const wf = (enabled: boolean, config: Extract<WorkflowNode, { kind: 'trigger' }>['config']): Workflow =>
      ({ id: 'w', name: 'W', enabled, nodes: [{ ...trigger, config }], edges: [] }) as unknown as Workflow;
    const once = (at: string) => ({ kind: 'time' as const, repeat: 'at' as const, cron: null, at, timezone: 'Europe/Paris' });
    const on = wf(true, trigger.config as never);
    const off = wf(false, trigger.config as never);
    const past = wf(false, once('2026-11-14T17:55:00Z'));
    const comingOff = wf(false, once('2026-12-01T09:00:00Z'));
    expect([on, off, past, comingOff].map((w) => listGroup(w, now))).toEqual(['on', 'off', 'past', 'off']);
    // a past one-off still on (missed while Atlas was off: it runs once at start) stays On
    expect(listGroup(wf(true, once('2026-11-14T17:55:00Z')), now)).toBe('on');
    expect(groupCount([on, on, off, past], now)).toBe('2 on · 1 off · 1 past');
    expect(groupCount([on], now)).toBe('1 on');
    expect(groupCount([], now)).toBe('');

    expect(runStrip(['done', 'failed'], 4)).toEqual([null, null, 'done', 'failed']);
    expect(runStrip(['done', 'done', 'failed', 'waiting', 'running'], 3)).toEqual(['failed', 'waiting', 'running']);

    expect(TEMPLATES.map((t) => t.name)).toEqual(['Morning report', 'Weekly check', 'Task with your OK']);
    const g = TEMPLATES[2]!.build(['munih', 'zurich']);
    expect(chainOf(g).steps.map((n) => n.kind)).toEqual(['agent', 'approval', 'agent']);
    expect(g.nodes.filter((n) => n.kind === 'agent').map((n) => (n.config as { agentId: string | null }).agentId)).toEqual(['munih', 'zurich']);
    expect(TEMPLATES[0]!.build([]).nodes[1]!.config).toMatchObject({ agentId: null });
  });
});


describe('Workflows v2 stage 1 (#259)', () => {
  type Ev = Extract<TriggerConfig, { kind: 'task' | 'pr' }>;
  const pr: Ev = { kind: 'pr', event: 'ci_finished', repo: '', base: '', result: 'failure', status: [], assignee: [], maxRunsPerHour: 5 };
  const task: Ev = { kind: 'task', event: 'status_changed', from: ['ready'], status: ['review'], assignee: ['zurich'], maxRunsPerHour: 3 };

  it('the trigger picker has the five triggers in the mockup order, webhook before by hand (#260)', () => {
    expect(TRIGGER_KINDS.map((k) => k.kind)).toEqual(['time', 'task', 'pr', 'webhook', 'manual']);
  });

  it('CI buttons map to ci_finished with a result, and back', () => {
    expect(eventChoiceOf(pr)).toBe('ci_red');
    const green = withEvent(pr, PR_EVENT_CHOICES.find((c) => c.key === 'ci_green')!);
    expect(green).toMatchObject({ event: 'ci_finished', result: 'success' });
    expect(eventChoiceOf(green)).toBe('ci_green');
    expect(withEvent(pr, PR_EVENT_CHOICES.find((c) => c.key === 'merged')!)).toMatchObject({ event: 'merged', result: '' });
    expect(describeTrigger(pr)).toBe('When CI turns red on a PR');
  });

  it('a task event keeps its filters, drops « from » off status_changed', () => {
    const blocked = withEvent(task, TASK_EVENT_CHOICES.find((c) => c.key === 'blocked')!);
    expect(blocked).toMatchObject({ event: 'blocked', from: [], status: ['review'], assignee: ['zurich'], maxRunsPerHour: 3 });
  });

  it('a new trigger kind keeps the loop guard', () => {
    expect(blankTrigger('pr', task)).toMatchObject({ kind: 'pr', maxRunsPerHour: 3 });
    expect(blankTrigger('manual', task)).toEqual({ kind: 'manual' });
  });

  it('« Only if » rows round-trip, several values of one field, empty rows dropped', () => {
    const rows = filterRows(task);
    expect(rows).toEqual([
      { key: 'from', value: 'ready' },
      { key: 'status', value: 'review' },
      { key: 'assignee', value: 'zurich' },
    ]);
    const more = withFilters(task, [...rows, { key: 'status', value: 'blocked' }, { key: 'assignee', value: '' }, { key: 'repo', value: 'x/y' }]);
    expect(more).toMatchObject({ status: ['review', 'blocked'], assignee: ['zurich'], from: ['ready'] });
    expect(more).not.toHaveProperty('repo');
    expect(withFilters(pr, [{ key: 'base', value: 'main' }, { key: 'result', value: 'success' }])).toMatchObject({ base: 'main', result: 'failure' });
    expect(filterKeys(task)).toContain('from');
    expect(filterKeys({ ...task, event: 'created' })).not.toContain('from');
  });

  it('the run gets what its trigger brings', () => {
    expect(runGets(pr, true)).toEqual(['project', 'pr', 'task']);
    expect(runGets({ kind: 'manual' }, false)).toEqual(['task', 'pr']);
  });

  it('fields group in the picker order and split into chips', () => {
    const g = groupFields([
      { field: 'run.id', label: 'Run id' },
      { field: 'task.title', label: 'Task title' },
      { field: 'steps.v.summary', label: 'summary' },
      { field: 'pr.url', label: 'PR link' },
    ]);
    expect(g.map((x) => x.label)).toEqual(['Task', 'Pull request', 'Earlier steps', 'This run']);
    expect(groupFields([{ field: 'task.title', label: 'Task title' }, { field: 'pr.url', label: 'PR link' }], 'link').map((x) => x.label)).toEqual(['Pull request']);
    expect(fieldParts('Review {{pr.url}} for {{ task.ref }}.')).toEqual([
      { text: 'Review ', field: false },
      { text: '{{pr.url}}', field: true },
      { text: ' for ', field: false },
      { text: '{{ task.ref }}', field: true },
      { text: '.', field: false },
    ]);
  });

  it('a backward edge gets a label in its lane, a forward one none', () => {
    expect(edgeLabelAt([200, 50], [300, 50], 100, 0, 400)).toBeNull();
    expect(edgeLabelAt([500, 50], [40, 300], 100, 260, 400)).toEqual([269, 180]);
    expect(edgeLabelAt([500, 300], [40, 50], 400, 0, 400)?.[1]).toBe(422);
  });

  it('what started a run, the PR label, the loop guard', () => {
    expect(startedBy({ trigger: 'task', event: 'review_requested' })).toBe('asks for review');
    expect(startedBy({ trigger: 'manual', event: null })).toBe('by hand');
    expect(prLabel('https://github.com/csoylu/atlas/pull/74')).toBe('PR #74');
    expect(loopGuardHit({ enabled: false, lastError: 'loop guard: 6 runs on #12 in an hour' })).toBe(true);
    expect(loopGuardHit({ enabled: true, lastError: null })).toBe(false);
  });
});
