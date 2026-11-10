import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { realProviders } from './models.ts';
import { TRIAGE_KICK, WORK_KICK } from './dispatcher.ts';
import { ModelError } from './providers/types.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});

async function setup(fake: FakeProvider | null) {
  engine = await startEngine({
    dbFile: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    providers: fake ? () => fake : realProviders,
    env: {},
  });
  return engine;
}

async function until(cond: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input });
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

describe('dispatcher', () => {
  it('triages a raw idea, then works it to done', async () => {
    let cardId = '';
    const fake = new FakeProvider([
      () => [use('card_update', { id: cardId, title: 'Landing hero', body: 'Hero with CTA. Done when it renders.', assignee: 'atlas', priority: 2, status: 'ready' })],
      text('Triaged: ready for @atlas.'),
      [use('card_complete', { summary: 'Hero built and checked.' })],
    ]);
    const e = await setup(fake);
    cardId = e.kanban.create({ title: 'landing hero thing' }, 'can').id;

    await until(() => e.kanban.get(cardId).status === 'done', 'card done');
    const card = e.kanban.get(cardId);
    expect(card).toMatchObject({ title: 'Landing hero', assignee: 'atlas', priority: 2 });
    expect(e.runner.runs(cardId).map((r) => [r.kind, r.status]).reverse()).toEqual([
      ['triage', 'done'],
      ['work', 'done'],
    ]);
    const system = e.kanban.messages(cardId).filter((m) => m.author === 'system');
    expect(system.map((m) => (m.content[0] as { text: string }).text)).toEqual([TRIAGE_KICK, WORK_KICK]);
    expect(fake.calls[0]!.system).toContain('TASK: triage this card');
    expect(fake.calls[2]!.system).toContain('TASK: do this card');
  });

  it('keeps a child in todo until its parent is done', async () => {
    const fake = new FakeProvider([[use('card_complete', { summary: 'parent done' })], [use('card_complete', { summary: 'child done' })]]);
    const e = await setup(fake);
    e.dispatcher.stop(); // set up both cards before anything runs
    const parent = e.kanban.create({ title: 'API', status: 'ready', assignee: 'atlas' }, 'can');
    const child = e.kanban.create({ title: 'UI', status: 'ready', assignee: 'atlas', parents: [parent.id] }, 'can');
    expect(e.kanban.get(child.id).status).toBe('todo');
    expect(e.kanban.get(child.id).waiting).toBe(`waiting on ${parent.id} (ready)`);
    expect(() => e.kanban.update(parent.id, { parents: [child.id] }, 'can')).toThrow(/cycle/);

    e.dispatcher.start(20);
    await until(() => e.kanban.get(child.id).status === 'done', 'child done');
    expect(e.kanban.get(parent.id).status).toBe('done');
  });

  it('blocks with the last message when an agent stops without finishing, and resumes on answer', async () => {
    const fake = new FakeProvider([text('Which colour do you want, blue or green?'), [use('card_complete', { summary: 'blue it is' })]]);
    const e = await setup(fake);
    const card = e.kanban.create({ title: 'Button', status: 'ready', assignee: 'atlas' }, 'can');
    await until(() => e.kanban.get(card.id).status === 'blocked', 'blocked');
    expect(e.kanban.get(card.id).block).toMatchObject({ kind: 'needs_input', reason: 'Which colour do you want, blue or green?' });

    e.kanban.appendMessage(card.id, 'user', 'can', text('blue'));
    e.dispatcher.onUserMessage(card.id);
    await until(() => e.kanban.get(card.id).status === 'done', 'done after answer');
    expect(e.kanban.get(card.id).block).toBeNull();
    expect(fake.calls[1]!.messages.at(-1)!.content).toEqual(text('blue'));
  });

  it('blocks a card whose model cannot be used, without retrying in a loop', async () => {
    const e = await setup(null); // real providers, no ANTHROPIC_API_KEY
    const triage = e.kanban.create({ title: 'idea' }, 'can');
    expect(e.kanban.get(triage.id).waiting).toMatch(/no Anthropic account/);
    const card = e.kanban.create({ title: 'work', status: 'ready', assignee: 'atlas' }, 'can');
    await new Promise((r) => setTimeout(r, 200));
    expect(e.kanban.get(card.id).status).toBe('ready');
    expect(e.kanban.get(card.id).waiting).toMatch(/no Anthropic account/);
    expect(e.runner.runs(card.id)).toEqual([]);
    expect(e.runner.runs(triage.id)).toEqual([]);
  });

  it('waits for Can after a failed triage run, and retries when he writes', async () => {
    const fake = new FakeProvider([text('pong'), text('Shaped it.')]); // the re-test, then the triage
    let fail = true;
    const complete = fake.complete.bind(fake);
    fake.complete = async (req, onText, signal) => {
      if (fail) throw new ModelError('model local at http://x is not reachable: ECONNREFUSED');
      return complete(req, onText, signal);
    };
    const e = await setup(fake);
    const card = e.kanban.create({ title: 'idea' }, 'can');
    await until(() => e.runner.runs(card.id)[0]?.status === 'failed', 'failed triage');
    await new Promise((r) => setTimeout(r, 100));
    expect(e.runner.runs(card.id)).toHaveLength(1); // no retry loop
    expect(e.kanban.get(card.id).waiting).toBe(
      'model sonnet failed: model local at http://x is not reachable: ECONNREFUSED. Fix it, then Retry (it re-tests the model)',
    );
    expect(e.models.get('sonnet').lastError).toMatch(/not reachable/);
    fail = false;
    await new Promise((r) => setTimeout(r, 5)); // Can's message must be later than the failed run
    e.kanban.appendMessage(card.id, 'user', 'can', text('server is up now'));
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
      order.push(req.system.match(/Current card: (c_\w+)/)![1]!);
      await gate;
      return { content: [use('card_complete', { summary: 'ok' })], stopReason: 'tool_use', usage: { input: 1, output: 1 } };
    };
    const e = await setup(fake);
    e.dispatcher.stop();
    const low = e.kanban.create({ title: 'low', status: 'ready', assignee: 'atlas', priority: 0 }, 'can');
    const high = e.kanban.create({ title: 'high', status: 'ready', assignee: 'atlas', priority: 3 }, 'can');
    e.dispatcher.start(20);
    await until(() => order.length === 1, 'first run');
    expect(order).toEqual([high.id]);
    await until(() => e.kanban.get(low.id).waiting === `@atlas is busy with ${high.id}`, 'busy reason');
    release();
    await until(() => e.kanban.get(low.id).status === 'done', 'low done');
  });

  it('retries a transient block when its time comes', async () => {
    const fake = new FakeProvider([[use('card_complete', { summary: 'ok' })]]);
    const e = await setup(fake);
    const card = e.kanban.create({ title: 'x', status: 'triage', assignee: 'atlas' }, 'can');
    e.settings.update({ triageAgent: null });
    e.kanban.block(card.id, { kind: 'transient', reason: 'rate limited', until: new Date(Date.now() - 1).toISOString() }, 'atlas');
    e.dispatcher.tick();
    await until(() => e.kanban.get(card.id).status === 'done', 'done after retry');
  });
});
