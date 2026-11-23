import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sinceLabel, stallText, type Card, type CardPr, type ContentBlock } from '@atlas/shared';
import { launch, eventually } from '../test/kit/index.ts';
import { detectStall, STALL_LIMITS, type StallFacts } from './stalls.ts';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

const card = (over: Partial<Card> = {}): Card => ({
  id: 'c_1',
  number: 1,
  title: 'T',
  body: '',
  status: 'running',
  assignee: 'munih',
  priority: 0,
  board: 'main',
  parents: [],
  block: null,
  retry: null,
  waiting: null,
  conversationId: 'v_1',
  createdBy: 'user',
  createdAt: ago(600),
  updatedAt: ago(600),
  modelId: null,
  effort: null,
  naming: false,
  working: false,
  unread: false,
  readSeq: 0,
  originCard: null,
  images: [],
  files: [],
  reviewer: 'zurich',
  prs: [],
  projectId: 'atlas',
  statusSince: ago(0),
  stall: null,
  reviewOff: null,
  ...over,
});
const pr = (over: Partial<CardPr> = {}): CardPr => ({
  repo: 'csoylu/atlas',
  number: 41,
  url: 'https://github.com/csoylu/atlas/pull/41',
  branch: 'feat/x',
  base: 'main',
  headSha: 'aaaaaaa1111',
  state: 'open',
  mergeSha: null,
  mergeable: true,
  ci: 'success',
  ciFailed: null,
  qa: null,
  qaDescription: null,
  checkedAt: ago(1),
  error: null,
  errorSince: null,
  reviewedSha: null,
  ...over,
});
const facts = (c: Partial<Card>, f: Partial<StallFacts> = {}): StallFacts => ({
  card: card(c),
  now: NOW,
  running: false,
  lastRunEnd: null,
  startProblem: null,
  parents: [],
  reviewRun: false,
  ...f,
});

describe('stuck tasks: the rules (#237)', () => {
  it('In review: 45 min with CI green, no review run and no verdict', () => {
    const review = { status: 'review' as const, prs: [pr()] };
    expect(detectStall(facts({ ...review, statusSince: ago(44) }))).toBe(null);
    expect(detectStall(facts({ ...review, statusSince: ago(46) }))).toEqual({ rule: 'review', reason: 'CI is green, no Review run is going on it', since: ago(46), action: 'retry_review' });
    // A review run going on, CI not finished or red, a verdict, GitHub unreadable: not stuck.
    expect(detectStall(facts({ ...review, statusSince: ago(90) }, { running: true }))).toBe(null);
    expect(detectStall(facts({ status: 'review', prs: [pr({ ci: 'pending' })], statusSince: ago(90) }))).toBe(null);
    expect(detectStall(facts({ status: 'review', prs: [pr({ ci: 'failure' })], statusSince: ago(90) }))).toBe(null);
    expect(detectStall(facts({ status: 'review', prs: [pr({ qa: 'success' })], statusSince: ago(90) }))).toBe(null);
    expect(detectStall(facts({ status: 'review', prs: [pr({ error: 'gh down', errorSince: ago(30) })], statusSince: ago(90) }))).toBe(null);
    // Counted from the end of the last run (a review that just ended gets its time).
    expect(detectStall(facts({ ...review, statusSince: ago(90) }, { lastRunEnd: ago(20) }))).toBe(null);
    // Why the reviewer doesn't start is said when it says something.
    expect(detectStall(facts({ ...review, statusSince: ago(90), waiting: '@zurich is not a member of Datinel: add it, or choose one in « Review the PR » of workflow « Review »' }))?.reason).toBe(
      'CI is green, no Review run is going on it (@zurich is not a member of Datinel: add it, or choose one in « Review the PR » of workflow « Review »)',
    );
    // A Review run open on it (#263): the run owns its stuck steps; « No Review workflow is on » has its own item.
    expect(detectStall(facts({ ...review, statusSince: ago(90) }, { reviewRun: true }))).toBe(null);
    expect(detectStall(facts({ ...review, statusSince: ago(90), reviewOff: { projectId: 'p', projectName: 'Atlas', workflowId: null } }))).toBe(null);
  });

  it('Working: no run for 10 min', () => {
    expect(detectStall(facts({ status: 'running', statusSince: ago(9) }))).toBe(null);
    expect(detectStall(facts({ status: 'running', statusSince: ago(11) }))).toMatchObject({ rule: 'running', reason: 'no run started', action: 'restart' });
    expect(detectStall(facts({ status: 'running', statusSince: ago(60) }, { running: true }))).toBe(null);
    expect(detectStall(facts({ status: 'running', statusSince: ago(60) }, { lastRunEnd: ago(5) }))).toBe(null);
    expect(detectStall(facts({ status: 'running', statusSince: ago(60) }, { lastRunEnd: ago(15) }))).toMatchObject({ reason: 'its last run ended and no new run started', since: ago(15) });
  });

  it('Ready with an assignee: 30 min without a run while it has a free slot', () => {
    expect(detectStall(facts({ status: 'ready', statusSince: ago(29) }))).toBe(null);
    expect(detectStall(facts({ status: 'ready', statusSince: ago(31) }))).toMatchObject({ rule: 'ready', reason: '@munih has a free slot but no run started', action: 'restart' });
    expect(detectStall(facts({ status: 'ready', statusSince: ago(31) }, { startProblem: '@munih is busy with #2' }))).toBe(null);
    expect(detectStall(facts({ status: 'ready', statusSince: ago(31), assignee: null }))).toBe(null);
  });

  it('Ready that the dispatcher tried and failed to start: 2 min, with its reason (#327)', () => {
    const notStarting = 'could not start: the last run on this task has not let go of it yet';
    expect(detectStall(facts({ status: 'ready', statusSince: ago(1) }, { notStarting }))).toBe(null);
    expect(detectStall(facts({ status: 'ready', statusSince: ago(3) }, { notStarting }))).toMatchObject({ rule: 'ready', reason: notStarting, action: 'restart', since: ago(3) });
    // Busy is not stuck, whatever happened before.
    expect(detectStall(facts({ status: 'ready', statusSince: ago(3) }, { notStarting, startProblem: '@munih is busy with #2' }))).toBe(null);
  });

  it('Todo whose parents are all done or closed: 10 min', () => {
    const p2 = card({ id: 'c_2', number: 2, status: 'done', statusSince: ago(30) });
    const p3 = card({ id: 'c_3', number: 3, status: 'done', statusSince: ago(5) });
    const todo = { status: 'todo' as const, statusSince: ago(60), parents: ['c_2', 'c_3'] };
    // Counted from the last parent done.
    expect(detectStall(facts(todo, { parents: [p2, p3] }))).toBe(null);
    const p3old = { ...p3, statusSince: ago(11) };
    expect(detectStall(facts(todo, { parents: [p2, p3old] }))).toMatchObject({ rule: 'todo', reason: 'its parents are done (#2, #3) but it did not move to Ready', action: 'ready', since: ago(11) });
    expect(detectStall(facts(todo, { parents: [p2, { ...p3old, status: 'closed' }] }))).toMatchObject({ reason: 'parent #3 was closed (cancelled): remove it from the parents, or close this task', action: 'open' });
    expect(detectStall(facts(todo, { parents: [p2, { ...p3old, status: 'running' }] }))).toBe(null);
    // No parents (parked) or a timed retry: not stuck.
    expect(detectStall(facts({ status: 'todo', statusSince: ago(600) }))).toBe(null);
    expect(detectStall(facts({ ...todo, retry: { at: ago(-5), reason: 'rate limit' } }, { parents: [p2, p3old] }))).toBe(null);
  });

  it('Blocked, done, closed and triage are never stuck', () => {
    for (const status of ['blocked', 'done', 'closed', 'triage'] as const) expect(detectStall(facts({ status, statusSince: ago(10_000) }))).toBe(null);
  });

  it('says the time in state in plain words', () => {
    expect(sinceLabel(ago(35), NOW)).toBe('35 min');
    expect(sinceLabel(ago(130), NOW)).toBe('2 h');
    expect(sinceLabel(ago(60 * 30), NOW)).toBe('1 d');
    expect(stallText({ rule: 'review', reason: 'CI is green, no Review run is going on it', since: ago(120), action: 'retry_review' }, ago(125), NOW)).toBe(
      'In review for 2 h: CI is green, no Review run is going on it',
    );
    expect(STALL_LIMITS).toEqual({ review: 2_700_000, running: 600_000, ready: 1_800_000, todo: 600_000 });
  });
});

describe('stuck tasks in the engine (#237)', () => {
  const backdate = (e: Awaited<ReturnType<typeof launch>>['engine'], id: string, min: number) =>
    e.db.prepare('UPDATE cards SET status_since = ? WHERE id = ?').run(new Date(Date.now() - min * 60_000).toISOString(), id);

  it('status_since is set in the same statement as every status change, and only then', async () => {
    const { engine: e } = await launch({ dispatch: false });
    const c = e.kanban.create({ title: 'x', status: 'todo', assignee: 'atlas' }, 'user');
    expect(c.statusSince).toBe(c.createdAt);
    backdate(e, c.id, 60);
    const before = e.kanban.get(c.id).statusSince!;
    e.kanban.update(c.id, { title: 'y', priority: 2 }, 'user');
    expect(e.kanban.get(c.id).statusSince).toBe(before);
    e.kanban.update(c.id, { status: 'ready' }, 'user');
    expect(Date.parse(e.kanban.get(c.id).statusSince!)).toBeGreaterThan(Date.now() - 5000);
    backdate(e, c.id, 60);
    e.kanban.block(c.id, { kind: 'needs_input', reason: 'which?' }, 'atlas');
    expect(Date.parse(e.kanban.get(c.id).statusSince!)).toBeGreaterThan(Date.now() - 5000);
  });

  it('a stuck task: one mark, one Inbox item, one note to the lead; it stays one across checks and a restart, and clears when the task moves', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-stalls-'));
    const dbFile = join(dataDir, 'atlas.db');
    let t = await launch({ dbFile, dataDir, dispatch: false, script: [text('on it'), text('on it')] });
    let e = t.engine;
    const c = e.kanban.create({ title: 'Workflows', status: 'ready', assignee: 'atlas' }, 'user');
    e.kanban.update(c.id, { status: 'running' }, 'dispatcher'); // working, but no run ever started
    backdate(e, c.id, 12);
    const items = () => e.db.prepare("SELECT id, title, body, archived_at FROM notifications WHERE kind = 'card.stalled' AND card_id = ?").all(c.id) as { id: number; title: string; body: string; archived_at: string | null }[];
    const lead = () => e.kanban.mainChat('atlas');
    const notes = () => e.kanban.messages(lead().id).filter((m) => m.author === 'system' && JSON.stringify(m.content).includes('is stuck'));

    e.stalls.check();
    expect(e.kanban.get(c.id).stall).toMatchObject({ rule: 'running', reason: 'no run started', action: 'restart' });
    expect(items()).toMatchObject([{ title: 'Stuck: Workflows', body: 'Working for 12 min: no run started. Restart the run starts a new run of the task.', archived_at: null }]);
    expect(e.notifications.inbox().updates.map((u) => u.kind)).toContain('card.stalled');
    expect(notes()).toHaveLength(1);
    expect(JSON.stringify(notes()[0]!.content)).toContain(`Task #${c.number} “Workflows” is stuck: Working for 12 min: no run started.`);
    await t.idle(lead().id);

    e.stalls.check();
    e.stalls.check();
    expect(items()).toHaveLength(1);
    expect(notes()).toHaveLength(1);

    // Restart: the row is in SQLite; no second item, no second note.
    await e.stop();
    t = await launch({ dbFile, dataDir, dispatch: false, script: [] });
    e = t.engine;
    expect(e.kanban.get(c.id).stall).toMatchObject({ rule: 'running' });
    e.stalls.check();
    expect(items()).toHaveLength(1);
    expect(notes()).toHaveLength(1);

    // It moves (blocked waits for Master: never stuck): the mark and the item go by themselves.
    e.kanban.block(c.id, { kind: 'needs_input', reason: 'which one?' }, 'atlas');
    e.stalls.check();
    expect(e.kanban.get(c.id).stall).toBe(null);
    expect(items()).toMatchObject([{ archived_at: expect.any(String) }]);
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM card_stalls').get()).toEqual({ n: 0 });
  });

  it('another reason is another item (the first one archived); Restart the run starts a fresh run', async () => {
    const { engine: e, idle } = await launch({ dispatch: false, script: [text('lead: looking'), text('lead: looking'), text('working again')] });
    const c = e.kanban.create({ title: 'Inbox', status: 'ready', assignee: 'atlas' }, 'user');
    backdate(e, c.id, 31);
    e.stalls.check();
    expect(e.kanban.get(c.id).stall).toMatchObject({ rule: 'ready', reason: '@atlas has a free slot but no run started' });
    // Before the lead's run ends (its end would start the ready task: a free slot).
    e.kanban.update(c.id, { status: 'running' }, 'dispatcher');
    backdate(e, c.id, 15);
    e.stalls.check();
    const rows = e.db.prepare("SELECT body, archived_at FROM notifications WHERE kind = 'card.stalled' ORDER BY id").all() as { body: string; archived_at: string | null }[];
    expect(rows).toMatchObject([{ body: expect.stringContaining('Ready for 31 min') , archived_at: expect.any(String) }, { body: expect.stringContaining('Working for 15 min'), archived_at: null }]);
    await idle(e.kanban.mainChat('atlas').id);

    // Restart the run (the Inbox action = Retry): back to Ready, the dispatcher starts a work run.
    await e.dispatcher.retry(c.id);
    expect(e.kanban.get(c.id).status).toBe('ready');
    e.dispatcher.start(60_000);
    await eventually(() => e.runner.runs(c.id).some((r) => r.kind === 'work'), { what: 'a fresh work run' });
    e.dispatcher.stop();
  });
});
