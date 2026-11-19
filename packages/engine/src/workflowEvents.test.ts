import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateWorkflow, WorkflowNodeInput } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { Workflows, MAX_CHAIN } from './workflows.ts';
import { prEvents, type GhPr } from './prs.ts';
import type { CardPr } from '@atlas/shared';

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

/** An engine with no dispatcher (tasks stay where they are put) and a Workflows on a controllable clock. */
async function setup(o: { dbFile?: string; dataDir?: string } = {}) {
  const engine = await startEngine({
    memoryReview: false,
    dbFile: o.dbFile ?? ':memory:',
    dataDir: o.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    dispatch: false,
    providers: () => new FakeProvider([]),
    env: {},
  });
  engines.push(engine);
  const clock = { now: new Date('2026-11-19T09:00:00Z') };
  const wf = new Workflows(engine.db, engine.bus, engine.kanban, () => clock.now);
  return { engine, wf, clock, k: engine.kanban };
}

const trigger = (config: object): WorkflowNodeInput => ({ id: 'trigger', kind: 'trigger', x: 0, y: 0, config: config as never });
const agent = (id: string, prompt: string, more: object = {}): WorkflowNodeInput => ({ id, kind: 'agent', x: 0, y: 0, config: { agentId: 'atlas', prompt, newTaskEachRun: true, ...more } });
const edge = (from: string, exit: string, to: string) => ({ from, exit, to });
const onTask = (config: object, prompt = 'Look at {{task.ref}} « {{task.title}} » ({{event.from}} → {{event.to}}) in {{project.name}}', more: Partial<CreateWorkflow> = {}): CreateWorkflow => ({
  name: 'On task',
  nodes: [trigger({ kind: 'task', ...config }), agent('look', prompt, { title: 'Look' })],
  edges: [edge('trigger', 'start', 'look')],
  ...more,
});
const events = (e: Engine) => (e.db.prepare('SELECT COUNT(*) AS n FROM workflow_events').get() as { n: number }).n;

describe('workflow task and PR events (#258, design §9)', () => {
  it('a task event fires a matching workflow once, with the task in its context; a filtered-out one does not fire', async () => {
    const { engine, wf, k } = await setup();
    const review = wf.create(onTask({ event: 'status_changed', status: ['review'] }), 'user');
    const done = wf.create({ ...onTask({ event: 'done', assignee: ['atlas'] }), name: 'On done' }, 'user');
    const created = wf.create({ ...onTask({ event: 'created' }), name: 'On created' }, 'user');
    const c = k.create({ title: 'Ship the thing', status: 'ready', assignee: 'atlas' }, 'user');
    k.update(c.id, { status: 'running' }, 'dispatcher');
    k.update(c.id, { status: 'review' }, 'atlas');
    wf.tick();
    expect(events(engine)).toBe(0); // consumed
    expect(wf.runs(done.id)).toEqual([]);
    const onC = () => wf.runs(created.id).filter((r) => r.subject?.cardId === c.id);
    expect(onC()).toMatchObject([{ trigger: 'task', event: 'created', subject: { cardId: c.id, prUrl: null }, state: 'running' }]);
    const [run] = wf.runs(review.id);
    expect(run).toMatchObject({ trigger: 'task', event: 'status_changed', subject: { cardId: c.id }, state: 'running' });
    const step = wf.run(run!.id).steps!.find((s) => s.nodeId === 'look')!;
    expect(k.get(step.cardId!).body).toContain(`Look at ${k.ref(c.id)} « Ship the thing » (running → review) in Atlas`);
    expect(wf.run(run!.id).steps![0]!.summary).toBe(`task event « status_changed » on ${k.ref(c.id)} (running → review)`);
    expect(wf.context(run!.id).fields).toMatchObject({ 'task.id': c.id, 'task.status': 'review', 'event.by': 'atlas', 'project.name': 'Atlas' });
    // A tick more fires nothing more: the event was consumed once.
    wf.tick();
    expect(wf.runs(review.id)).toHaveLength(1);
    expect(onC()).toHaveLength(1);
    // « On created » fires on the task « On task »'s step made (another workflow's), never on its own step's task.
    const ownSteps = wf.runs(created.id).flatMap((r) => wf.run(r.id).steps!.flatMap((s) => (s.cardId ? [s.cardId] : [])));
    expect(wf.runs(created.id).filter((r) => ownSteps.includes(r.subject!.cardId))).toEqual([]);

    // Done by someone else, assignee filter matches: fires.
    k.update(c.id, { status: 'done' }, 'zurich');
    wf.tick();
    expect(wf.runs(done.id)).toMatchObject([{ event: 'done', subject: { cardId: c.id } }]);
    // An assignee filter that does not match.
    const d = k.create({ title: 'Other', status: 'ready', assignee: null }, 'user');
    k.update(d.id, { status: 'done' }, 'user');
    wf.tick();
    expect(wf.runs(done.id)).toHaveLength(1);
    // Off: no event is even written.
    wf.update(review.id, { enabled: false });
    wf.update(created.id, { enabled: false });
    wf.update(done.id, { enabled: false });
    k.create({ title: 'Quiet', status: 'ready' }, 'user');
    expect(events(engine)).toBe(0);
  });

  it('blocked, assignee changed and asked for review are events too; the status-from filter narrows status_changed', async () => {
    const { wf, k } = await setup();
    const blocked = wf.create({ ...onTask({ event: 'blocked' }, 'Unblock {{task.ref}}: {{event.text}}'), name: 'B' }, 'user');
    const moved = wf.create({ ...onTask({ event: 'assignee_changed' }, 'Now {{task.assignee}}'), name: 'A' }, 'user');
    const fromRunning = wf.create({ ...onTask({ event: 'status_changed', from: ['running'] }, 'From running'), name: 'F' }, 'user');
    const c = k.create({ title: 'x', status: 'ready', assignee: 'atlas' }, 'user');
    k.block(c.id, { kind: 'needs_input', reason: 'which colour?' }, 'atlas');
    k.update(c.id, { assignee: null }, 'user');
    wf.tick();
    const b = wf.runs(blocked.id)[0]!;
    expect(k.get(wf.run(b.id).steps![1]!.cardId!).body).toContain('Unblock ' + k.ref(c.id) + ': which colour?');
    expect(wf.runs(moved.id)).toHaveLength(1);
    expect(wf.runs(fromRunning.id)).toEqual([]); // ready → blocked
  });

  it('project scoping: a project workflow sees only its project, a global one every project', async () => {
    const { engine, wf, k } = await setup();
    const datinel = engine.projects.create({ name: 'Datinel', repo: null, lead: 'atlas', members: [] });
    const scoped = wf.create({ ...onTask({ event: 'created' }), name: 'Datinel only', projectId: datinel.id }, 'user');
    const global = wf.create({ ...onTask({ event: 'created' }, 'Any {{task.ref}} of {{project.name}}'), name: 'Global', projectId: null }, 'user');
    const a = k.create({ title: 'in atlas', status: 'todo' }, 'user');
    const d = k.create({ title: 'in datinel', status: 'todo', projectId: datinel.id }, 'user');
    wf.tick();
    expect(wf.runs(scoped.id).map((r) => r.subject?.cardId)).toEqual([d.id]);
    expect(wf.runs(global.id).map((r) => r.subject?.cardId).filter((x) => x === a.id || x === d.id).sort()).toEqual([a.id, d.id].sort());
    // The scoped workflow's step task is in Datinel too (the workflow's project).
    const step = wf.run(wf.runs(scoped.id)[0]!.id).steps!.at(-1)!;
    expect(k.get(step.cardId!).projectId).toBe(datinel.id);
  });

  it('fills {{fields}} from the run context and fails the step loudly on an unknown or missing field', async () => {
    const { wf, k } = await setup();
    const bad = wf.create({ ...onTask({ event: 'created' }, 'Hello {{task.titel}}'), name: 'Typo' }, 'user');
    const noPr = wf.create({ ...onTask({ event: 'created' }, 'Review {{pr.url}}'), name: 'No PR' }, 'user');
    const c = k.create({ title: 'x', status: 'todo' }, 'user');
    wf.tick();
    const r1 = wf.runs(bad.id)[0]!;
    expect(r1).toMatchObject({ state: 'failed', reason: expect.stringContaining('unknown field {{task.titel}}') });
    expect(wf.run(r1.id).steps!.at(-1)).toMatchObject({ nodeId: 'look', state: 'failed', exit: 'failed' });
    expect(wf.runs(noPr.id)[0]).toMatchObject({ state: 'failed', reason: expect.stringContaining('{{pr.url}}: this run has no pull request') });
    // Fields offered at a step, with the latest value seen.
    const fields = wf.fields(bad.id, 'look');
    expect(fields.find((f) => f.field === 'task.ref')).toMatchObject({ optional: false, example: k.ref(c.id) });
    expect(fields.filter((f) => f.field.startsWith('pr.')).every((f) => f.optional)).toBe(true); // the task's latest PR, if any (#261)
    expect(fields.some((f) => f.field.startsWith('steps.'))).toBe(false); // nothing comes before the first step
  });

  it('earlier steps: {{steps.<id>.summary}} and .exit in a later step; the context lists them', async () => {
    const { wf, k } = await setup();
    const w = wf.create(
      {
        name: 'Two steps',
        nodes: [trigger({ kind: 'manual' }), agent('a', 'First on {{task.ref}}'), agent('b', 'Then: {{steps.a.summary}} ({{steps.a.exit}}, {{steps.a.task}})')],
        edges: [edge('trigger', 'start', 'a'), edge('a', 'done', 'b')],
      },
      'user',
    );
    const c = k.create({ title: 'subject', status: 'todo' }, 'user');
    const run = wf.runNow(w.id, { task: k.ref(c.id) });
    expect(run).toMatchObject({ trigger: 'manual', subject: { cardId: c.id } });
    const a = wf.run(run.id).steps!.find((s) => s.nodeId === 'a')!;
    expect(k.get(a.cardId!).body).toContain('First on ' + k.ref(c.id));
    // Fields at step b include a's.
    expect(wf.fields(w.id, 'b').map((f) => f.field)).toEqual(expect.arrayContaining(['steps.a.summary', 'steps.a.exit', 'task.title', 'pr.url']));
    expect(wf.onTask(c.id)).toMatchObject([{ workflowId: w.id, runNumber: 1, state: 'running', step: { nodeId: 'a', state: 'running', cardId: a.cardId } }]);
    expect(wf.onTask(a.cardId!)).toMatchObject([{ workflowId: w.id }]); // the step's own task too
    k.event(a.cardId!, 'completed', { by: 'atlas', summary: 'all green' });
    k.update(a.cardId!, { status: 'done' }, 'atlas', 'all green');
    wf.tick();
    const b = wf.run(run.id).steps!.find((s) => s.nodeId === 'b')!;
    expect(k.get(b.cardId!).body).toContain(`Then: all green (done, ${k.ref(a.cardId!)})`);
    expect(wf.context(run.id).fields).toMatchObject({ 'steps.a.summary': 'all green', 'steps.a.exit': 'done', 'task.title': 'subject' });
    // A manual run on a task that does not exist, or a PR linked to none.
    expect(() => wf.runNow(w.id, { task: '#9999' })).toThrow(/task #9999 does not exist/);
    expect(() => wf.runNow(w.id, { pr: 'https://github.com/csoylu/atlas/pull/1' })).toThrow(/not linked to a task/);
  });

  it('several workflows run on one task; one at a time per task for each, the next event while one runs is skipped', async () => {
    const { wf, k } = await setup();
    const w1 = wf.create({ ...onTask({ event: 'status_changed' }, 'One {{task.ref}}'), name: 'One' }, 'user');
    const w2 = wf.create({ ...onTask({ event: 'status_changed' }, 'Two {{task.ref}}'), name: 'Two' }, 'user');
    const c = k.create({ title: 'x', status: 'todo' }, 'user');
    const other = k.create({ title: 'y', status: 'todo' }, 'user');
    k.update(c.id, { status: 'ready' }, 'user');
    k.update(other.id, { status: 'ready' }, 'user');
    wf.tick();
    expect(wf.onTask(c.id).map((t) => t.workflowName).sort()).toEqual(['One', 'Two']);
    expect(wf.runs(w1.id).filter((r) => r.state === 'running')).toHaveLength(2); // one per task
    k.update(c.id, { status: 'todo' }, 'user');
    wf.tick();
    expect(wf.runs(w1.id).filter((r) => r.state === 'skipped')).toMatchObject([{ subject: { cardId: c.id }, reason: expect.stringContaining('was still going on') }]);
    expect(wf.runs(w2.id)).toHaveLength(3);
  });

  it('loop guard: the 6th run on the same task in an hour turns the workflow off with the reason and one Inbox item', async () => {
    const { engine, wf, clock, k } = await setup();
    const w = wf.create({ ...onTask({ event: 'status_changed' }, 'Ping {{task.ref}}'), name: 'Pinger' }, 'user');
    const c = k.create({ title: 'x', status: 'todo' }, 'user');
    const flip = (i: number) => {
      k.update(c.id, { status: i % 2 ? 'todo' : 'ready' }, 'user');
      wf.tick();
      // End the run so the next event can start one (a skipped run doesn't count).
      for (const r of wf.runs(w.id).filter((x) => x.state === 'running')) wf.stopRun(r.id, 'user');
      clock.now = new Date(clock.now.getTime() + 60_000);
    };
    for (let i = 0; i < 5; i++) flip(i);
    expect(wf.get(w.id)).toMatchObject({ enabled: true });
    flip(5);
    expect(wf.runs(w.id).filter((r) => r.state !== 'skipped')).toHaveLength(5);
    expect(wf.get(w.id)).toMatchObject({ enabled: false, lastError: expect.stringContaining(`loop guard: 5 runs on ${k.ref(c.id)} in the last hour (at most 5)`) });
    flip(6);
    const items = engine.db.prepare("SELECT title, card_id FROM notifications WHERE kind = 'workflow.stopped'").all();
    expect(items).toEqual([{ title: 'Workflow « Pinger » turned off', card_id: c.id }]);
    // Turned back on (#259): the loop guard's reason is answered and cleared.
    expect(wf.update(w.id, { enabled: true })).toMatchObject({ enabled: true, lastError: null });
  });

  it('a per-workflow guard number, counted per task: another task still runs', async () => {
    const { wf, k } = await setup();
    const w = wf.create({ ...onTask({ event: 'status_changed', maxRunsPerHour: 1 }, 'x {{task.ref}}'), name: 'Once' }, 'user');
    const a = k.create({ title: 'a', status: 'todo' }, 'user');
    const b = k.create({ title: 'b', status: 'todo' }, 'user');
    k.update(a.id, { status: 'ready' }, 'user');
    wf.tick();
    for (const r of wf.runs(w.id)) wf.stopRun(r.id, 'user');
    k.update(b.id, { status: 'ready' }, 'user');
    wf.tick();
    expect(wf.get(w.id).enabled).toBe(true);
    for (const r of wf.runs(w.id).filter((x) => x.state === 'running')) wf.stopRun(r.id, 'user');
    k.update(a.id, { status: 'todo' }, 'user');
    wf.tick();
    expect(wf.get(w.id)).toMatchObject({ enabled: false, lastError: expect.stringContaining('at most 1') });
  });

  it('a workflow whose own step changes tasks does not fire itself for ever', async () => {
    const { wf, k } = await setup();
    // On every status change, a one-task step (reopened each run): its own task's moves are its own doing.
    const w = wf.create({ ...onTask({ event: 'status_changed' }, 'React to {{task.ref}}', { name: 'Self' }) }, 'user');
    wf.saveGraph(w.id, { revision: wf.get(w.id).revision, nodes: [trigger({ kind: 'task', event: 'status_changed' }), agent('look', 'React to {{task.ref}}', { newTaskEachRun: false })], edges: [edge('trigger', 'start', 'look')] });
    const c = k.create({ title: 'x', status: 'todo' }, 'user');
    k.update(c.id, { status: 'ready' }, 'user');
    wf.tick();
    const [run] = wf.runs(w.id);
    const step = wf.run(run!.id).steps!.at(-1)!;
    // The step's agent works its task and finishes: its status moves, nothing fires.
    k.update(step.cardId!, { status: 'running' }, 'dispatcher');
    k.event(step.cardId!, 'completed', { by: 'atlas', summary: 'reacted' });
    k.update(step.cardId!, { status: 'done' }, 'atlas', 'reacted');
    wf.tick();
    expect(wf.runs(w.id)).toHaveLength(1);
    expect(wf.runs(w.id)[0]!.state).toBe('done');
    // An action of the run itself (by « workflow:<id> ») on the subject: no new run either.
    k.update(c.id, { status: 'todo' }, 'workflow:' + w.id);
    wf.tick();
    expect(wf.runs(w.id)).toHaveLength(1);
  });

  it('two workflows feeding each other through their step tasks stop at the chain limit', async () => {
    const { wf, k } = await setup();
    // A fires on any task created; its step creates a task, which fires B, whose step task fires A…
    const a = wf.create({ ...onTask({ event: 'created', maxRunsPerHour: 100 }, 'A on {{task.ref}}'), name: 'A' }, 'user');
    const b = wf.create({ ...onTask({ event: 'created', maxRunsPerHour: 100 }, 'B on {{task.ref}}'), name: 'B' }, 'user');
    k.create({ title: 'seed', status: 'todo' }, 'user');
    for (let i = 0; i < 20; i++) wf.tick();
    const off = [wf.get(a.id), wf.get(b.id)].filter((w) => !w.enabled);
    expect(off.length).toBeGreaterThan(0);
    expect(off[0]!.lastError).toContain(`at most ${MAX_CHAIN}`);
    const total = wf.runs(a.id).length + wf.runs(b.id).length;
    expect(total).toBeLessThan(4 * (MAX_CHAIN + 2));
  });

  it('PR events: linked (opened), CI finished, conflict, validated, merged; filters on repo and result', async () => {
    const { engine, wf, k } = await setup();
    const prWf = (event: string, more: object = {}, name = event) =>
      wf.create({ name, nodes: [trigger({ kind: 'pr', event, ...more }), agent('look', 'PR {{pr.url}} ({{pr.repo}}) of {{task.ref}}: {{event.result}}')], edges: [edge('trigger', 'start', 'look')] }, 'user');
    const opened = prWf('opened');
    const green = prWf('ci_finished', { result: 'success' }, 'green');
    const elsewhere = prWf('merged', { repo: 'datinel/datinel' }, 'elsewhere');
    const c = k.create({ title: 'feature', status: 'ready', assignee: 'atlas' }, 'user');
    const url = 'https://github.com/csoylu/atlas/pull/41';
    k.requestReview(c.id, [url], 'atlas', 'done');
    wf.tick();
    const [o] = wf.runs(opened.id);
    expect(o).toMatchObject({ trigger: 'pr', subject: { cardId: c.id, prUrl: url }, event: 'opened' });
    // CI result read from GitHub: the PR event is written with the read.
    const pr = (over: Partial<GhPr> = {}): GhPr => ({ state: 'open', mergeSha: null, headSha: 'a1', branch: 'feat/x', base: 'main', mergeable: true, ci: 'success', qa: null, qaDescription: null, ...over });
    const rec = (before: Partial<CardPr>, got: GhPr) => prEvents({ headSha: 'a1', ci: 'pending', mergeable: true, qa: null, state: 'open', ...before } as CardPr, got).map((e) => e.name + (e.result ? ':' + e.result : ''));
    expect(rec({}, pr())).toEqual(['ci_finished:success']);
    expect(rec({ ci: 'success' }, pr())).toEqual([]);
    expect(rec({ ci: 'success' }, pr({ headSha: 'b2', ci: 'pending', mergeable: false }))).toEqual(['pushed', 'conflict']);
    expect(rec({ ci: 'success' }, pr({ qa: 'failure' }))).toEqual(['validated:failure']);
    expect(rec({ ci: 'success', qa: 'success' }, pr({ qa: 'success', state: 'merged' }))).toEqual(['merged']);
    expect(rec({ headSha: null }, pr({ headSha: 'a1', ci: 'failure' }))).toEqual(['ci_finished:failure']); // first read

    const { recordPrEvent } = await import('./workflowEvents.ts');
    const snap = { url, repo: 'csoylu/atlas', number: 41, branch: 'feat/x', base: 'main', head: 'a1', state: 'open', ci: 'success' };
    engine.db.transaction(() => {
      recordPrEvent(engine.db, c.id, 'ci_finished', snap, { result: 'failure' });
      recordPrEvent(engine.db, c.id, 'ci_finished', snap, { result: 'success' });
      recordPrEvent(engine.db, c.id, 'merged', { ...snap, state: 'merged' });
    })();
    wf.tick();
    const runs = wf.runs(green.id);
    expect(runs).toHaveLength(1);
    expect(k.get(wf.run(runs[0]!.id).steps!.at(-1)!.cardId!).body).toContain(`PR ${url} (csoylu/atlas) of ${k.ref(c.id)}: success`);
    expect(wf.runs(elsewhere.id)).toEqual([]);
    // A manual run on the PR.
    const m = wf.runNow(opened.id, { pr: url });
    expect(m).toMatchObject({ trigger: 'manual', subject: { cardId: c.id, prUrl: url } });
  });

  it('API: run on a task, its context, the fields at a step, the workflows on a task', async () => {
    const { engine, k } = await setup();
    const w = engine.workflows.create({ name: 'By hand', nodes: [trigger({ kind: 'manual' }), agent('look', 'On {{task.ref}}')], edges: [edge('trigger', 'start', 'look')] }, 'user');
    const c = k.create({ title: 'api', status: 'todo' }, 'user');
    const post = await fetch(`${engine.url}/api/workflows/${w.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: k.ref(c.id) }) });
    const run = (await post.json()) as { id: string; subject: { cardId: string } };
    expect(run.subject.cardId).toBe(c.id);
    const ctx = (await (await fetch(`${engine.url}/api/workflow-runs/${run.id}/context`)).json()) as { fields: Record<string, string> };
    expect(ctx.fields['task.title']).toBe('api');
    const fields = (await (await fetch(`${engine.url}/api/workflows/${w.id}/fields?node=look`)).json()) as { field: string; optional: boolean }[];
    expect(fields.find((f) => f.field === 'task.title')).toMatchObject({ optional: true });
    const on = (await (await fetch(`${engine.url}/api/cards/${encodeURIComponent(k.ref(c.id))}/workflows`)).json()) as { workflowName: string }[];
    expect(on).toMatchObject([{ workflowName: 'By hand' }]);
    const bad = await fetch(`${engine.url}/api/workflows/${w.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: '#1', pr: 'x' }) });
    expect(bad.status).toBe(400);
  });

  it('an event written before a kill starts its run at the next start, once; a run started by an event resumes after a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-wfev-'));
    const dbFile = join(dataDir, 'atlas.db');
    const first = await setup({ dbFile, dataDir });
    const w = first.wf.create(onTask({ event: 'created' }), 'user');
    const c = first.k.create({ title: 'before the kill', status: 'todo' }, 'user');
    expect(events(first.engine)).toBe(1); // written with the task, no tick yet
    await first.engine.stop();
    engines = [];

    const second = await setup({ dbFile, dataDir });
    second.wf.tick();
    second.wf.tick();
    const runs = second.wf.runs(w.id);
    expect(runs).toMatchObject([{ state: 'running', subject: { cardId: c.id } }]);
    expect(events(second.engine)).toBe(0);
    const step = second.wf.run(runs[0]!.id).steps!.at(-1)!;
    await second.engine.stop();
    engines = [];

    // Mid-run: the step's task finishes while Atlas is off; the next start ends the run from what it finds.
    const third = await setup({ dbFile, dataDir });
    third.engine.db.transaction(() => {
      third.k.event(step.cardId!, 'completed', { by: 'atlas', summary: 'looked' });
      third.k.update(step.cardId!, { status: 'done' }, 'atlas', 'looked');
    })();
    third.wf.tick();
    expect(third.wf.runs(w.id)).toMatchObject([{ state: 'done' }]);
    expect(third.wf.context(runs[0]!.id).fields).toMatchObject({ 'task.title': 'before the kill', 'steps.look.summary': 'looked' });
  });
});
