import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowNodeInput } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { COULDNT_NOTIFY_MS, COULDNT_RETRY_MS, Workflows, fieldTest, type WorkflowOptions } from './workflows.ts';

/** Stage 2 nodes (#261, design §9): Action, Wait, Condition on fields, and « couldn't run ». */

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

async function setup(o: { dbFile?: string; dataDir?: string; gh?: WorkflowOptions['gh']; at?: string } = {}) {
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
  for (const id of ['zurich']) if (!engine.agents.list().some((a) => a.id === id)) engine.agents.create({ id, modelId: engine.agents.get('atlas').modelId });
  const clock = { now: new Date(o.at ?? '2026-11-19T09:00:00Z') };
  const wf = new Workflows(engine.db, engine.bus, engine.kanban, () => clock.now, { gh: o.gh });
  const later = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  return { engine, wf, clock, later, k: engine.kanban };
}

const node = (id: string, kind: WorkflowNodeInput['kind'], config: object): WorkflowNodeInput => ({ id, kind, x: 0, y: 0, config: config as never } as WorkflowNodeInput);
const trigger = node('trigger', 'trigger', { kind: 'manual' });
const edge = (from: string, exit: string, to: string) => ({ from, exit, to });
const URL = 'https://github.com/csoylu/atlas/pull/41';
const inbox = (e: Engine, kind: string) => e.db.prepare('SELECT title, body, card_id FROM notifications WHERE kind = ? ORDER BY id').all(kind) as { title: string; body: string; card_id: string | null }[];

/** A task with PR #41 linked, its stored GitHub state set as Atlas would have read it. */
function withPr(engine: Engine, pr: { head?: string | null; ci?: string | null; mergeable?: number | null; state?: string } = {}) {
  const k = engine.kanban;
  const c = k.create({ title: 'feature', status: 'ready', assignee: 'atlas' }, 'user');
  k.requestReview(c.id, [URL], 'atlas', 'built it');
  const set = (p: typeof pr) => {
    const cur = { head: 'a1b2c3d4', ci: 'pending', mergeable: 1, state: 'open', ...p };
    engine.db.prepare('UPDATE card_prs SET head_sha = ?, ci = ?, mergeable = ?, state = ?, base = ? WHERE card_id = ?').run(cur.head, cur.ci, cur.mergeable, cur.state, 'main', c.id);
  };
  set(pr);
  return { card: c, set };
}

/** A fake GitHub for the gate of validate.mjs: one open PR on main, its check runs, and the merge. */
function fakeGh(o: { ci?: string; head?: string; mergeable?: boolean | null; merged?: boolean; fail?: () => string | null } = {}) {
  const calls: string[] = [];
  const gh = (args: string[]) => {
    calls.push(args.join(' '));
    const why = o.fail?.();
    if (why) throw new Error(why);
    const path = args[1]!;
    if (/\/pulls\/41$/.test(path))
      return JSON.stringify({
        state: o.merged ? 'closed' : 'open',
        merged: !!o.merged,
        draft: false,
        mergeable: o.mergeable === undefined ? true : o.mergeable,
        base: { ref: 'main', repo: { default_branch: 'main' } },
        head: { sha: o.head ?? 'a1b2c3d4e5', ref: 'feat/x' },
      });
    if (path.includes('/check-runs')) return JSON.stringify({ check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: o.ci ?? 'success', html_url: 'https://ci/1' }] });
    if (path.includes('/statuses/')) return '{}';
    if (path.endsWith('/merge')) return JSON.stringify({ sha: 'm3rg3d00' });
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

describe('workflow nodes, stage 2 (#261, design §9)', () => {
  it('Action: sets the status and the assignee with a note first, notifies Master; no task to act on fails loudly', async () => {
    const { engine, wf, k } = await setup();
    const w = wf.create(
      {
        name: 'Hand back',
        nodes: [
          trigger,
          node('s', 'action', { do: 'setStatus', status: 'ready', note: 'CI is red on {{pr.head}}: fix it' }),
          node('a', 'action', { do: 'setAssignee', assignee: 'zurich', note: '' }),
          node('n', 'action', { do: 'notify', text: '{{task.ref}} went back to @zurich' }),
        ],
        edges: [edge('trigger', 'start', 's'), edge('s', 'done', 'a'), edge('a', 'done', 'n')],
      },
      'user',
    );
    const { card } = withPr(engine, { ci: 'failure' });
    const r = wf.runNow(w.id, { task: card.id });
    expect(r).toMatchObject({ state: 'done' });
    expect(r.steps!.map((s) => [s.nodeId, s.exit])).toEqual([['trigger', 'start'], ['s', 'done'], ['a', 'done'], ['n', 'done']]);
    expect(k.get(card.id)).toMatchObject({ status: 'ready', assignee: 'zurich' });
    const msgs = k.messages(card.id).filter((m) => m.author === 'workflow');
    expect(msgs.map((m) => (m.content[0] as { text: string }).text)).toEqual(['CI is red on a1b2c3d4: fix it']);
    expect(r.steps![1]!.summary).toBe(`${k.ref(card.id)} → ready, with a note: CI is red on a1b2c3d4: fix it`);
    expect(inbox(engine, 'workflow.notify')).toEqual([{ title: 'Workflow « Hand back »', body: `${k.ref(card.id)} went back to @zurich`, card_id: card.id }]);

    // A run on no task: the action can't act; it fails with the reason (rule 3), it is not « couldn't run ».
    expect(wf.runNow(w.id)).toMatchObject({ state: 'failed', reason: '« Task → ready »: {{pr.head}}: this run has no pull request (started by hand, on no task)' });
    const bare = wf.create({ name: 'Bare', nodes: [trigger, node('s', 'action', { do: 'setStatus', status: 'ready', note: '' })], edges: [edge('trigger', 'start', 's')] }, 'user');
    expect(wf.runNow(bare.id)).toMatchObject({ state: 'failed', reason: "« Task → ready » acts on the run's task, and this run has none (started by hand, on no task)" });
    // An unknown assignee is refused at save.
    expect(() =>
      wf.create({ name: 'x', nodes: [trigger, node('a', 'action', { do: 'setAssignee', assignee: 'nobody', note: '' })], edges: [edge('trigger', 'start', 'a')] }, 'user'),
    ).toThrow(/agent @nobody does not exist/);
    // Exits are per action: a status change has only « done ».
    expect(() =>
      wf.create({ name: 'x', nodes: [trigger, node('s', 'action', { do: 'setStatus', status: 'ready', note: '' }), node('n', 'action', { do: 'notify', text: 'x' })], edges: [edge('trigger', 'start', 's'), edge('s', 'merged', 'n')] }, 'user'),
    ).toThrow(/has no exit « merged »/);
  });

  it('Action validate + merge: the pr_validate gate on the pinned head; merged / refused are exits', async () => {
    const fake = { ci: 'success', head: 'a1b2c3d4e5' } as { ci: string; head: string };
    const gh = fakeGh(fake);
    const { engine, wf, k } = await setup({ gh: () => gh.gh });
    const w = wf.create(
      {
        name: 'Merge',
        nodes: [trigger, node('m', 'action', { do: 'mergePr' }), node('back', 'action', { do: 'setStatus', status: 'ready', note: 'Merge refused: {{steps.m.summary}}' })],
        edges: [edge('trigger', 'start', 'm'), edge('m', 'refused', 'back')],
      },
      'user',
    );
    const { card } = withPr(engine, { ci: 'success' });
    let r = wf.runNow(w.id, { task: card.id });
    expect(r.steps!.at(-1)).toMatchObject({ nodeId: 'm', state: 'running', couldntRun: null });
    await wf.idle();
    r = wf.run(r.id);
    expect(r).toMatchObject({ state: 'done' });
    expect(r.steps!.at(-1)).toMatchObject({ nodeId: 'm', exit: 'merged', summary: expect.stringContaining('merged PR #41: m3rg3d0') });
    // The head pinned is the one Atlas read (a1b2c3d4), the status says who, the merge is pinned to the sha.
    expect(gh.calls).toEqual(expect.arrayContaining([expect.stringMatching(/statuses\/a1b2c3d4e5 -f state=success -f context=qa\/validated -f description=workflow: « Merge » run 1/), expect.stringMatching(/pulls\/41\/merge -X PUT -f sha=a1b2c3d4e5/)]));

    // CI red: refused, with GitHub's reason, and the refused exit sends it back to the builder with that reason.
    fake.ci = 'failure';
    gh.calls.length = 0;
    k.update(card.id, { status: 'review' }, 'atlas');
    r = wf.runNow(w.id, { task: card.id });
    await wf.idle();
    r = wf.run(r.id);
    expect(r).toMatchObject({ state: 'done' });
    expect(r.steps!.find((s) => s.nodeId === 'm')).toMatchObject({ exit: 'refused', state: 'failed', summary: expect.stringContaining('CI job "test" is failure on a1b2c3d') });
    expect(gh.calls.some((c) => c.includes('/merge'))).toBe(false);
    expect(k.get(card.id).status).toBe('ready');

    // A head pushed after Atlas pinned it: refused (the review saw another commit).
    fake.ci = 'success';
    fake.head = 'ffff000011';
    r = wf.runNow(w.id, { task: card.id });
    await wf.idle();
    expect(wf.run(r.id).steps!.find((s) => s.nodeId === 'm')).toMatchObject({ exit: 'refused', summary: expect.stringContaining('a commit was pushed after your review') });
  });

  it("couldn't run: gh logged out leaves the step waiting, retried every minute, one Inbox item after 15 min; Retry now and Follow", async () => {
    let loggedOut = true;
    const gh = fakeGh({ fail: () => (loggedOut ? 'gh api repos/csoylu/atlas/pulls/41 failed: You are not logged into any GitHub hosts. To log in, run: gh auth login' : null) });
    const { engine, wf, later } = await setup({ gh: () => gh.gh });
    const w = wf.create({ name: 'Merge', nodes: [trigger, node('m', 'action', { do: 'mergePr' })], edges: [edge('trigger', 'start', 'm')] }, 'user');
    const { card } = withPr(engine, { ci: 'success' });
    let r = wf.runNow(w.id, { task: card.id });
    await wf.idle();
    r = wf.run(r.id);
    expect(r.state).toBe('waiting');
    const step = () => wf.run(r.id).steps!.find((s) => s.nodeId === 'm')!;
    expect(step()).toMatchObject({ state: 'waiting', exit: null, couldntRun: { reason: expect.stringContaining("GitHub can't be read"), tries: 1, notified: false, negativeExit: 'refused' } });
    // Not yet a minute: no new try.
    const n = gh.calls.length;
    later(COULDNT_RETRY_MS / 2);
    wf.tick();
    await wf.idle();
    expect(gh.calls.length).toBe(n);
    // A minute later: tried again, still no answer.
    later(COULDNT_RETRY_MS / 2);
    wf.tick();
    await wf.idle();
    expect(step().couldntRun!.tries).toBe(2);
    expect(inbox(engine, 'workflow.couldnt_run')).toEqual([]);
    // 15 minutes since the first failure: one Inbox item, never two.
    later(COULDNT_NOTIFY_MS);
    wf.tick();
    await wf.idle();
    wf.tick();
    await wf.idle();
    const items = inbox(engine, 'workflow.couldnt_run');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Workflow « Merge » is stuck on « Validate + merge the PR »', card_id: card.id, body: expect.stringContaining('Retry now, or Follow « refused »') });
    expect(step().couldntRun!.notified).toBe(true);
    // Retry now: at once, not at the next minute; logged in again, it merges.
    loggedOut = false;
    wf.retryNow(r.id);
    await wf.idle();
    expect(wf.run(r.id)).toMatchObject({ state: 'done' });
    expect(step()).toMatchObject({ exit: 'merged', couldntRun: null });
    expect(() => wf.retryNow(r.id)).toThrow(/already ended/);

    // Follow the negative exit instead: the run takes « refused » as if GitHub had said no.
    loggedOut = true;
    const r2 = wf.runNow(w.id, { task: card.id });
    await wf.idle();
    expect(wf.run(r2.id).state).toBe('waiting');
    const f = wf.followNegative(r2.id);
    expect(f).toMatchObject({ state: 'failed', reason: expect.stringContaining("couldn't run (GitHub can't be read") });
    expect(f.steps!.find((s) => s.nodeId === 'm')).toMatchObject({ exit: 'refused', summary: expect.stringContaining('you chose to follow « refused »') });
    // A late answer from GitHub after Follow changes nothing.
    await wf.idle();
    expect(wf.run(r2.id).state).toBe('failed');
  });

  it('Wait: already true goes on at once; an event later; a time limit takes « timed out »', async () => {
    const { engine, wf, later, k } = await setup();
    const w = wf.create(
      {
        name: 'Review',
        nodes: [trigger, node('w', 'wait', { for: 'ciFinished', limitMin: 120 }), node('n', 'action', { do: 'notify', text: 'CI said {{pr.ci}}' })],
        edges: [edge('trigger', 'start', 'w'), edge('w', 'event', 'n')],
      },
      'user',
    );
    const { card, set } = withPr(engine, { ci: 'success' });
    const r0 = wf.runNow(w.id, { task: card.id });
    expect(r0).toMatchObject({ state: 'done' });

    set({ ci: 'pending' });
    const r = wf.runNow(w.id, { task: card.id });
    // It waits for an event, not for Master: the run is running, the step waiting, with its deadline stored.
    expect(r).toMatchObject({ state: 'running' });
    expect(r.steps!.at(-1)).toMatchObject({ nodeId: 'w', state: 'waiting', deadlineAt: '2026-11-19T11:00:00.000Z' });
    later(30 * 60_000);
    wf.tick();
    expect(wf.run(r.id).state).toBe('running');
    set({ ci: 'failure' });
    wf.tick();
    const done = wf.run(r.id);
    expect(done).toMatchObject({ state: 'done' });
    expect(done.steps!.find((s) => s.nodeId === 'w')).toMatchObject({ exit: 'event', summary: 'CI red on a1b2c3d' });

    // Nothing within 2 h: timed out (not wired: a failing exit ends the run Failed, with why).
    set({ ci: 'pending' });
    const t = wf.runNow(w.id, { task: card.id });
    later(2 * 3_600_000);
    wf.tick();
    expect(wf.run(t.id)).toMatchObject({ state: 'failed', reason: '« Wait: CI finished on the PR » timed out: no event in 2 h (nothing is linked to « timed out »)' });

    // The task waits: unblocked, or a given status.
    const u = wf.create({ name: 'Unblock', nodes: [trigger, node('w', 'wait', { for: 'unblocked', limitMin: 60 })], edges: [edge('trigger', 'start', 'w')] }, 'user');
    k.block(card.id, { kind: 'needs_input', reason: 'which?' }, 'atlas');
    const ur = wf.runNow(u.id, { task: card.id });
    expect(ur.state).toBe('running');
    k.update(card.id, { status: 'ready' }, 'user');
    wf.tick();
    expect(wf.run(ur.id).steps!.at(-1)).toMatchObject({ exit: 'event', summary: `${k.ref(card.id)} is ready` });
    // A wait needs a status to wait for, and a task.
    expect(() => wf.create({ name: 'x', nodes: [trigger, node('w', 'wait', { for: 'status', limitMin: 5 })], edges: [] }, 'user')).toThrow();
    expect(wf.runNow(u.id)).toMatchObject({ state: 'failed', reason: expect.stringContaining("waits on the run's task, and this run has none") });
  });

  it('Wait and a step that couldn\'t run survive a kill and a restart past the deadline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const dbFile = join(dir, 'atlas.db');
    const a = await setup({ dbFile, dataDir: dir });
    const w = a.wf.create({ name: 'Review', nodes: [trigger, node('w', 'wait', { for: 'merged', limitMin: 60 })], edges: [edge('trigger', 'start', 'w')] }, 'user');
    const m = a.wf.create({ name: 'Merge', nodes: [trigger, node('m', 'action', { do: 'mergePr' })], edges: [edge('trigger', 'start', 'm')] }, 'user');
    const { card } = withPr(a.engine, { ci: 'success' });
    const waitRun = a.wf.runNow(w.id, { task: card.id });
    const mergeRun = a.wf.runNow(m.id, { task: card.id }); // no GitHub client in this engine: couldn't run
    await a.wf.idle();
    expect(a.wf.run(mergeRun.id).steps!.at(-1)!.couldntRun).toMatchObject({ reason: 'this engine has no GitHub client', tries: 1 });
    // « Kill »: drop the engine without stopping anything, then a new one on the same file, 3 h later.
    a.engine.db.close();
    engines = engines.filter((e) => e !== a.engine);
    const b = await setup({ dbFile, dataDir: dir, at: '2026-11-19T12:00:00Z', gh: () => fakeGh().gh });
    b.wf.tick();
    await b.wf.idle();
    expect(b.wf.run(waitRun.id)).toMatchObject({ state: 'failed', reason: expect.stringContaining('timed out: no event in 1 h') });
    // The merge step was retried by the new engine (its retry time had passed) and merged; the Inbox item came first (3 h > 15 min).
    expect(b.wf.run(mergeRun.id)).toMatchObject({ state: 'done' });
    expect(b.wf.run(mergeRun.id).steps!.at(-1)).toMatchObject({ exit: 'merged' });
    expect(inbox(b.engine, 'workflow.couldnt_run')).toHaveLength(1);
  });

  it('Condition on fields: exact tests on task, PR, steps and payload; all / any; refused at save on an unknown field; try it on a past run', async () => {
    const { engine, wf, k } = await setup();
    const cond = (match: 'all' | 'any', tests: object[]) => node('c', 'condition', { test: 'fields', match, tests });
    const green = [
      { field: 'pr.ci', op: 'is', value: 'success' },
      { field: 'pr.conflict', op: 'is', value: 'no' },
    ];
    const w = wf.create(
      {
        name: 'Green?',
        nodes: [trigger, cond('all', green), node('y', 'action', { do: 'notify', text: 'green' }), node('n', 'action', { do: 'notify', text: 'not green' })],
        edges: [edge('trigger', 'start', 'c'), edge('c', 'yes', 'y'), edge('c', 'no', 'n')],
      },
      'user',
    );
    const { card, set } = withPr(engine, { ci: 'success', mergeable: 1 });
    let r = wf.runNow(w.id, { task: card.id });
    expect(r.steps!.map((s) => s.nodeId)).toEqual(['trigger', 'c', 'y']);
    expect(r.steps![1]!.summary).toBe('pr.ci = « success » ✓ · pr.conflict = « no » ✓');
    set({ ci: 'success', mergeable: 0 });
    r = wf.runNow(w.id, { task: card.id });
    expect(r.steps!.map((s) => [s.nodeId, s.exit])).toEqual([['trigger', 'start'], ['c', 'no'], ['n', 'done']]);

    // Try a change on run 1 before saving: « any » passes on CI alone. The task and PR are read as they are now.
    const tried = wf.tryCondition(w.id, { run: wf.runs(w.id).at(-1)!.id, config: { test: 'fields', title: '', match: 'any', tests: green as never } });
    expect(tried).toMatchObject({ runNumber: 1, exit: 'yes', tests: [{ field: 'pr.ci', actual: 'success', pass: true }, { field: 'pr.conflict', actual: 'yes', pass: false }] });
    // Step fields: the exit of an earlier step; a run with no PR reads pr.* as missing (null), never as a match.
    const steps = wf.tryCondition(w.id, { run: r.id, config: { test: 'fields', title: '', match: 'all', tests: [{ field: 'steps.c.exit', op: 'is', value: 'no' }, { field: 'task.status', op: 'is', value: k.get(card.id).status }] } });
    expect(steps.exit).toBe('yes');
    const bare = wf.runNow(w.id);
    expect(bare.steps!.map((s) => s.nodeId)).toEqual(['trigger', 'c', 'n']);
    expect(wf.tryCondition(w.id, { run: bare.id, config: { test: 'fields', title: '', match: 'all', tests: green as never } }).tests[0]).toMatchObject({ actual: null, pass: false });
    expect(() => wf.tryCondition(w.id, { run: 'wr_nope', config: { test: 'fields', title: '', match: 'all', tests: green as never } })).toThrow(/not found/);

    // Refused at save: a field no run has, a step that doesn't exist, a number test on a word.
    const save = (tests: object[]) => () => wf.create({ name: 'x', nodes: [trigger, cond('all', tests)], edges: [edge('trigger', 'start', 'c')] }, 'user');
    expect(save([{ field: 'pr.color', op: 'is', value: 'x' }])).toThrow(/tests pr.color, which no run has/);
    expect(save([{ field: 'steps.zz.exit', op: 'is', value: 'x' }])).toThrow(/tests steps.zz.exit/);
    expect(save([{ field: 'task.priority', op: 'gt', value: 'high' }])).toThrow(/needs a number/);
    expect(save([{ field: 'payload.action', op: 'is', value: 'opened' }])).not.toThrow();
  });

  it('field tests are exact: case, missing fields, numbers', () => {
    const t = (op: string, value: string, actual: string | null) => fieldTest({ field: 'f', op: op as never, value }, actual);
    expect(t('is', 'success', 'success')).toBe(true);
    expect(t('is', 'success', 'Success')).toBe(false);
    expect(t('is', '', null)).toBe(false); // a missing field is not an empty match
    expect(t('isNot', 'x', null)).toBe(true);
    expect(t('contains', 'LGTM', 'ok, LGTM')).toBe(true);
    expect(t('notContains', 'x', null)).toBe(true);
    expect(t('isEmpty', '', null)).toBe(true);
    expect(t('isNotEmpty', '', ' ')).toBe(false);
    expect(t('gt', '2', '3')).toBe(true);
    expect(t('lt', '2', 'three')).toBe(false);
    expect(t('gt', '2', '')).toBe(false);
  });

  it('API: try-condition, retry, follow', async () => {
    const { engine } = await setup();
    const base = engine.url;
    const post = (path: string, body: object = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const w = engine.workflows.create({ name: 'API', nodes: [trigger, node('m', 'action', { do: 'mergePr' })], edges: [edge('trigger', 'start', 'm')] }, 'user');
    const { card } = withPr(engine, { head: null });
    const run = engine.workflows.runNow(w.id, { task: card.id });
    await engine.workflows.idle();
    // No head read from GitHub yet: couldn't run (not refused).
    expect(engine.workflows.run(run.id).steps!.at(-1)!.couldntRun).toMatchObject({ reason: 'Atlas has not read the head of PR #41 from GitHub yet' });
    let res = await post(`/api/workflow-runs/${run.id}/retry`);
    expect(res.status).toBe(200);
    res = await post(`/api/workflows/${w.id}/try-condition`, { run: run.id, config: { test: 'fields', title: '', match: 'all', tests: [{ field: 'task.ref', op: 'isNotEmpty', value: '' }] } });
    expect(await res.json()).toMatchObject({ exit: 'yes' });
    res = await post(`/api/workflow-runs/${run.id}/follow`);
    expect(await res.json()).toMatchObject({ state: 'failed' });
    res = await post(`/api/workflow-runs/${run.id}/follow`);
    expect(res.status).toBe(409);
  });
});
