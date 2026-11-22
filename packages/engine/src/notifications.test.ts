import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, Inbox, ServerEvent } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { ModelError } from './providers/types.ts';
import { until } from '../test/kit/index.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});

/** No dispatcher: the tests move cards themselves. */
async function setup(o: { dbFile?: string; dataDir?: string; fake?: FakeProvider } = {}) {
  engine = await startEngine({
    dbFile: o.dbFile ?? ':memory:',
    dataDir: o.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    dispatch: !!o.fake,
    manageLocal: false,
    env: {},
    ...(o.fake ? { providers: () => o.fake! } : {}),
  });
  return engine;
}
const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input });

describe('inbox', () => {
  it('needs you: blocked (not transient, not stopped by you), from the live card; in review waits for QA, not you', async () => {
    const e = await setup();
    const events: ServerEvent[] = [];
    e.bus.on((ev) => events.push(ev));
    const ask = e.kanban.create({ title: 'Pick a data source', status: 'ready', assignee: 'atlas' }, 'user');
    e.kanban.block(ask.id, { kind: 'needs_input', reason: 'Kaiko or CoinGecko?', options: ['Kaiko', 'CoinGecko'] }, 'atlas');
    const created = events.filter((ev) => ev.type === 'notification.created');
    expect(created).toMatchObject([{ notification: { kind: 'card.blocked', title: 'Pick a data source', body: 'Kaiko or CoinGecko?', cardId: ask.id } }]);
    // Announced after the commit: the row is there when the event arrives (same order as card.updated).
    expect(events.findIndex((ev) => ev.type === 'notification.created')).toBeLessThan(events.findIndex((ev) => ev.type === 'card.updated' && ev.card.id === ask.id && ev.card.status === 'blocked'));

    const stopped = e.kanban.create({ title: 'Stopped one', status: 'ready', assignee: 'atlas' }, 'user');
    e.kanban.block(stopped.id, { kind: 'needs_input', reason: 'Stopped by you.', stopped: true }, 'user');
    const waiting = e.kanban.create({ title: 'Rate limited', status: 'ready', assignee: 'atlas' }, 'user');
    e.kanban.block(waiting.id, { kind: 'transient', reason: '429', until: new Date(Date.now() + 60_000).toISOString() }, 'dispatcher');
    const rev = e.kanban.create({ title: 'MEV primer', status: 'ready', assignee: 'atlas' }, 'user');
    e.kanban.update(rev.id, { status: 'review' }, 'atlas', '2 400 words · docs/mev-primer.md');

    let inbox = e.notifications.inbox();
    expect(inbox.needsYou.map((n) => [n.card.title, n.unread, n.failed, n.summary])).toEqual([
      ['Stopped one', false, false, null], // still waits on you, but you did it: no row, no unread dot
      ['Pick a data source', true, false, null],
    ]);
    expect(inbox.updates).toEqual([]); // card.blocked rows never show as updates; in review writes none (#189)
    expect(inbox.badge).toBe(2);

    // Opening marks it read; the badge still counts it (it needs you).
    e.notifications.read(inbox.needsYou.find((n) => n.card.id === ask.id)!.notificationId!);
    inbox = e.notifications.inbox();
    expect(inbox.needsYou.find((n) => n.card.id === ask.id)!.unread).toBe(false);
    expect(inbox.badge).toBe(2);

    // Answering (the user's message moves it to ready) and approving make the items leave by themselves.
    e.kanban.update(ask.id, { status: 'ready' }, 'user');
    e.kanban.update(rev.id, { status: 'done' }, 'user');
    inbox = e.notifications.inbox();
    expect(inbox.needsYou.map((n) => n.card.title)).toEqual(['Stopped one']);
    expect(inbox.updates).toEqual([]); // approving yourself is not news
  });

  it('an earlier wait does not mark a new one read or unread', async () => {
    const e = await setup();
    const c = e.kanban.create({ title: 'Twice', status: 'ready', assignee: 'atlas' }, 'user');
    e.kanban.block(c.id, { kind: 'needs_input', reason: 'first?' }, 'atlas');
    e.notifications.read(e.notifications.inbox().needsYou[0]!.notificationId!);
    e.kanban.update(c.id, { status: 'ready' }, 'user');
    await new Promise((r) => setTimeout(r, 5));
    e.kanban.block(c.id, { kind: 'dependency', reason: 'waiting on #3' }, 'atlas'); // no row for this kind
    const [need] = e.notifications.inbox().needsYou;
    expect(need).toMatchObject({ notificationId: null, unread: false });
  });


  it('updates: done, schedule ran, system; read, archive, archive all read', async () => {
    const e = await setup();
    const done = e.kanban.create({ title: 'Palette', status: 'ready', assignee: 'atlas' }, 'user');
    e.kanban.update(done.id, { status: 'done' }, 'atlas', 'Typecheck + 412 tests green');
    const s = e.workflows.createOneStep({ title: 'Funding digest', prompt: 'write it', agentId: 'atlas', kind: 'cron', cron: '0 9 * * 1', timezone: 'Europe/Paris' }, 'user');
    const run = e.workflows.runNow(s.id).steps!.find((x) => x.kind === 'agent')!.cardId!;
    e.kanban.update(run, { status: 'done' }, 'atlas', '1 doc');
    e.notifications.create({ kind: 'plan.switched', title: 'Claude plan limit reached', body: 'Work moved to the API key account' });

    let inbox = e.notifications.inbox();
    expect(inbox.updates.map((u) => [u.kind, u.title, u.body, !!u.readAt])).toEqual([
      ['plan.switched', 'Claude plan limit reached', 'Work moved to the API key account', false],
      ['schedule.ran', 'Funding digest', '1 doc', false],
      ['card.done', 'Palette', 'Typecheck + 412 tests green', false],
    ]);
    expect(inbox.badge).toBe(3);

    const [system, schedule, card] = inbox.updates;
    e.notifications.read(card!.id);
    e.notifications.read(card!.id); // twice: no-op
    e.notifications.archive(schedule!.id);
    inbox = e.notifications.inbox();
    expect(inbox.updates.map((u) => u.kind)).toEqual(['plan.switched', 'card.done']);
    expect(inbox.badge).toBe(1);
    expect(e.notifications.list().find((n) => n.id === schedule!.id)).toMatchObject({ archivedAt: expect.any(String), readAt: expect.any(String) });

    expect(e.notifications.archiveRead()).toBe(1);
    inbox = e.notifications.inbox();
    expect(inbox.updates.map((u) => u.id)).toEqual([system!.id]);
    expect(() => e.notifications.read(9999)).toThrow(/not found/);
  });

  it('a failed work run: needs you with failed = true; a failed triage: a run.failed update', async () => {
    const fake = new FakeProvider([[use('task_complete', { summary: 'never' })]]);
    fake.complete = async () => {
      throw new ModelError('429 rate limit after 3 retries');
    };
    const e = await setup({ fake });
    const work = e.kanban.create({ title: 'Backfill funding rates', status: 'ready', assignee: 'atlas' }, 'user');
    const idea = e.kanban.create({ title: 'Raw idea' }, 'user');
    await until(() => e.kanban.get(work.id).status === 'blocked', 'work blocked');
    // The kit's Atlas has a Review workflow with no agent yet: its « Choose who reviews » item (#334) is not this test's.
    const updates = () => e.notifications.inbox().updates.filter((u) => u.kind !== 'workflow.no_agent');
    await until(() => updates().length > 0, 'triage failure noted');
    const inbox = e.notifications.inbox();
    expect(inbox.needsYou).toMatchObject([{ card: { id: work.id }, failed: true, unread: true }]);
    expect(updates()).toMatchObject([{ kind: 'run.failed', title: 'Raw idea', cardId: idea.id, body: expect.stringContaining('429 rate limit') }]);
  });

  it('serves the inbox over the API: list, read, archive, archive all read', async () => {
    const e = await setup();
    const c = e.kanban.create({ title: 'Done thing', status: 'ready', assignee: 'atlas' }, 'user');
    e.kanban.update(c.id, { status: 'done' }, 'atlas', 'ok');
    const events: ServerEvent[] = [];
    e.bus.on((ev) => events.push(ev));
    const get = async () => (await (await fetch(e.url + '/api/inbox')).json()) as Inbox;
    const post = (p: string) => fetch(e.url + '/api' + p, { method: 'POST' });

    const [u] = (await get()).updates;
    expect(u).toMatchObject({ kind: 'card.done', readAt: null, archivedAt: null });
    expect((await post(`/notifications/${u!.id}/read`)).status).toBe(204);
    expect(events.map((ev) => ev.type)).toContain('inbox.changed');
    expect((await get()).badge).toBe(0);
    expect(await (await post('/notifications/archive-read')).json()).toEqual({ archived: 1 });
    expect((await get()).updates).toEqual([]);
    expect((await post(`/notifications/${u!.id}/archive`)).status).toBe(204); // already archived: fine
    expect((await post('/notifications/9999/archive')).status).toBe(404);
    expect((await post('/notifications/abc/read')).status).toBe(400);
  });

  it('keeps read and archived state across a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const dbFile = join(dataDir, 'atlas.db');
    let e = await setup({ dbFile, dataDir });
    const a = e.kanban.create({ title: 'A', status: 'ready', assignee: 'atlas' }, 'user');
    const b = e.kanban.create({ title: 'B', status: 'ready', assignee: 'atlas' }, 'user');
    e.kanban.update(a.id, { status: 'done' }, 'atlas');
    e.kanban.block(b.id, { kind: 'needs_input', reason: 'look' }, 'atlas');
    const before = e.notifications.inbox();
    e.notifications.archive(before.updates[0]!.id);
    e.notifications.read(before.needsYou[0]!.notificationId!);
    await e.stop();
    engine = undefined;

    e = await setup({ dbFile, dataDir });
    const after = e.notifications.inbox();
    expect(after.updates).toEqual([]);
    expect(after.needsYou).toMatchObject([{ card: { id: b.id }, unread: false }]);
    expect(after.badge).toBe(1);
  });
});
