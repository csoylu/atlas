import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEngine, type Engine } from './index.ts';
import { Schedules, upcoming } from './schedules.ts';
import { FakeProvider } from './providers/fake.ts';
import { runTeamTool } from './teamTools.ts';

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

/** An engine (dispatcher off: cards stay where the scheduler puts them) and a Schedules on a controllable clock. */
async function setup(start = '2026-11-10T07:00:00Z', dbFile = ':memory:') {
  const engine = await startEngine({ dbFile, dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, providers: () => new FakeProvider([]), env: {} });
  engines.push(engine);
  const clock = { now: new Date(start) };
  const schedules = new Schedules(engine.db, engine.bus, engine.kanban, () => clock.now);
  return { engine, schedules, clock, at: (iso: string) => (clock.now = new Date(iso)) };
}

const weekdays9 = { agentId: 'atlas', kind: 'cron' as const, cron: '0 9 * * 1-5', timezone: 'Europe/Paris', prompt: 'Write the morning report.\nCompare with yesterday.' };

describe('schedules (design §9)', () => {
  it('computes cron times in the schedule time zone', () => {
    // Fri 14 Nov 2026 10:00 UTC → next weekday 09:00 Paris (UTC+1) is Mon 16 Nov 08:00 UTC.
    expect(upcoming({ kind: 'cron', cron: '0 9 * * 1-5', at: null, timezone: 'Europe/Paris' }, new Date('2026-11-14T10:00:00Z'), 2)).toEqual([
      '2026-11-16T08:00:00.000Z',
      '2026-11-17T08:00:00.000Z',
    ]);
  });

  it('validates: cron syntax, time zone, kind fields, past one-shots, unknown agent', async () => {
    const { schedules } = await setup();
    expect(() => schedules.create({ ...weekdays9, cron: '61 * * * *' }, 'can')).toThrow(/cron "61 \* \* \* \*"/);
    expect(() => schedules.create({ ...weekdays9, timezone: 'Mars/Olympus' }, 'can')).toThrow(/unknown time zone/);
    expect(() => schedules.create({ ...weekdays9, cron: null }, 'can')).toThrow(/needs a cron expression/);
    expect(() => schedules.create({ agentId: 'atlas', kind: 'at', at: '2026-11-01T09:00:00Z', prompt: 'x' }, 'can')).toThrow(/in the past/);
    expect(() => schedules.create({ ...weekdays9, agentId: 'ghost' }, 'can')).toThrow(/agent ghost does not exist/);
  });

  it("posts on the schedule's own card each run, reopening it, and fires each slot once", async () => {
    const { engine, schedules, at } = await setup();
    const s = schedules.create(weekdays9, 'can');
    expect(s).toMatchObject({ title: 'Write the morning report.', nextRunAt: '2026-11-10T08:00:00.000Z', enabled: true, chatCardId: null });

    at('2026-11-10T07:59:00Z');
    schedules.tick();
    expect(engine.kanban.list()).toHaveLength(0);

    at('2026-11-10T08:00:20Z');
    schedules.tick();
    schedules.tick(); // same slot again: nothing more
    const fired = schedules.get(s.id);
    expect(fired.nextRunAt).toBe('2026-11-11T08:00:00.000Z');
    const card = engine.kanban.get(fired.chatCardId!);
    expect(card).toMatchObject({ status: 'ready', assignee: 'atlas', title: 'Write the morning report.' });
    expect(engine.kanban.messages(card.id)).toHaveLength(1);
    expect(engine.kanban.messages(card.id)[0]).toMatchObject({ author: 'schedule', role: 'user' });

    // The agent finished; next morning the same card reopens with the new prompt after the old conversation.
    engine.kanban.update(card.id, { status: 'done' }, 'atlas');
    at('2026-11-11T08:00:05Z');
    schedules.tick();
    expect(engine.kanban.list()).toHaveLength(1);
    expect(engine.kanban.get(card.id).status).toBe('ready');
    expect(engine.kanban.messages(card.id)).toHaveLength(2);
  });

  it('leaves a blocked card blocked (the prompt waits for Can) and recreates an archived own card', async () => {
    const { engine, schedules, at } = await setup();
    const s = schedules.create(weekdays9, 'can');
    at('2026-11-10T08:00:00Z');
    schedules.tick();
    const cardId = schedules.get(s.id).chatCardId!;
    engine.kanban.block(cardId, { kind: 'needs_input', reason: 'which format?' }, 'atlas');
    at('2026-11-11T08:00:00Z');
    schedules.tick();
    expect(engine.kanban.get(cardId).status).toBe('blocked');
    expect(engine.kanban.messages(cardId)).toHaveLength(2);

    engine.kanban.update(cardId, { status: 'archived' }, 'can');
    at('2026-11-12T08:00:00Z');
    schedules.tick();
    expect(schedules.get(s.id).chatCardId).not.toBe(cardId);
  });

  it('creates a new ready card per run when asked, and a one-shot fires once then turns off', async () => {
    const { engine, schedules, at } = await setup();
    const daily = schedules.create({ ...weekdays9, createCard: true, title: 'Morning report' }, 'can');
    const once = schedules.create({ agentId: 'atlas', kind: 'at', at: '2026-11-10T12:30:00+01:00', prompt: 'Renew the domain' }, 'can');
    at('2026-11-10T11:31:00Z');
    schedules.tick();
    at('2026-11-11T08:00:00Z');
    schedules.tick();
    const titles = engine.kanban.list().map((c) => c.title).sort();
    expect(titles).toEqual(['Morning report · Tue 10 Nov', 'Morning report · Wed 11 Nov', 'Renew the domain']);
    expect(engine.kanban.list().every((c) => c.status === 'ready' && c.assignee === 'atlas')).toBe(true);
    expect(schedules.get(once.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(schedules.get(daily.id).chatCardId).toBeNull();
  });

  it('after downtime, fires a missed run once (noted), not once per missed slot', async () => {
    const { engine, schedules, at } = await setup();
    const s = schedules.create({ ...weekdays9, cron: '0 * * * *', createCard: true, title: 'Hourly' }, 'can');
    at('2026-11-10T13:20:00Z'); // 6 slots missed
    schedules.tick();
    const cards = engine.kanban.list();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.body).toContain('due Tue 10 Nov, 09:00: Atlas was not running then');
    expect(schedules.get(s.id).nextRunAt).toBe('2026-11-10T14:00:00.000Z');
  });

  it('survives a restart: the claim and the card are one transaction, so no slot fires twice', async () => {
    const dbFile = join(mkdtempSync(join(tmpdir(), 'atlas-')), 'a.db');
    const first = await setup('2026-11-10T07:00:00Z', dbFile);
    const s = first.schedules.create({ ...weekdays9, createCard: true }, 'can');
    first.at('2026-11-10T08:00:01Z');
    first.schedules.tick();
    await first.engine.stop();
    const second = await setup('2026-11-10T08:00:02Z', dbFile);
    second.schedules.tick();
    expect(second.engine.kanban.list()).toHaveLength(1);
    expect(second.schedules.get(s.id).nextRunAt).toBe('2026-11-11T08:00:00.000Z');
  });

  it('records a failure on the schedule, moves past the slot, and keeps the others firing', async () => {
    const { engine, schedules, at } = await setup();
    engine.agents.create({ id: 'temp', modelId: engine.agents.get('atlas').modelId });
    const bad = schedules.create({ ...weekdays9, agentId: 'temp' }, 'can');
    const good = schedules.create({ ...weekdays9, createCard: true }, 'can');
    engine.db.pragma('foreign_keys = OFF'); // simulate an agent removed without cascading
    engine.db.prepare("DELETE FROM agents WHERE id = 'temp'").run();
    at('2026-11-10T08:00:00Z');
    schedules.tick();
    expect(schedules.get(bad.id)).toMatchObject({ lastError: 'agent temp does not exist', nextRunAt: '2026-11-11T08:00:00.000Z', enabled: true });
    expect(schedules.get(good.id).lastCardId).toBeTruthy();
  });

  it('edits recompute the next run; run-now fires without moving it; delete keeps the cards', async () => {
    const { engine, schedules } = await setup();
    const s = schedules.create(weekdays9, 'can');
    const edited = schedules.update(s.id, { cron: '30 18 * * *', title: 'Evening report' });
    expect(edited).toMatchObject({ title: 'Evening report', cron: '30 18 * * *', nextRunAt: '2026-11-10T17:30:00.000Z' });
    expect(schedules.update(s.id, { enabled: false })).toMatchObject({ enabled: false, nextRunAt: null });
    expect(() => schedules.update(s.id, { kind: 'at' })).toThrow(/needs a time/);
    const switched = schedules.update(s.id, { kind: 'at', at: '2026-12-01T09:00:00+01:00', enabled: true });
    expect(switched).toMatchObject({ cron: null, nextRunAt: '2026-12-01T08:00:00.000Z' });

    const card = schedules.runNow(s.id);
    expect(card.status).toBe('ready');
    expect(engine.kanban.messages(card.id)[0]!.content[0]).toMatchObject({ text: expect.stringContaining('run by hand') });
    expect(schedules.get(s.id).nextRunAt).toBe('2026-12-01T08:00:00.000Z');
    schedules.remove(s.id);
    expect(() => schedules.get(s.id)).toThrow(/not found/);
    expect(engine.kanban.get(card.id)).toBeTruthy();
  });

  it('agents schedule through tools', async () => {
    const { engine } = await setup();
    const ctx = { kanban: engine.kanban, memories: engine.memories, schedules: engine.schedules, agentId: 'atlas', cardId: 'c_x', deliver: () => {} };
    const made = runTeamTool('schedule_create', { prompt: 'Check the backups', cron: '0 3 * * *', timezone: 'Europe/Paris' }, ctx);
    expect(made).toMatchObject({ isError: false, output: expect.stringMatching(/^scheduled sch_\w+ "Check the backups" for @atlas: cron "0 3 \* \* \*" \(Europe\/Paris\)/) });
    expect(runTeamTool('schedule_create', { prompt: 'x' }, ctx)).toMatchObject({ isError: true, output: 'give exactly one of cron or at' });
    expect(runTeamTool('schedule_list', {}, ctx).output).toContain('own card (created on first run)');
    const id = engine.schedules.list()[0]!.id;
    expect(runTeamTool('schedule_delete', { id }, ctx).output).toBe(`schedule ${id} deleted`);
  });

  it('the engine stops its scheduler on stop (no timer left on a closed database)', async () => {
    const engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, providers: () => new FakeProvider([]), env: {} });
    engine.schedules.create(weekdays9, 'can');
    await engine.stop();
    expect(() => engine.schedules.tick()).toThrow(/not open/); // the db is closed; the timer is gone, so nothing calls this
    expect(engine.schedules['timer']).toBeUndefined();
  });
});
