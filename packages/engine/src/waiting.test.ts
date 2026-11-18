import { cardRef, WORK_KICK, type ContentBlock } from '@atlas/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';

/** #131: waiting on other work or retrying later is not the user's problem: the card waits in todo, never blocked. */

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop();
  engines = [];
});

async function setup(fake: FakeProvider, o: { dbFile?: string; dataDir?: string } = {}) {
  const e = await startEngine({
    memoryReview: false,
    manageLocal: false,
    dbFile: o.dbFile ?? ':memory:',
    dataDir: o.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    providers: () => fake,
    env: {},
  });
  engines.push(e);
  return e;
}

async function until(cond: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input });
const systemTexts = (e: Engine, id: string) =>
  e.kanban.messages(id).filter((m) => m.author === 'system').map((m) => (m.content[0] as { text: string }).text);
const toolResults = (e: Engine, id: string) =>
  e.kanban.messages(id).flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_result' ? [JSON.stringify(b.content)] : [])));

describe('waiting on other tasks (task_block dependency)', () => {
  it('waits in todo on the task, out of the Inbox, and starts by itself when that task is done', async () => {
    let parentRef = '';
    const fake = new FakeProvider([
      () => [use('task_block', { kind: 'dependency', question: 'Needs the API from the other task.', waits_on: [parentRef] })],
      [use('task_complete', { summary: 'built on the API' })],
    ]);
    const e = await setup(fake);
    const parent = e.kanban.create({ title: 'API', status: 'todo' }, 'user'); // no assignee: nothing runs it
    parentRef = cardRef(parent);
    const chat = e.kanban.newChat('atlas');
    const card = e.kanban.create({ title: 'UI', status: 'ready', assignee: 'atlas' }, 'atlas', chat.id);

    await until(() => e.kanban.get(card.id).status === 'todo' && e.runner.current(card.id) === null, 'waiting in todo');
    const waiting = e.kanban.get(card.id);
    expect(waiting).toMatchObject({ status: 'todo', block: null, retry: null, parents: [parent.id] });
    expect(waiting.waiting).toBe(`waiting on ${parentRef} (todo)`);
    expect(e.notifications.inbox().needsYou).toEqual([]);
    expect(e.notifications.list().filter((n) => n.cardId === card.id)).toEqual([]);
    expect(systemTexts(e, chat.id)).toEqual([]); // nothing reported to the chat it came from

    e.kanban.update(parent.id, { status: 'done' }, 'user');
    await until(() => e.kanban.get(card.id).status === 'done', 'done after the parent');
    expect(systemTexts(e, card.id)).toEqual([WORK_KICK, `The tasks this one waited on are done (${parentRef}). Continue where you left off.`]);
    // The origin chat gets the note, no run (#143).
    expect(systemTexts(e, chat.id)).toEqual([`✓ Task “UI” (${cardRef(card)}) finished: built on the API`]);
    expect(e.runner.runs(chat.id)).toHaveLength(0);
  });

  it('keeps waiting across a restart and starts once the task is done', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const dbFile = join(dataDir, 'k.db');
    let parentRef = '';
    const first = await setup(new FakeProvider([() => [use('task_block', { kind: 'dependency', question: 'after the API', waits_on: [parentRef] })]]), { dbFile, dataDir });
    const parent = first.kanban.create({ title: 'API', status: 'todo' }, 'user');
    parentRef = cardRef(parent);
    const card = first.kanban.create({ title: 'UI', status: 'ready', assignee: 'atlas' }, 'user');
    await until(() => first.kanban.get(card.id).status === 'todo' && first.runner.current(card.id) === null, 'waiting in todo');
    await first.stop();
    engines = [];

    const second = await setup(new FakeProvider([[use('task_complete', { summary: 'ok' })]]), { dbFile, dataDir });
    expect(second.kanban.get(card.id)).toMatchObject({ status: 'todo', parents: [parent.id], waiting: `waiting on ${parentRef} (todo)` });
    second.kanban.update(parent.id, { status: 'done' }, 'user');
    await until(() => second.kanban.get(card.id).status === 'done', 'done after restart');
  });

  it('refuses a dependency without an open task to wait on: the agent has to name one, or ask the user', async () => {
    let doneRef = '';
    const fake = new FakeProvider([
      [use('task_block', { kind: 'dependency', question: 'waiting for a review' })],
      () => [use('task_block', { kind: 'dependency', question: 'after it', waits_on: [doneRef] })],
      [use('task_block', { kind: 'dependency', question: 'after it', waits_on: ['#999'] })],
      [use('task_block', { kind: 'needs_input', question: 'Who reviews it?' })],
    ]);
    const e = await setup(fake);
    const done = e.kanban.create({ title: 'Old', status: 'done' }, 'user');
    doneRef = cardRef(done);
    const card = e.kanban.create({ title: 'UI', status: 'ready', assignee: 'atlas' }, 'user');
    await until(() => e.kanban.get(card.id).status === 'blocked', 'blocked on the question');
    const results = toolResults(e, card.id);
    expect(results[0]).toMatch(/kind=dependency needs waits_on/);
    expect(results[1]).toMatch(/already done: nothing to wait for/);
    expect(results[2]).toMatch(/#999 does not exist/);
    expect(e.kanban.get(card.id)).toMatchObject({ parents: [], block: { kind: 'needs_input' } });
    expect(e.notifications.inbox().needsYou.map((n) => n.card.id)).toEqual([card.id]); // this one is for the user
  });
});

describe('retrying later (transient)', () => {
  it('an agent asking to retry later waits in todo with the time, out of the Inbox', async () => {
    const e = await setup(new FakeProvider([[use('task_block', { kind: 'transient', question: 'the exchange API is down', retry_in_minutes: 30 })]]));
    const card = e.kanban.create({ title: 'Fetch', status: 'ready', assignee: 'atlas' }, 'user');
    await until(() => e.kanban.get(card.id).status === 'todo' && e.runner.current(card.id) === null, 'retry in todo');
    const c = e.kanban.get(card.id);
    expect(c).toMatchObject({ block: null, retry: { reason: 'the exchange API is down' } });
    expect(Date.parse(c.retry!.at) - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(c.waiting).toMatch(/^retrying at \d\d?:\d\d( [AP]M)? · the exchange API is down$/);
    expect(e.notifications.inbox().needsYou).toEqual([]);
  });

  it('starts again at its time, also after a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const dbFile = join(dataDir, 'k.db');
    const first = await setup(new FakeProvider([]), { dbFile, dataDir });
    const card = first.kanban.create({ title: 'Fetch', status: 'todo', assignee: 'atlas' }, 'user');
    first.kanban.block(card.id, { kind: 'transient', reason: '429', until: new Date(Date.now() + 400).toISOString() }, 'dispatcher');
    expect(first.kanban.get(card.id)).toMatchObject({ status: 'todo', block: null, retry: { reason: '429' } });
    await first.stop();
    engines = [];

    const second = await setup(new FakeProvider([[use('task_complete', { summary: 'ok' })]]), { dbFile, dataDir });
    expect(second.kanban.get(card.id).status).toBe('todo'); // not yet
    await until(() => second.kanban.get(card.id).status === 'done', 'done after the retry time', 5000);
  });

  it('a card blocked transient before #131 still retries', async () => {
    const e = await setup(new FakeProvider([[use('task_complete', { summary: 'ok' })]]));
    const card = e.kanban.create({ title: 'Old', status: 'todo', assignee: 'atlas' }, 'user');
    e.db
      .prepare("UPDATE cards SET status = 'blocked', block_kind = 'transient', block_reason = '429', block_options = '[]', block_until = ? WHERE id = ?")
      .run(new Date(Date.now() - 1).toISOString(), card.id);
    e.dispatcher.tick();
    await until(() => e.kanban.get(card.id).status === 'done', 'done');
  });
});
