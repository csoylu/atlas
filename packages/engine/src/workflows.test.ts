import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { ContentBlock, CreateWorkflow, WorkflowNodeInput } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { runTeamTool } from './teamTools.ts';
import { migrate } from './store/db.ts';
import { Bus } from './events.ts';
import { Kanban } from './kanban.ts';
import { oneStep, upcoming, Workflows } from './workflows.ts';
import { eventually } from '../test/kit/index.ts';

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

/** An engine (dispatcher off: tasks stay where the workflow puts them) and a Workflows on a controllable clock. */
async function setup(start = '2026-11-10T07:00:00Z', dbFile = ':memory:') {
  const engine = await startEngine({ dbFile, dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, providers: () => new FakeProvider([]), env: {} });
  engines.push(engine);
  const clock = { now: new Date(start) };
  const wf = new Workflows(engine.db, engine.bus, engine.kanban, () => clock.now);
  return { engine, wf, clock, at: (iso: string) => (clock.now = new Date(iso)) };
}

const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input });

const paris9 = { kind: 'time' as const, repeat: 'cron' as const, cron: '0 9 * * 1-5', timezone: 'Europe/Paris' };
const trigger = (config: object = paris9): WorkflowNodeInput => ({ id: 'trigger', kind: 'trigger', x: 0, y: 0, config: config as never });
const agent = (id: string, prompt: string, more: object = {}): WorkflowNodeInput => ({ id, kind: 'agent', x: 0, y: 0, config: { agentId: 'atlas', prompt, ...more } });
const edge = (from: string, exit: string, to: string) => ({ from, exit, to });

/** trigger → build; build failed → fix; fix done → guard (fix ran fewer than 2 times?) yes → build, no → ask; ask approved → ship. */
const pipeline = (): CreateWorkflow => ({
  name: 'Build and ship',
  nodes: [
    trigger({ kind: 'manual' }),
    agent('build', 'Build it. Last fix: {{previous.summary}} in {{previous.task}} (run {{run.id}})', { title: 'Build' }),
    agent('fix', 'Fix what failed: {{previous.summary}}', { title: 'Fix', newTaskEachRun: true }),
    { id: 'guard', kind: 'condition', x: 0, y: 0, config: { test: 'ranFewer', node: 'fix', times: 2 } },
    { id: 'ask', kind: 'approval', x: 0, y: 0, config: { title: 'Ship anyway?', question: 'The build still fails after 2 fixes: {{previous.summary}}. Ship anyway?' } },
    agent('ship', 'Ship it.', { title: 'Ship', newTaskEachRun: true }),
  ],
  edges: [edge('trigger', 'start', 'build'), edge('build', 'failed', 'fix'), edge('fix', 'done', 'guard'), edge('guard', 'yes', 'build'), edge('guard', 'no', 'ask'), edge('ask', 'approved', 'ship'), edge('build', 'done', 'ship')],
});

describe('workflows (#170, design §9)', () => {
  it('computes cron times in the trigger time zone', () => {
    expect(upcoming({ kind: 'cron', cron: '0 9 * * 1-5', at: null, timezone: 'Europe/Paris' }, new Date('2026-11-14T10:00:00Z'), 2)).toEqual(['2026-11-16T08:00:00.000Z', '2026-11-17T08:00:00.000Z']);
  });

  it('refuses invalid graphs with the reason', async () => {
    const { wf } = await setup();
    const base = { name: 'x', nodes: [trigger(), agent('a', 'go')], edges: [edge('trigger', 'start', 'a')] };
    expect(() => wf.create({ ...base, nodes: [agent('a', 'go')], edges: [] }, 'user')).toThrow(/needs a trigger/);
    expect(() => wf.create({ ...base, nodes: [...base.nodes, { ...trigger(), id: 't2' }] }, 'user')).toThrow(/exactly one trigger/);
    expect(() => wf.create({ ...base, edges: [edge('trigger', 'start', 'ghost')] }, 'user')).toThrow(/goes to step ghost, which does not exist/);
    expect(() => wf.create({ ...base, edges: [edge('a', 'yes', 'a')] }, 'user')).toThrow(/has no exit « yes »/);
    expect(() => wf.create({ ...base, edges: [edge('trigger', 'start', 'a'), edge('trigger', 'start', 'a')] }, 'user')).toThrow(/linked twice/);
    expect(() => wf.create({ ...base, nodes: [trigger(), agent('a', 'go', { agentId: 'ghost' })] }, 'user')).toThrow(/agent @ghost does not exist/);
    expect(() => wf.create({ ...base, nodes: [trigger({ ...paris9, cron: '61 * * * *' }), agent('a', 'go')] }, 'user')).toThrow(/cron "61/);
    expect(() => wf.create({ ...base, nodes: [trigger({ ...paris9, timezone: 'Mars/Olympus' }), agent('a', 'go')] }, 'user')).toThrow(/unknown time zone/);
    expect(() => wf.create({ ...base, nodes: [trigger({ kind: 'time', repeat: 'at', at: '2026-11-01T09:00:00Z', timezone: 'Europe/Paris' }), agent('a', 'go')] }, 'user')).toThrow(/in the past/);
  });

  it('morning summary (time trigger → agent step), end to end with the fake model: fires at 9, the agent completes, the run is done', async () => {
    const fake = new FakeProvider([[use('task_complete', { summary: '3 new funding rounds' })]]);
    const engine = await startEngine({ memoryReview: false, dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, providers: () => fake, env: {} });
    engines.push(engine);
    const w = engine.workflows.create({ name: 'Morning summary', nodes: [trigger(), agent('sum', 'Summarise the night: {{run.id}}', { newTaskEachRun: true })], edges: [edge('trigger', 'start', 'sum')] }, 'user');
    // Due now: the engine's own clock fires it at its next tick (as after a night with Atlas off).
    engine.db.prepare("UPDATE workflows SET next_run_at = '2026-01-01T08:00:00.000Z' WHERE id = ?").run(w.id);
    engine.workflows.tick();
    const run = engine.workflows.runs(w.id)[0]!;
    await eventually(() => engine.workflows.run(run.id).state === 'done', { what: 'run done' });
    const done = engine.workflows.run(run.id);
    expect(done.steps!.map((s) => [s.nodeId, s.state, s.exit, s.summary])).toEqual([
      ['trigger', 'done', 'start', expect.stringContaining('Atlas was not running then')],
      ['sum', 'done', 'done', '3 new funding rounds'],
    ]);
    expect(done.reason).toBe('ended after « Summarise the night: {{run.id}} » (done)');
    const card = engine.kanban.get(done.steps![1]!.cardId!);
    expect(card).toMatchObject({ status: 'done', assignee: 'atlas', createdBy: `workflow:${w.id}` });
    expect(card.body).toContain(`Summarise the night: ${run.id}`);
    expect(engine.workflows.get(w.id).nextRunAt! > new Date().toISOString()).toBe(true);
    // The Inbox says which workflow ran.
    expect(engine.notifications.inbox().updates[0]).toMatchObject({ kind: 'schedule.ran', title: 'Morning summary', body: '3 new funding rounds' });
  });

  it('failed exit → fix step → loop guard → approval → ship, with prompt variables', async () => {
    const { engine, wf } = await setup();
    const w = wf.create(pipeline(), 'user');
    const run = wf.runNow(w.id);
    const current = () => wf.run(run.id).steps!.at(-1)!;
    const build1 = current();
    expect(build1).toMatchObject({ nodeId: 'build', round: 1, state: 'running' });
    expect(engine.kanban.messages(build1.cardId!)[0]!.content[0]).toMatchObject({ text: expect.stringContaining(`Build it. Last fix: (no previous step) in (no previous task) (run ${run.id})`) });

    // The agent can't build it: capability block → failed exit, the task is closed.
    engine.kanban.block(build1.cardId!, { kind: 'capability', reason: 'tests red: 3 failures' }, 'atlas');
    wf.tick();
    expect(engine.kanban.get(build1.cardId!).status).toBe('closed');
    const fix1 = current();
    expect(fix1).toMatchObject({ nodeId: 'fix', round: 1 });
    expect(engine.kanban.get(fix1.cardId!).body).toContain('Fix what failed: tests red: 3 failures');

    engine.kanban.update(fix1.cardId!, { status: 'done' }, 'atlas', 'fixed the import');
    engine.kanban.event(fix1.cardId!, 'completed', { by: 'atlas', summary: 'fixed the import' });
    wf.tick();
    // guard: fix ran 1 time < 2 → yes → build again, on its own task (reopened, history kept), with the fix as previous.
    const build2 = current();
    expect(build2).toMatchObject({ nodeId: 'build', round: 2, cardId: build1.cardId });
    expect(engine.kanban.get(build1.cardId!).status).toBe('ready');
    expect(engine.kanban.messages(build1.cardId!).at(-1)!.content[0]).toMatchObject({ text: expect.stringContaining(`Last fix: fixed the import in ${engine.kanban.ref(fix1.cardId!)}`) });

    engine.kanban.update(build1.cardId!, { status: 'closed' }, 'user'); // closed → failed too
    wf.tick();
    const fix2 = current();
    engine.kanban.update(fix2.cardId!, { status: 'done' }, 'atlas');
    wf.tick();
    // guard: fix ran 2 times → no → approval, a task blocked on the user with Approve / Reject.
    const ask = current();
    expect(ask).toMatchObject({ nodeId: 'ask', state: 'waiting' });
    expect(wf.run(run.id).state).toBe('waiting');
    expect(engine.kanban.get(ask.cardId!)).toMatchObject({ status: 'blocked', assignee: null, block: { kind: 'needs_input', options: ['Approve', 'Reject'] } });
    expect(wf.run(run.id).steps!.find((s) => s.nodeId === 'guard' && s.round === 2)).toMatchObject({ exit: 'no', summary: 'step fix ran 2 times: not fewer than 2' });

    // The user answers « Approve » in the Inbox: the message goes on the task, which leaves blocked.
    engine.kanban.appendMessage(ask.cardId!, 'user', 'user', [{ type: 'text', text: 'Approve' }]);
    engine.kanban.update(ask.cardId!, { status: 'ready' }, 'user');
    wf.tick();
    expect(engine.kanban.get(ask.cardId!).status).toBe('done');
    const ship = current();
    expect(ship).toMatchObject({ nodeId: 'ship', state: 'running' });
    engine.kanban.update(ship.cardId!, { status: 'done' }, 'atlas');
    wf.tick();
    expect(wf.run(run.id)).toMatchObject({ state: 'done', reason: 'ended after « Ship » (done)' });
    expect(wf.run(run.id).steps!.map((s) => `${s.nodeId}:${s.exit}`)).toEqual(['trigger:start', 'build:failed', 'fix:done', 'guard:yes', 'build:failed', 'fix:done', 'guard:no', 'ask:approved', 'ship:done']);
  });

  it('unwired exits end the run: done and approved OK, failed and rejected Failed with the reason; a summary condition', async () => {
    const { engine, wf } = await setup();
    const w = wf.create(
      {
        name: 'Check',
        nodes: [trigger({ kind: 'manual' }), agent('a', 'check'), { id: 'c', kind: 'condition', x: 0, y: 0, config: { test: 'summaryContains', text: 'ALERT' } }, { id: 'ok', kind: 'approval', x: 0, y: 0, config: { question: 'Page someone?' } }],
        edges: [edge('trigger', 'start', 'a'), edge('a', 'done', 'c'), edge('c', 'yes', 'ok')],
      },
      'user',
    );
    const done = (cardId: string, summary: string) => {
      engine.kanban.update(cardId, { status: 'done' }, 'atlas');
      engine.kanban.event(cardId, 'completed', { by: 'atlas', summary });
      wf.tick();
    };
    let r = wf.runNow(w.id);
    done(r.steps!.at(-1)!.cardId!, 'all quiet');
    expect(wf.run(r.id)).toMatchObject({ state: 'done', reason: expect.stringContaining('(no)') });

    r = wf.runNow(w.id);
    done(r.steps!.at(-1)!.cardId!, 'ALERT: disk full');
    const ask = wf.run(r.id).steps!.at(-1)!;
    engine.kanban.appendMessage(ask.cardId!, 'user', 'user', [{ type: 'text', text: 'Reject — it is the test box' }]);
    engine.kanban.update(ask.cardId!, { status: 'ready' }, 'user');
    wf.tick();
    expect(wf.run(r.id)).toMatchObject({ state: 'failed', reason: '« Page someone? » rejected: rejected by you: Reject — it is the test box (nothing is linked to « rejected »)' });
    expect(engine.kanban.get(ask.cardId!).status).toBe('closed');

    r = wf.runNow(w.id);
    engine.kanban.block(r.steps!.at(-1)!.cardId!, { kind: 'capability', reason: 'no access to the server' }, 'atlas');
    wf.tick();
    expect(wf.run(r.id)).toMatchObject({ state: 'failed', reason: '« check » failed: no access to the server (nothing is linked to « failed »)' });
    expect(wf.get(w.id).lastRun).toMatchObject({ number: 3, state: 'failed' });
    expect(wf.get(w.id).recentRuns).toEqual(['done', 'failed', 'failed']);
  });

  it('an answer that is neither approve nor reject asks again; a blocked or in-review agent task makes the run wait', async () => {
    const { engine, wf } = await setup();
    const w = wf.create({ name: 'A', nodes: [trigger({ kind: 'manual' }), agent('a', 'go'), { id: 'ok', kind: 'approval', x: 0, y: 0, config: {} }], edges: [edge('trigger', 'start', 'a'), edge('a', 'done', 'ok')] }, 'user');
    const r = wf.runNow(w.id);
    const a = r.steps!.at(-1)!.cardId!;
    engine.kanban.block(a, { kind: 'needs_input', reason: 'which repo?' }, 'atlas');
    wf.tick();
    expect(wf.run(r.id)).toMatchObject({ state: 'waiting' });
    engine.kanban.update(a, { status: 'review' }, 'atlas', 'done, please look');
    engine.kanban.event(a, 'review_requested', { by: 'atlas', summary: 'done, please look' });
    wf.tick();
    expect(wf.run(r.id).steps!.at(-1)).toMatchObject({ nodeId: 'a', state: 'waiting' });
    engine.kanban.update(a, { status: 'done' }, 'user');
    wf.tick();
    const ask = wf.run(r.id).steps!.at(-1)!;
    expect(engine.kanban.get(ask.cardId!).block!.reason).toBe('Continue workflow « A »?');
    engine.kanban.appendMessage(ask.cardId!, 'user', 'user', [{ type: 'text', text: 'hmm, what changed?' }]);
    engine.kanban.update(ask.cardId!, { status: 'ready' }, 'user');
    wf.tick();
    expect(engine.kanban.get(ask.cardId!)).toMatchObject({ status: 'blocked', block: { reason: expect.stringContaining('answer Approve or Reject') } });
    expect(wf.run(r.id).state).toBe('waiting');
  });

  it('a trigger firing while a run is going is skipped (and listed); stop closes the open tasks', async () => {
    const { engine, wf, at } = await setup();
    const w = wf.create({ name: 'Hourly', nodes: [trigger({ ...paris9, cron: '0 * * * *' }), agent('a', 'go', { newTaskEachRun: true })], edges: [edge('trigger', 'start', 'a')] }, 'user');
    at('2026-11-10T08:00:10Z');
    wf.tick();
    at('2026-11-10T09:00:10Z');
    wf.tick();
    const manual = wf.runNow(w.id);
    expect(manual).toMatchObject({ state: 'skipped', trigger: 'manual', reason: 'skipped: run 1 was still going' });
    expect(wf.runs(w.id).map((r) => [r.number, r.state])).toEqual([
      [3, 'skipped'],
      [2, 'skipped'],
      [1, 'running'],
    ]);
    expect(engine.kanban.list()).toHaveLength(1);
    // Lists show the run that is going (with its step), not the skipped firings after it.
    expect(wf.get(w.id).lastRun).toMatchObject({ number: 1, state: 'running', steps: [{ nodeId: 'trigger', state: 'done' }, { nodeId: 'a', state: 'running' }] });

    const card = engine.kanban.list()[0]!;
    const stopped = wf.stopRun(wf.runs(w.id)[2]!.id);
    expect(stopped).toMatchObject({ state: 'stopped', reason: 'stopped by you' });
    expect(stopped.steps!.at(-1)).toMatchObject({ state: 'stopped' });
    expect(engine.kanban.get(card.id).status).toBe('closed');
    expect(() => wf.stopRun(stopped.id)).toThrow(/already ended/);
    wf.tick(); // the closed task does not move the stopped run
    expect(wf.run(stopped.id).state).toBe('stopped');
  });

  it('after downtime, a missed time trigger fires once, and a one-shot fires once then turns off', async () => {
    const { engine, wf, at } = await setup();
    const hourly = wf.create({ name: 'Hourly', nodes: [trigger({ ...paris9, cron: '0 * * * *' }), agent('a', 'go', { newTaskEachRun: true })], edges: [edge('trigger', 'start', 'a')] }, 'user');
    const once = wf.createOneStep({ agentId: 'atlas', kind: 'at', at: '2026-11-10T12:30:00+01:00', prompt: 'Renew the domain', createCard: true }, 'user');
    at('2026-11-10T13:20:00Z'); // 6 hourly slots missed
    wf.tick();
    expect(wf.runs(hourly.id)).toHaveLength(1);
    expect(wf.get(hourly.id).nextRunAt).toBe('2026-11-10T14:00:00.000Z');
    expect(wf.get(once.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(engine.kanban.list().map((c) => c.title).sort()).toEqual(['Renew the domain · Tue 10 Nov', 'go · Tue 10 Nov']);
  });

  it('restart in the middle of a run: the run carries on from its stored step, and no slot fires twice', async () => {
    const dbFile = join(mkdtempSync(join(tmpdir(), 'atlas-')), 'w.db');
    const first = await setup('2026-11-10T07:00:00Z', dbFile);
    const w = first.wf.create(pipeline(), 'user');
    first.wf.update(w.id, { name: 'Build and ship' });
    const run = first.wf.runNow(w.id);
    const build = run.steps!.at(-1)!.cardId!;
    // The agent finishes while the engine is going down: the card changed, the workflow never saw it.
    first.engine.kanban.block(build, { kind: 'capability', reason: 'red' }, 'atlas');
    await first.engine.stop();
    engines = [];

    const second = await setup('2026-11-10T07:05:00Z', dbFile);
    second.wf.tick();
    expect(second.wf.run(run.id).steps!.map((s) => `${s.nodeId}:${s.state}`)).toEqual(['trigger:done', 'build:failed', 'fix:running']);
    const fix = second.wf.run(run.id).steps!.at(-1)!.cardId!;
    second.engine.kanban.update(fix, { status: 'done' }, 'atlas');
    second.wf.tick();
    expect(second.wf.run(run.id).steps!.at(-1)).toMatchObject({ nodeId: 'build', round: 2, state: 'running', cardId: build });

    // A time trigger: claim and run are one transaction, so a restart right after doesn't fire the slot again.
    const t = second.wf.createOneStep({ agentId: 'atlas', kind: 'cron', cron: '0 9 * * 1-5', timezone: 'Europe/Paris', prompt: 'daily', createCard: true }, 'user');
    second.at('2026-11-10T08:00:01Z');
    second.wf.tick();
    await second.engine.stop();
    engines = [];
    const third = await setup('2026-11-10T08:00:02Z', dbFile);
    third.wf.tick();
    expect(third.wf.runs(t.id)).toHaveLength(1);
    expect(third.wf.get(t.id).nextRunAt).toBe('2026-11-11T08:00:00.000Z');
  });

  it('a run that reaches a deleted agent or a missing step fails with the reason; saving a stale revision is refused', async () => {
    const { engine, wf } = await setup();
    engine.agents.create({ id: 'temp', modelId: engine.agents.get('atlas').modelId });
    const w = wf.create({ name: 'Temp', nodes: [trigger({ kind: 'manual' }), agent('a', 'go', { agentId: 'temp' })], edges: [edge('trigger', 'start', 'a')] }, 'user');
    engine.agents.remove('temp');
    expect(wf.runNow(w.id)).toMatchObject({ state: 'failed', reason: '« go »: agent @temp does not exist' });

    const g = wf.get(w.id);
    const saved = wf.saveGraph(w.id, { revision: g.revision, nodes: [trigger({ kind: 'manual' }), agent('a', 'again')], edges: [edge('trigger', 'start', 'a')] });
    expect(saved.revision).toBe(g.revision + 1);
    expect(() => wf.saveGraph(w.id, { revision: g.revision, nodes: saved.nodes, edges: saved.edges })).toThrow(/was saved since you opened it/);
    // A graph broken under the engine's feet (edge to a step that's gone) fails the run, it doesn't crash the tick.
    engine.db.prepare("DELETE FROM workflow_nodes WHERE workflow_id = ? AND id = 'a'").run(w.id);
    expect(wf.runNow(w.id)).toMatchObject({ state: 'failed', reason: 'exit « start » of « Trigger » goes to step a, which does not exist' });
  });

  it('on/off, rename, run now while off, delete stops the open run and keeps the tasks; events after commit', async () => {
    const { engine, wf } = await setup();
    const seen: string[] = [];
    engine.bus.on((e) => e.type.startsWith('workflow.') && seen.push(e.type));
    const w = wf.createOneStep({ agentId: 'atlas', kind: 'cron', cron: '0 9 * * 1-5', timezone: 'Europe/Paris', prompt: 'Morning summary' }, 'user');
    expect(wf.update(w.id, { enabled: false })).toMatchObject({ enabled: false, nextRunAt: null });
    expect(wf.update(w.id, { name: 'Morning' }).name).toBe('Morning');
    const r = wf.runNow(w.id);
    expect(r.state).toBe('running');
    const card = r.steps!.at(-1)!.cardId!;
    expect(engine.kanban.messages(card)[0]!.content[0]).toMatchObject({ text: expect.stringContaining('run by hand') });
    expect(wf.update(w.id, { enabled: true }).nextRunAt).toBe('2026-11-10T08:00:00.000Z');
    wf.remove(w.id);
    expect(() => wf.get(w.id)).toThrow(/not found/);
    expect(engine.kanban.get(card).status).toBe('closed');
    expect(engine.db.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get()).toEqual({ n: 0 });
    expect(seen).toContain('workflow.updated');
    expect(seen).toContain('workflow.run');
    expect(seen.at(-1)).toBe('workflow.deleted');
  });

  it('agents keep the schedule_* tools: they create, list and delete one-step workflows', async () => {
    const { engine } = await setup();
    const run = engine.kanban.create({ title: 'the run the tools are called from' }, 'user');
    const ctx = { kanban: engine.kanban, memories: engine.memories, workflows: engine.workflows, agentId: 'atlas', cardId: run.id, deliver: () => {} };
    const made = runTeamTool('schedule_create', { prompt: 'Check the backups', cron: '0 3 * * *', timezone: 'Europe/Paris' }, ctx);
    expect(made).toMatchObject({ isError: false, output: expect.stringMatching(/^scheduled wf_\w+ "Check the backups" for @atlas: cron "0 3 \* \* \*" \(Europe\/Paris\), first run \S+$/) });
    expect(runTeamTool('schedule_create', { prompt: 'x' }, ctx)).toMatchObject({ isError: true, output: 'give exactly one of cron or at' });
    const id = engine.workflows.list()[0]!.id;
    expect(runTeamTool('schedule_list', {}, ctx).output).toMatch(new RegExp(`^${id} @atlas "Check the backups": cron "0 3 \\* \\* \\*" \\(Europe/Paris\\) · next \\S+ · own task \\(created on first run\\)$`));
    const multi = engine.workflows.create(pipeline(), 'user');
    expect(runTeamTool('schedule_list', {}, ctx).output).toContain(`${multi.id} @atlas "Build and ship": by hand only · no next run · workflow of 5 steps`);
    expect(runTeamTool('schedule_delete', { id: multi.id }, ctx)).toMatchObject({ isError: true, output: expect.stringContaining('several steps') });
    expect(runTeamTool('schedule_delete', { id }, ctx).output).toBe(`schedule ${id} deleted`);
  });

  it('the engine stops its trigger clock on stop', async () => {
    const engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, providers: () => new FakeProvider([]), env: {} });
    await engine.stop();
    expect(engine.workflows['timer']).toBeUndefined();
  });
});

describe('0044 migrates schedules into one-step workflows', () => {
  it('keeps prompt, cron or date, zone, task mode, on/off, next and last run, error and tasks; drops the table', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'store', 'migrations');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.pragma('foreign_keys = OFF');
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0044').sort()) {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, 'x');
    }
    db.prepare("INSERT OR IGNORE INTO agents (id, model_id) VALUES ('atlas', 'm')").run();
    const ins = db.prepare(
      `INSERT INTO schedules (id, agent_id, title, kind, cron, at, prompt, create_card, timezone, enabled, next_run_at, last_fired_at, last_card_id, chat_card_id, last_error, created_by, created_at, updated_at)
       VALUES (?, 'atlas', ?, ?, ?, ?, ?, ?, 'Europe/Paris', ?, ?, ?, ?, ?, ?, 'user', 'c', 'u')`,
    );
    ins.run('sch_a', 'Morning summary', 'cron', '0 9 * * 1-5', null, 'Summarise', 0, 1, '2026-11-19T08:00:00.000Z', '2026-11-18T08:00:00.000Z', 'c_own', 'c_own', null);
    ins.run('sch_b', 'Renew', 'at', null, '2026-11-01T09:00:00+01:00', 'Renew the domain', 1, 0, null, '2026-11-01T08:00:00.000Z', 'c_new', null, 'agent ghost does not exist');
    ins.run('sch_c', 'Never ran', 'cron', '0 3 * * *', null, 'Backups', 1, 1, '2026-11-19T02:00:00.000Z', null, null, null, null);
    db.pragma('foreign_keys = ON');
    expect(migrate(db)).toContain('0044_workflows.sql');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'schedules'").get()).toBeUndefined();

    const bus = new Bus();
    const wf = new Workflows(db, bus, new Kanban(db, bus));
    const list = wf.list();
    expect(list.map((w) => [w.id, w.name, w.enabled, w.origin, w.nextRunAt, w.lastFiredAt, w.lastError])).toEqual([
      ['sch_c', 'Never ran', true, 'schedules', '2026-11-19T02:00:00.000Z', null, null],
      ['sch_a', 'Morning summary', true, 'schedules', '2026-11-19T08:00:00.000Z', '2026-11-18T08:00:00.000Z', null],
      ['sch_b', 'Renew', false, 'schedules', null, '2026-11-01T08:00:00.000Z', 'agent ghost does not exist'],
    ]);
    const a = oneStep(wf.get('sch_a'))!;
    expect(a.trigger.config).toEqual({ kind: 'time', repeat: 'cron', cron: '0 9 * * 1-5', at: null, timezone: 'Europe/Paris' });
    expect(a.step.config).toEqual({ title: 'Morning summary', agentId: 'atlas', prompt: 'Summarise', newTaskEachRun: false });
    expect(wf.ownTask('sch_a', 'step1')).toBe('c_own');
    const b = oneStep(wf.get('sch_b'))!;
    expect(b.trigger.config).toMatchObject({ repeat: 'at', at: '2026-11-01T09:00:00+01:00', cron: null });
    expect(b.step.config.newTaskEachRun).toBe(true);
    expect(wf.runs('sch_b')).toEqual([expect.objectContaining({ number: 1, state: 'done', trigger: 'time' })]);
    expect(wf.run(wf.runs('sch_b')[0]!.id).steps).toEqual([expect.objectContaining({ nodeId: 'step1', cardId: 'c_new', state: 'done' })]);
    expect(wf.runs('sch_c')).toEqual([]);
    db.close();
  });
});
