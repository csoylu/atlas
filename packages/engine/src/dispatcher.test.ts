import { cardRef } from '@atlas/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { realProviders } from './models.ts';
import { TRIAGE_KICK, WORK_KICK } from './dispatcher.ts';
import { stopNote } from './loopGuard.ts';
import { ModelError } from './providers/types.ts';
import { until } from '../test/kit/index.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});

async function setup(fake: FakeProvider | null, maxTurns?: number) {
  engine = await startEngine({ memoryReview: false, sandbox: { enabled: false }, 
    maxTurns,
    dbFile: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    providers: fake ? () => fake : realProviders,
    env: {},
  });
  return engine;
}


const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input });
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

describe('dispatcher', () => {
  it('triages a raw idea, then works it to done', async () => {
    let cardId = '';
    const fake = new FakeProvider([
      () => [use('task_update', { id: cardId, title: 'Landing hero', body: 'Hero with CTA. Done when it renders.', assignee: 'atlas', priority: 2, status: 'ready' })],
      text('Triaged: ready for @atlas.'),
      [use('task_complete', { summary: 'Hero built and checked.' })],
    ]);
    const e = await setup(fake);
    cardId = e.kanban.create({ title: 'landing hero thing' }, 'user').id;

    await until(() => e.kanban.get(cardId).status === 'done', 'card done');
    const card = e.kanban.get(cardId);
    expect(card).toMatchObject({ title: 'Landing hero', assignee: 'atlas', priority: 2 });
    expect(e.runner.runs(cardId).map((r) => [r.kind, r.status]).reverse()).toEqual([
      ['triage', 'done'],
      ['work', 'done'],
    ]);
    const system = e.kanban.messages(cardId).filter((m) => m.author === 'system');
    expect(system.map((m) => (m.content[0] as { text: string }).text)).toEqual([TRIAGE_KICK, WORK_KICK]);
    expect(fake.calls[0]!.system).toContain('Your job: triage the task below');
    expect(fake.calls[2]!.system).toContain('Your job: do the task below');
  });

  it('keeps a child in todo until its parent is done', async () => {
    const fake = new FakeProvider([[use('task_complete', { summary: 'parent done' })], [use('task_complete', { summary: 'child done' })]]);
    const e = await setup(fake);
    e.dispatcher.stop(); // set up both cards before anything runs
    const parent = e.kanban.create({ title: 'API', status: 'ready', assignee: 'atlas' }, 'user');
    const child = e.kanban.create({ title: 'UI', status: 'ready', assignee: 'atlas', parents: [parent.id] }, 'user');
    expect(e.kanban.get(child.id).status).toBe('todo');
    expect(e.kanban.get(child.id).waiting).toBe(`waiting on ${cardRef(parent)} (ready)`);
    expect(() => e.kanban.update(parent.id, { parents: [child.id] }, 'user')).toThrow(/cycle/);

    e.dispatcher.start(20);
    await until(() => e.kanban.get(child.id).status === 'done', 'child done');
    expect(e.kanban.get(parent.id).status).toBe('done');
  });

  it('blocks with the last message when an agent stops without finishing, and resumes on answer', async () => {
    // A long status update with a table: kept whole, never cut (it was cut at 600 chars + « … »).
    const question = 'Here is where it stands.\n\n| Option | Cost |\n|---|---|\n' + '| blue | 1 |\n'.repeat(80) + '\nWhich colour do you want, blue or green?';
    const fake = new FakeProvider([text(question), [use('task_complete', { summary: 'blue it is' })]]);
    const e = await setup(fake);
    const card = e.kanban.create({ title: 'Button', status: 'ready', assignee: 'atlas' }, 'user');
    await until(() => e.kanban.get(card.id).status === 'blocked', 'blocked');
    expect(e.kanban.get(card.id).block).toMatchObject({ kind: 'needs_input', reason: question });

    e.kanban.appendMessage(card.id, 'user', 'user', text('blue'));
    e.dispatcher.onUserMessage(card.id);
    await until(() => e.kanban.get(card.id).status === 'done', 'done after answer');
    expect(e.kanban.get(card.id).block).toBeNull();
    expect(fake.calls[1]!.messages.at(-1)!.content).toEqual(text('blue'));
  });

  it("the lead's own work run reaching the safety ceiling asks Master (not failed) and the reply resumes it", async () => {
    const fake = new FakeProvider([[use('shell', { command: 'echo 1' })], [use('shell', { command: 'echo 2' })], [use('task_complete', { summary: 'finished after the pause' })]]);
    const e = await setup(fake, 2);
    const card = e.kanban.create({ title: 'Long', status: 'ready', assignee: 'atlas' }, 'user');
    await until(() => e.kanban.get(card.id).status === 'blocked', 'paused');
    expect(e.kanban.get(card.id).block).toMatchObject({ kind: 'needs_input', reason: `${stopNote('reached the safety ceiling of 2 turns in one run')} Write what to do next: a reply resumes the task.` });
    expect(e.runner.runs(card.id)[0]).toMatchObject({ status: 'done', error: null });

    e.kanban.appendMessage(card.id, 'user', 'user', text('continue'));
    e.dispatcher.onUserMessage(card.id);
    await until(() => e.kanban.get(card.id).status === 'done', 'done after reply');
  });

  it('blocks a card whose model cannot be used, without retrying in a loop', async () => {
    const e = await setup(null); // real providers, no ANTHROPIC_API_KEY
    const triage = e.kanban.create({ title: 'idea' }, 'user');
    expect(e.kanban.get(triage.id).waiting).toMatch(/no Anthropic account/);
    const card = e.kanban.create({ title: 'work', status: 'ready', assignee: 'atlas' }, 'user');
    await new Promise((r) => setTimeout(r, 200));
    expect(e.kanban.get(card.id).status).toBe('ready');
    expect(e.kanban.get(card.id).waiting).toMatch(/no Anthropic account/);
    expect(e.runner.runs(card.id)).toEqual([]);
    expect(e.runner.runs(triage.id)).toEqual([]);
  });

  it('waits for the user after a failed triage run, and retries when the user writes', async () => {
    const fake = new FakeProvider([text('pong'), text('Shaped it.')]); // the re-test, then the triage
    let fail = true;
    const complete = fake.complete.bind(fake);
    fake.complete = async (req, onText, signal) => {
      if (fail) throw new ModelError('model local at http://x is not reachable: ECONNREFUSED');
      return complete(req, onText, signal);
    };
    const e = await setup(fake);
    const card = e.kanban.create({ title: 'idea' }, 'user');
    await until(() => e.runner.runs(card.id)[0]?.status === 'failed', 'failed triage');
    await new Promise((r) => setTimeout(r, 100));
    expect(e.runner.runs(card.id)).toHaveLength(1); // no retry loop
    expect(e.kanban.get(card.id).waiting).toBe(
      'model sonnet failed: model local at http://x is not reachable: ECONNREFUSED. Fix it, then Retry (it re-tests the model)',
    );
    expect(e.models.get('sonnet').lastError).toMatch(/not reachable/);
    fail = false;
    await new Promise((r) => setTimeout(r, 5)); // the user's message must be later than the failed run
    e.kanban.appendMessage(card.id, 'user', 'user', text('server is up now'));
    e.dispatcher.onUserMessage(card.id);
    await until(() => e.runner.runs(card.id)[0]?.status === 'done', 'retried triage');
    expect(e.models.get('sonnet').lastError).toBeNull();
    expect(e.kanban.get(card.id).waiting).toBe('waiting for your answer');
  });

  it('shows when the assignee is busy, and runs cards by priority', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const fake = new FakeProvider([]);
    fake.complete = async (req) => {
      order.push(req.system.match(/# Current task\n(#\d+)/)![1]!);
      await gate;
      return { content: [use('task_complete', { summary: 'ok' })], stopReason: 'tool_use', usage: { input: 1, output: 1 } };
    };
    const e = await setup(fake);
    e.dispatcher.stop();
    const low = e.kanban.create({ title: 'low', status: 'ready', assignee: 'atlas', priority: 0 }, 'user');
    const high = e.kanban.create({ title: 'high', status: 'ready', assignee: 'atlas', priority: 3 }, 'user');
    e.dispatcher.start(20);
    await until(() => order.length === 1, 'first run');
    expect(order).toEqual([cardRef(high)]);
    await until(() => e.kanban.get(low.id).waiting === `@atlas is busy with ${cardRef(high)}`, 'busy reason');
    release();
    await until(() => e.kanban.get(low.id).status === 'done', 'low done');
  });

  it('retries a transient block when its time comes', async () => {
    const fake = new FakeProvider([[use('task_complete', { summary: 'ok' })]]);
    const e = await setup(fake);
    const card = e.kanban.create({ title: 'x', status: 'triage', assignee: 'atlas' }, 'user');
    e.settings.update({ triageAgent: null });
    e.kanban.block(card.id, { kind: 'transient', reason: 'rate limited', until: new Date(Date.now() - 1).toISOString() }, 'atlas');
    e.dispatcher.tick();
    await until(() => e.kanban.get(card.id).status === 'done', 'done after retry');
  });
});

describe('a ready task that does not start (#327)', () => {
  it('an error on one ready task never keeps the others from starting, and shows on it', async () => {
    const fake = new FakeProvider([[use('task_complete', { summary: 'ok' })]]);
    const e = await setup(fake);
    e.dispatcher.stop();
    const bad = e.kanban.create({ title: 'bad', status: 'ready', assignee: 'atlas', priority: 3 }, 'user');
    const good = e.kanban.create({ title: 'good', status: 'ready', assignee: 'atlas', priority: 0 }, 'user');
    const wake = e.runner.wake.bind(e.runner);
    vi.spyOn(e.runner, 'wake').mockImplementation((id, o) => {
      if (id === bad.id) throw new Error('disk I/O error');
      return wake(id, o);
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    e.dispatcher.start(20);
    // Before #327 the first card's error ended every tick: the second never started, and both said « starting… ».
    await until(() => e.kanban.get(good.id).status === 'done', 'the other task done');
    expect(e.kanban.get(bad.id)).toMatchObject({ status: 'ready', waiting: 'could not start: disk I/O error' });
    expect(e.runner.runs(bad.id)).toEqual([]);
    err.mockRestore();
  });

  it('a ready task whose run is refused says why, and stays in Ready without flipping its status', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = new FakeProvider([]);
    fake.complete = async (req) => {
      if (req.system.includes('summar') || !req.tools?.length) {
        await gate;
        return { content: text('THE SUMMARY'), stopReason: 'end_turn', usage: { input: 1, output: 1 } };
      }
      return { content: [use('task_complete', { summary: 'ok' })], stopReason: 'tool_use', usage: { input: 1, output: 1 } };
    };
    const e = await setup(fake);
    e.dispatcher.stop();
    const c = e.kanban.create({ title: 'x', status: 'blocked', assignee: 'atlas' }, 'user');
    e.kanban.appendMessage(c.id, 'user', 'user', text('some history'));
    e.kanban.appendMessage(c.id, 'assistant', 'atlas', text('noted'));
    const compacting = e.runner.compactNow(c.id);
    e.kanban.update(c.id, { status: 'ready' }, 'user');
    const statusEvents = () => e.db.prepare("SELECT COUNT(*) AS n FROM card_events WHERE card_id = ? AND kind = 'status'").get(c.id) as { n: number };
    const before = statusEvents().n;
    e.dispatcher.start(10);
    await until(() => e.kanban.get(c.id).waiting === 'could not start: the conversation is being compacted', 'the reason');
    for (let i = 0; i < 5; i++) e.dispatcher.tick();
    // Before #327: « starting… », and Ready → Running → Ready on every tick (its time in Ready never grew: no stall).
    expect(e.kanban.get(c.id).status).toBe('ready');
    expect(statusEvents().n).toBe(before);
    release();
    await compacting;
    await until(() => e.kanban.get(c.id).status === 'done', 'starts once the compaction ends');
    expect(e.runner.runs(c.id).map((r) => r.kind)).toEqual(['work']);
  });

  it("another agent's message on a ready task starts its work run, not a chat run", async () => {
    const fake = new FakeProvider([[use('task_complete', { summary: 'done it' })]]);
    const e = await setup(fake);
    e.dispatcher.stop(); // only the message can start it
    const c = e.kanban.create({ title: 'x', status: 'ready', assignee: 'atlas' }, 'user');
    expect(e.kanban.get(c.id).waiting).toBe('the dispatcher is stopped (Atlas is stopping): no task starts until Atlas restarts');
    e.kanban.appendMessage(c.id, 'user', 'zurich', text('[from @zurich, task #1] why is this not moving?'));
    e.dispatcher.onAgentMessage(c.id);
    // Before #327: a chat run did the task while the card stayed in Ready (« answering you first »).
    expect(e.runner.current(c.id)?.kind).toBe('work');
    expect(e.kanban.get(c.id).status).toBe('running');
    await until(() => e.kanban.get(c.id).status === 'done', 'done');
  });

  it('a stopping engine starts no run and says so', async () => {
    const e = await setup(new FakeProvider([]));
    e.dispatcher.stop();
    const c = e.kanban.create({ title: 'x', status: 'ready', assignee: 'atlas' }, 'user');
    await e.runner.shutdown();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(e.runner.wake(c.id, { kind: 'chat', kick: 'hello' })).toBe(null);
    expect(e.runner.refusal(c.id)).toBe('Atlas is stopping: no run starts until it restarts');
    expect(e.runner.runs(c.id)).toEqual([]);
    err.mockRestore();
  });
});
