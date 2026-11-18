import { cardRef } from '@atlas/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import type { ModelRequest, ModelResponse, OnDelta, Provider } from './providers/types.ts';
import { runCardTool } from './cardTools.ts';
import { until } from '../test/kit/index.ts';

/**
 * Card lifecycle from a chat (design §16): origin chat, 'closed', Stop, report back. The fake model answers by
 * conversation kind: the direct chat's script and the work card's script are separate queues.
 */
type Step = ContentBlock[] | ((req: ModelRequest) => ContentBlock[]);
class RoutedFake implements Provider {
  calls: { kind: 'chat' | 'work'; req: ModelRequest }[] = [];
  constructor(
    public chat: Step[],
    public work: Step[],
  ) {}
  async complete(req: ModelRequest, _onText: OnDelta, signal: AbortSignal): Promise<ModelResponse> {
    const kind = req.system.includes('A direct chat with') ? 'chat' : 'work';
    this.calls.push({ kind, req: structuredClone(req) });
    const step = (kind === 'chat' ? this.chat : this.work).shift();
    if (!step) throw new Error(`fake: ${kind} script exhausted`);
    const content = typeof step === 'function' ? step(req) : step;
    await new Promise((r) => setTimeout(r, 1));
    signal.throwIfAborted();
    return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input: 1, output: 1 } };
  }
}

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

async function setup(fake: Provider, o: { dbFile?: string; dataDir?: string; dispatch?: boolean } = {}) {
  const e = await startEngine({
    dbFile: o.dbFile ?? ':memory:',
    dataDir: o.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    dispatch: o.dispatch ?? true,
    providers: () => fake,
    env: {},
    memoryReview: false,
  });
  engines.push(e);
  return e;
}


const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input });
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const textOf = (m: { content: ContentBlock[] }) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
const systemTexts = (e: Engine, chatId: string) => e.kanban.messages(chatId).filter((m) => m.author === 'system').map(textOf);
const reports = (e: Engine) => e.db.prepare('SELECT chat_id, card_id, transition, delivered_at FROM card_reports ORDER BY id').all() as {
  chat_id: string;
  card_id: string;
  transition: string;
  delivered_at: string | null;
}[];
const createdCard = (e: Engine) => e.kanban.list().find((c) => c.title === 'Add web_fetch tool')!;

describe('card lifecycle from a chat', () => {
  it('records the origin chat, posts the finish there once without waking the agent, which reads it on its next turn', async () => {
    const fake = new RoutedFake(
      [
        [use('task_create', { title: 'Add web_fetch tool', body: 'Fetch a URL as markdown.', assignee: 'atlas' })],
        text('On it: I created a card and started it.'),
        (req) => {
          // The note and Master's next message reach the model as one user turn.
          const last = req.messages.at(-1)!.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
          expect(last).toContain('finished: web_fetch is in, 141 tests pass');
          expect(last).toContain('Anything else?');
          return text('Nothing else: web_fetch is in.');
        },
      ],
      // The work takes a moment, so the chat has answered « On it » before the report arrives.
      [[use('shell', { command: 'sleep 0.3' })], [use('task_complete', { summary: 'web_fetch is in, 141 tests pass' })]],
    );
    const e = await setup(fake);
    const chat = e.kanban.newChat('atlas');
    e.kanban.appendMessage(chat.id, 'user', 'user', text('Add a web_fetch tool.'));
    e.dispatcher.onUserMessage(chat.id);

    await until(() => createdCard(e)?.status === 'done', 'the task is done');
    const card = createdCard(e);
    expect(card).toMatchObject({ status: 'done', originCard: chat.id });
    expect(systemTexts(e, chat.id)).toEqual([`✓ Task “Add web_fetch tool” (${cardRef(card)}) finished: web_fetch is in, 141 tests pass`]);
    expect(reports(e)).toMatchObject([{ chat_id: chat.id, card_id: card.id, transition: 'done' }]);

    // No run for the note (#143): ticks start nothing, the agent owes nothing, nothing is posted again.
    await until(() => e.runner.current(chat.id) === null, 'the chat run ended');
    for (let i = 0; i < 5; i++) e.dispatcher.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(e.runner.runs(chat.id)).toHaveLength(1); // the user's message only
    expect(e.runner.owesReply(chat.id)).toBe(false);
    expect(fake.calls.filter((c) => c.kind === 'chat')).toHaveLength(2);
    expect(systemTexts(e, chat.id)).toHaveLength(1);

    // Master's next message: the agent sees the note with it.
    e.kanban.appendMessage(chat.id, 'user', 'user', text('Anything else?'));
    e.dispatcher.onUserMessage(chat.id);
    await until(() => e.kanban.messages(chat.id).at(-1)?.content.some((b) => b.type === 'text' && b.text.startsWith('Nothing else')) ?? false, 'the agent answers');
    expect(e.runner.runs(chat.id)).toHaveLength(2);

    // A card created on the board (not from a chat) has no origin and reports nowhere.
    const plain = e.kanban.create({ title: 'board card', status: 'todo' }, 'user');
    expect(plain.originCard).toBeNull();
  });

  it('closed: an agent closes a running card from the chat, its run stops, children wait and say why', async () => {
    let cardId = '';
    const fake = new RoutedFake(
      [
        () => [use('task_update', { id: cardId, status: 'closed' })],
        text('Closed it before any edit. “Board” stays.'),
      ],
      [[use('shell', { command: 'sleep 20' })]],
    );
    const e = await setup(fake);
    const chat = e.kanban.newChat('atlas');
    const card = e.kanban.create({ title: 'Rename Board to Tasks', status: 'ready', assignee: 'atlas' }, 'atlas', chat.id);
    cardId = card.id;
    const child = e.kanban.create({ title: 'Update docs', status: 'ready', assignee: 'atlas', parents: [card.id] }, 'user');
    await until(() => e.db.prepare("SELECT 1 FROM tool_calls WHERE name = 'shell' AND pid IS NOT NULL").get() !== undefined, 'the work is running');

    e.kanban.appendMessage(chat.id, 'user', 'user', text('Wait, I was wrong, keep “Board”.'));
    e.dispatcher.onUserMessage(chat.id);
    await until(() => e.runner.runs(card.id)[0]?.status === 'stopped', 'work run stopped by the close');
    expect(e.runner.runs(card.id)[0]!.error).toBe('task closed');
    expect(e.kanban.get(card.id).status).toBe('closed'); // not blocked: the stop of a closed card changes nothing
    expect(e.kanban.get(card.id).block).toBeNull();
    expect(systemTexts(e, chat.id)).toEqual([`Task “Rename Board to Tasks” (${cardRef(card)}) closed by @atlas. Nothing more will be done on it.`]);
    await until(() => e.runner.current(chat.id) === null, 'the chat run ended');
    expect(e.runner.runs(chat.id)).toHaveLength(1); // the close itself starts no other run

    // The child stays in todo: a closed parent is not done.
    for (let i = 0; i < 3; i++) e.dispatcher.tick();
    expect(e.kanban.get(child.id).status).toBe('todo');
    expect(e.kanban.get(child.id).waiting).toMatch(new RegExp(`parent ${cardRef(card)} was closed`));
    // Reopening it (the user) works like any status change.
    e.kanban.update(card.id, { status: 'todo' }, 'user');
    expect(e.kanban.get(card.id).status).toBe('todo');
  });

  it('closed is an editable status for agents, and a closed card never starts', async () => {
    const e = await setup(new RoutedFake([], []), { dispatch: false });
    const card = e.kanban.create({ title: 'x', status: 'todo', assignee: 'atlas' }, 'user');
    const r = runCardTool('task_update', { id: card.id, status: 'closed' }, { kanban: e.kanban, agentId: 'atlas', cardId: card.id });
    expect(r.isError).toBe(false);
    e.dispatcher.start(10);
    await new Promise((res) => setTimeout(res, 50));
    expect(e.kanban.get(card.id).status).toBe('closed');
    expect(e.runner.runs(card.id)).toHaveLength(0);
    expect(reports(e)).toHaveLength(0); // no origin chat: nothing to report
  });

  it('Stop kills a running command and its process within 1 s; the card says so and writing resumes it', async () => {
    const fake = new RoutedFake(
      [],
      [[use('shell', { command: 'sleep 30; echo never' })], [{ type: 'text', text: 'Resumed: not running it again.' }, use('task_complete', { summary: 'skipped' })]],
    );
    const e = await setup(fake);
    const chat = e.kanban.newChat('atlas');
    const card = e.kanban.create({ title: 'Clean up old data folders', status: 'ready', assignee: 'atlas' }, 'atlas', chat.id);
    let pid = 0;
    await until(() => {
      pid = (e.db.prepare("SELECT pid FROM tool_calls WHERE name = 'shell'").get() as { pid: number | null } | undefined)?.pid ?? 0;
      return pid > 0;
    }, 'the command is running');
    const alive = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);

    const t0 = Date.now();
    const res = await fetch(e.url + `/api/cards/${card.id}/stop`, { method: 'POST' });
    expect(await res.json()).toEqual({ stopped: true });
    await until(() => e.runner.runs(card.id)[0]?.status === 'stopped' && !alive(), 'run stopped and process killed', 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(e.runner.runs(card.id)[0]!.error).toBe('stopped by you');
    expect(e.db.prepare("SELECT status FROM tool_calls WHERE name = 'shell'").get()).toEqual({ status: 'error' });

    await until(() => e.kanban.get(card.id).status === 'blocked', 'card blocked');
    expect(e.kanban.get(card.id).block).toMatchObject({ kind: 'needs_input', reason: 'Stopped by you. Write what to do next.' });
    expect(systemTexts(e, chat.id)).toEqual([`You stopped “Clean up old data folders” (${cardRef(card)}). Its run and commands were killed; writing in the task resumes it.`]);
    expect(reports(e).map((r) => r.transition)).toEqual(['stopped']);

    // Writing on the card resumes it like a block answer; the interrupted call got the usual synthetic result.
    e.kanban.appendMessage(card.id, 'user', 'user', text("Don't run it again."));
    e.dispatcher.onUserMessage(card.id);
    await until(() => e.kanban.get(card.id).status === 'done', 'card done after resume');
    const resumed = fake.calls.filter((c) => c.kind === 'work')[1]!.req;
    expect(JSON.stringify(resumed.messages)).toContain('interrupted by a restart or a stop');
    expect(reports(e).map((r) => r.transition)).toEqual(['stopped', 'done']);
    expect(e.runner.runs(chat.id)).toHaveLength(0); // neither note woke the chat
  });

  it('reports a needs_input block once, as a note in the chat and a question in the Inbox, with no agent message', async () => {
    const fake = new RoutedFake([], [[use('task_block', { kind: 'needs_input', question: 'Blue or green?' })]]);
    const e = await setup(fake);
    const chat = e.kanban.newChat('atlas');
    const card = e.kanban.create({ title: 'Theme', status: 'ready', assignee: 'atlas' }, 'atlas', chat.id);
    await until(() => reports(e).length === 1, 'note posted');
    expect(systemTexts(e, chat.id)).toEqual([`Task “Theme” (${cardRef(card)}) needs your OK: Blue or green?`]);
    for (let i = 0; i < 5; i++) e.dispatcher.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(e.runner.runs(chat.id)).toHaveLength(0);
    expect(e.kanban.messages(chat.id).filter((m) => m.role === 'assistant')).toHaveLength(0);
    expect(fake.calls.filter((c) => c.kind === 'chat')).toHaveLength(0);
    const inbox = (await (await fetch(e.url + '/api/inbox')).json()) as { needsYou: { card: { id: string } }[] };
    expect(inbox.needsYou.map((n) => n.card.id)).toEqual([card.id]);
    // A transient block or a dependency is not reported.
    e.kanban.update(card.id, { status: 'todo' }, 'user');
    e.kanban.block(card.id, { kind: 'transient', reason: '429', until: new Date(Date.now() + 60_000).toISOString() }, 'dispatcher');
    expect(reports(e)).toHaveLength(1);
  });

  it('survives a kill: the note written with the status change is there after restart, read on the next turn, never a run of its own', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const dbFile = join(dataDir, 'k.db');
    const first = await setup(new RoutedFake([], []), { dbFile, dataDir, dispatch: false });
    const chat = first.kanban.newChat('atlas');
    const card = first.kanban.create({ title: 'Job', status: 'running', assignee: 'atlas' }, 'atlas', chat.id);
    first.kanban.update(card.id, { status: 'done' }, 'atlas', 'all good');
    expect(reports(first)).toHaveLength(1);
    // Killed with a chat run left 'running' (expired lease): it was mid-answer when the note came.
    first.db
      .prepare("INSERT INTO runs (id, card_id, agent_id, kind, status, started_at) VALUES ('r_dead', ?, 'atlas', 'chat', 'running', ?)")
      .run(chat.id, new Date().toISOString());
    first.db.close();
    engines = [];

    // Second process: the note is there; the interrupted chat run does not resume for it, the dispatcher starts nothing.
    const fake = new RoutedFake(
      [
        (req) => {
          const all = JSON.stringify(req.messages);
          expect(all).toContain(`✓ Task “Job” (${cardRef(card)}) finished: all good`);
          expect(all).toContain('status?');
          return text('Job is done: all good.');
        },
      ],
      [],
    );
    const second = await setup(fake, { dbFile, dataDir });
    expect(systemTexts(second, chat.id)).toEqual([`✓ Task “Job” (${cardRef(card)}) finished: all good`]);
    for (let i = 0; i < 5; i++) second.dispatcher.tick();
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls).toHaveLength(0);
    expect(second.runner.runs(chat.id).map((r) => r.status)).toEqual(['interrupted']);

    // Master writes: one run, which reads the note.
    second.kanban.appendMessage(chat.id, 'user', 'user', text('status?'));
    second.dispatcher.onUserMessage(chat.id);
    await until(() => second.runner.runs(chat.id)[0]?.status === 'done', 'the chat answered');
    expect(fake.calls).toHaveLength(1);
    expect(systemTexts(second, chat.id)).toHaveLength(1);
  });

  it('a long summary is shortened on a sentence, never mid-word, and says where the rest is', async () => {
    const e = await setup(new RoutedFake([], []), { dispatch: false });
    const chat = e.kanban.newChat('atlas');
    const card = e.kanban.create({ title: 'Long', status: 'running', assignee: 'atlas' }, 'atlas', chat.id);
    const summary = Array.from({ length: 60 }, (_, i) => `Sentence ${i} checks the behaviour of part ${i}.`).join(' ');
    expect(summary.length).toBeGreaterThan(2000);
    e.kanban.update(card.id, { status: 'done' }, 'atlas', summary);
    const [note] = systemTexts(e, chat.id);
    expect(note!.length).toBeLessThan(1700);
    expect(note).toMatch(new RegExp(`part \\d+\\.\\n\\n\\(shortened; full summary: task_show ${cardRef(card)}\\)$`));
    // A short one stays whole.
    const other = e.kanban.create({ title: 'Short', status: 'running', assignee: 'atlas' }, 'atlas', chat.id);
    e.kanban.update(other.id, { status: 'done' }, 'atlas', 'All good.');
    expect(systemTexts(e, chat.id)[1]).toBe(`✓ Task “Short” (${cardRef(other)}) finished: All good.`);
  });

  it('the rebuilt cards table takes the closed status and keeps every reference valid', async () => {
    const e = await setup(new RoutedFake([], []), { dispatch: false });
    const card = e.kanban.create({ title: 'x', status: 'todo' }, 'user');
    e.kanban.update(card.id, { status: 'closed' }, 'user');
    expect(e.kanban.get(card.id).status).toBe('closed');
    expect(e.db.pragma('foreign_key_check')).toEqual([]);
  });
});
