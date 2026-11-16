import { cardRef } from '@atlas/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { toolInput, type ModelRequest } from './providers/types.ts';
import { realProviders } from './models.ts';
import { estimateTokens, INTERRUPTED, SUMMARY_LEAD, TODO_LEAD } from './context.ts';
import { runCardTool } from './cardTools.ts';
import { pausedNote } from './runner.ts';

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

async function setup(fake: FakeProvider | null, dbFile = ':memory:', dataDir = mkdtempSync(join(tmpdir(), 'atlas-')), extra: { maxTurns?: number } = {}) {
  const engine = await startEngine({
    dbFile,
    dataDir,
    port: 0,
    dispatch: false,
    providers: fake ? () => fake : realProviders,
    env: {},
    ...extra,
  });
  engines.push(engine);
  const events: ServerEvent[] = [];
  engine.bus.on((e) => events.push(e));
  return { engine, events, dataDir };
}

const text = (t: string) => [{ type: 'text' as const, text: t }];

describe('runner', () => {
  it('answers a message on an assigned card, using tools, and streams text', async () => {
    const fake = new FakeProvider([
      [
        { type: 'text', text: 'Writing it. ' },
        { type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'hero.html', content: '<h1>Hi</h1>' } },
      ],
      text('Done: hero.html written.'),
    ]);
    const { engine, events, dataDir } = await setup(fake);
    const card = engine.kanban.create({ title: 'Hero', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('make a hero'));
    const runId = engine.runner.wake(card.id);
    expect(runId).toBeTruthy();
    await engine.runner.settled(card.id);

    expect(readFileSync(join(dataDir, 'workspaces/atlas/hero.html'), 'utf8')).toBe('<h1>Hi</h1>');
    const msgs = engine.kanban.messages(card.id);
    expect(msgs.map((m) => m.author)).toEqual(['user', 'atlas', 'tool', 'atlas']);
    expect(msgs[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(engine.runner.runs(card.id)[0]).toMatchObject({ status: 'done', error: null });
    expect(fake.calls[0]!.system).toContain(cardRef(card));
    expect(fake.calls[0]!.tools.map((t) => t.name)).toContain('shell');
    expect(events.filter((e) => e.type === 'run.delta').map((e) => (e as { text: string }).text).join('')).toBe(
      'Writing it. Done: hero.html written.',
    );
    // Nothing owed: waking again does nothing.
    expect(engine.runner.wake(card.id)).toBeNull();
    // When the tool call ran: stored, served by the API, and announced as it started and ended.
    const [call] = engine.runner.toolCalls(card.id);
    expect(call).toMatchObject({ toolUseId: 't1', name: 'write_file', status: 'done' });
    expect(Date.parse(call!.endedAt!)).toBeGreaterThanOrEqual(Date.parse(call!.startedAt));
    const live = events.flatMap((e) => (e.type === 'toolcall.updated' ? [e] : []));
    expect(live.map((e) => [e.cardId, e.call.status])).toEqual([
      [card.id, 'running'],
      [card.id, 'done'],
    ]);
    expect(live[0]!.call.endedAt).toBeNull();
    const served = await fetch(engine.url + `/api/cards/${card.id}/tool-calls`);
    expect(await served.json()).toEqual([call]);
  });

  it('stores what file tools did (detail) and streams a running shell command’s tail (#63)', async () => {
    const fake = new FakeProvider([
      [{ type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'a.txt', content: 'one\ntwo\nthree\n' } }],
      [{ type: 'tool_use', id: 'w2', name: 'write_file', input: { path: 'a.txt', content: 'one\n2\nthree\n' } }],
      [{ type: 'tool_use', id: 'e1', name: 'edit_file', input: { path: 'a.txt', old_text: 'three', new_text: 'three\nfour' } }],
      [{ type: 'tool_use', id: 's1', name: 'shell', input: { command: 'echo first; sleep 0.8; echo second' } }],
      text('Done.'),
    ]);
    const { engine, events } = await setup(fake);
    const card = engine.kanban.create({ title: 'Files', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    const calls = new Map(engine.runner.toolCalls(card.id).map((c) => [c.toolUseId, c]));
    expect(calls.get('w1')!.detail).toEqual({ kind: 'write', created: true, before: null });
    expect(calls.get('w2')!.detail).toEqual({ kind: 'write', created: false, before: 'one\ntwo\nthree\n' });
    expect(calls.get('e1')!.detail).toEqual({ kind: 'edit', lines: [3] });
    expect(calls.get('s1')!.detail).toBeUndefined();
    // The detail never reaches the model.
    expect(JSON.stringify(fake.calls.at(-1)!.messages)).not.toContain('"created"');
    const tails = events.flatMap((e) => (e.type === 'toolcall.updated' && e.call.tail !== undefined ? [e.call] : []));
    expect(tails.length).toBeGreaterThan(0);
    expect(tails.every((c) => c.toolUseId === 's1' && c.status === 'running')).toBe(true);
    expect(tails[0]!.tail).toBe('first');
    expect(calls.get('s1')!.tail).toBeUndefined();
  });

  it('does nothing without an assignee', async () => {
    const { engine } = await setup(new FakeProvider([]));
    const card = engine.kanban.create({ title: 'x' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('hi'));
    expect(engine.runner.wake(card.id)).toBeNull();
  });

  it('delivers a message posted mid-run at the next turn', async () => {
    let engineRef: Engine;
    let cardId = '';
    const fake = new FakeProvider([
      (req: ModelRequest) => {
        // The user writes while the model is answering.
        engineRef.kanban.appendMessage(cardId, 'user', 'user', text('also add a footer'));
        return text('Hero done.');
      },
      text('Footer done too.'),
    ]);
    const { engine } = await setup(fake);
    engineRef = engine;
    const card = engine.kanban.create({ title: 'Page', assignee: 'atlas' }, 'user');
    cardId = card.id;
    engine.kanban.appendMessage(card.id, 'user', 'user', text('make a hero'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);

    expect(fake.calls).toHaveLength(2);
    const second = fake.calls[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[2]!.content).toEqual(text('also add a footer'));
  });

  it('fails loudly when the model has no credential', async () => {
    const { engine } = await setup(null);
    const card = engine.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('hi'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    const [run] = engine.runner.runs(card.id);
    expect(run!.status).toBe('failed');
    expect(run!.error).toMatch(/no Anthropic account/);
  });

  it('answers a tool call with invalid JSON arguments with an error; the model resends it and the run completes', async () => {
    const bad = '{"path": "a.html", "content": "<p class="x">hi</p>"}';
    const fake = new FakeProvider([
      [{ type: 'tool_use', id: 't1', name: 'write_file', input: toolInput(bad) }],
      [{ type: 'tool_use', id: 't2', name: 'write_file', input: { path: 'a.html', content: '<p class="x">hi</p>' } }],
      text('Written.'),
    ]);
    const { engine, dataDir } = await setup(fake);
    const card = engine.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);

    expect(engine.runner.runs(card.id)[0]).toMatchObject({ status: 'done', error: null });
    const msgs = engine.kanban.messages(card.id);
    expect(msgs.map((m) => m.author)).toEqual(['user', 'atlas', 'tool', 'atlas', 'tool', 'atlas']);
    // The raw text stays in the transcript; the error says why and where.
    expect(msgs[1]!.content[0]).toMatchObject({ type: 'tool_use', input: { _invalid_json: bad } });
    const err = msgs[2]!.content[0] as { content: string; is_error?: boolean };
    expect(err.is_error).toBe(true);
    expect(err.content).toMatch(/not valid JSON .*position 41/);
    expect(err.content).toContain('⟨HERE⟩x">hi');
    expect(err.content).toMatch(/Resend the call/);
    expect(readFileSync(join(dataDir, 'workspaces/atlas/a.html'), 'utf8')).toBe('<p class="x">hi</p>');
  });

  it('fails loudly after 3 turns in a row of invalid JSON arguments', async () => {
    const badCall = (id: string) => [{ type: 'tool_use' as const, id, name: 'shell', input: toolInput('{"command": "ls') }];
    const fake = new FakeProvider([badCall('t1'), badCall('t2'), badCall('t3'), text('never')]);
    const { engine } = await setup(fake);
    const card = engine.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    const [run] = engine.runner.runs(card.id);
    expect(run!.status).toBe('failed');
    expect(run!.error).toMatch(/invalid JSON arguments 3 turns in a row: .*Unterminated string/);
    expect(fake.calls).toHaveLength(3);
    // Every bad call got its error result: the transcript stays well-formed for a resume.
    expect(engine.kanban.messages(card.id).filter((m) => m.author === 'tool')).toHaveLength(3);
  });

  it('stops on request', async () => {
    const fake = new FakeProvider([
      [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'sleep 5' } }],
    ]);
    const { engine } = await setup(fake);
    const card = engine.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    engine.runner.wake(card.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.runner.stop(card.id)).toBe(true);
    await engine.runner.settled(card.id);
    expect(engine.runner.runs(card.id)[0]).toMatchObject({ status: 'stopped', error: 'stopped by you' });
  });

  it('resumes a run left running by a dead process, with a synthetic result for the unfinished tool', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const dbFile = join(dataDir, 'h.db');
    // First process: the model asks for a tool, then the process "dies" mid-tool (we simulate the stored state).
    const first = await setup(new FakeProvider([]), dbFile, dataDir);
    const card = first.engine.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    first.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    first.engine.kanban.appendMessage(card.id, 'assistant', 'atlas', [
      { type: 'tool_use', id: 't9', name: 'shell', input: { command: 'make' } },
    ]);
    first.engine.db
      .prepare("INSERT INTO runs (id, card_id, agent_id, status, started_at) VALUES ('r_dead', ?, 'atlas', 'running', ?)")
      .run(card.id, new Date().toISOString());
    first.engine.db.close();
    engines = [];

    const fake = new FakeProvider([text('Resumed; re-running make was not needed.')]);
    const second = await setup(fake, dbFile, dataDir);
    await second.engine.runner.settled(card.id);
    const runs = second.engine.runner.runs(card.id);
    expect(runs.map((r) => r.status).sort()).toEqual(['done', 'interrupted']);
    expect(fake.calls[0]!.messages.at(-1)!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't9', content: INTERRUPTED });
  });
});

describe('context management (design §8)', () => {
  /** A card whose transcript is ~40k tokens of tool work, then a message from the user; the model's window is 40k. */
  async function longCard(fake: FakeProvider, kind: 'tools' | 'text' = 'tools') {
    const s = await setup(fake);
    const { engine } = s;
    engine.models.update(engine.agents.get('atlas').modelId, { contextWindow: 40_000 });
    const card = engine.kanban.create({ title: 'Long job', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('build the importer'));
    if (kind === 'text') {
      // Prose can't be pruned: only a summary helps. An early todo list gets folded into it.
      engine.kanban.appendMessage(card.id, 'assistant', 'atlas', [{ type: 'tool_use', id: 'td', name: 'todo_write', input: { todos: [{ content: 'parse the CSV', status: 'in_progress' }] } }], 1);
      engine.kanban.appendMessage(card.id, 'user', 'tool', [{ type: 'tool_result', tool_use_id: 'td', content: 'todo list saved' }]);
      engine.kanban.setTodos(card.id, [{ content: 'parse the CSV', status: 'in_progress' }]);
    }
    for (let i = 0; i < 20; i++) {
      const at = engine.kanban.messages(card.id).at(-1)!.seq;
      if (kind === 'text') {
        engine.kanban.appendMessage(card.id, 'assistant', 'atlas', text(`thoughts ${i} `.padEnd(8000, '.')), at);
        engine.kanban.appendMessage(card.id, 'user', 'user', text('go on'));
        continue;
      }
      engine.kanban.appendMessage(card.id, 'assistant', 'atlas', [{ type: 'tool_use', id: 'u' + i, name: 'shell', input: { command: 'step ' + i } }], at);
      engine.kanban.appendMessage(card.id, 'user', 'tool', [{ type: 'tool_result', tool_use_id: 'u' + i, content: `log ${i} `.padEnd(8000, '.') }]);
    }
    engine.kanban.appendMessage(card.id, 'user', 'user', text('what is left?'));
    return { ...s, card };
  }
  const sizeOf = (req: ModelRequest) => estimateTokens(req.system) + estimateTokens(req.tools) + estimateTokens(req.messages);
  /** Summary calls (no tools) get `summary`, agent turns get `answer`. */
  const responder = (n: number, summary: string, answer: string) =>
    Array.from({ length: n }, () => (req: ModelRequest) => text(req.tools.length ? answer : summary));
  const conv = (engine: Engine, id: string) =>
    engine.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as {
      summary: string | null;
      summary_upto_seq: number | null;
      prune_upto_seq: number | null;
      last_input_tokens: number | null;
      last_input_upto: number | null;
    };
  const events = (engine: Engine, cardId: string, kind: string) =>
    engine.db.prepare('SELECT payload FROM card_events WHERE card_id = ? AND kind = ?').all(cardId, kind) as { payload: string }[];

  it('prunes old tool outputs first, without a model call, well under the threshold, and not again next turn', async () => {
    const fake = new FakeProvider([text('Only the last steps are left.'), text('You are welcome.')]);
    const { engine, card } = await longCard(fake);
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);

    expect(fake.calls).toHaveLength(1); // no summary call
    const answer = fake.calls[0]!;
    expect(sizeOf(answer)).toBeLessThanOrEqual(40_000 * 0.5);
    const json = JSON.stringify(answer.messages);
    expect(json).toContain('output omitted to fit the context (8000 chars); history_search can read it (seq 3)');
    expect(json).toContain('log 19 '.padEnd(8000, '.')); // the recent tail stays whole
    expect(answer.messages[0]!.content[0]).toEqual({ type: 'text', text: 'build the importer' });
    const c = conv(engine, card.conversationId);
    expect(c.summary).toBeNull();
    expect(c.prune_upto_seq).toBeGreaterThan(0);
    expect(events(engine, card.id, 'pruned')).toHaveLength(1);
    expect(engine.kanban.messages(card.id)).toHaveLength(43); // transcript untouched
    // The real count of that turn is stored for the next decision.
    expect(c.last_input_tokens).toBe(fake.usages[0]!.input);
    expect(c.last_input_upto).toBe(42);

    // Next turn: same pruned view (hysteresis: no new prune), so the prompt cache holds.
    engine.kanban.appendMessage(card.id, 'user', 'user', text('thanks'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    expect(events(engine, card.id, 'pruned')).toHaveLength(1);
    expect(JSON.stringify(fake.calls[1]!.messages)).toContain(JSON.stringify(answer.messages).slice(1, -1));
    expect(fake.usages[1]!.cached).toBeGreaterThan(fake.usages[0]!.input * 0.9);
  });

  it('folds old messages into a stored summary when pruning is not enough, re-injecting the todo list', async () => {
    const fake = new FakeProvider(responder(8, 'Thoughts 0-15 planned the importer.', 'Only the last steps are left.'));
    const { engine, card } = await longCard(fake, 'text');
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);

    const answers = fake.calls.filter((c) => c.tools.length);
    const summaries = fake.calls.filter((c) => !c.tools.length);
    expect(answers).toHaveLength(1);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    expect(summaries[0]!.cache).toBeUndefined(); // one-shot: no cache breakpoints
    expect((summaries[0]!.messages[0]!.content[0] as { text: string }).text).toContain('build the importer');
    const answer = answers[0]!;
    expect(answer.messages[0]!.content[0]).toEqual({ type: 'text', text: `${SUMMARY_LEAD}\n\nThoughts 0-15 planned the importer.` });
    expect(answer.messages[0]!.content[1]).toEqual({ type: 'text', text: `${TODO_LEAD}\n- [>] parse the CSV` });
    expect(sizeOf(answer)).toBeLessThanOrEqual(40_000 * 0.7);
    expect(answer.messages.at(-1)!.content.at(-1)).toEqual({ type: 'text', text: 'what is left?' });
    expect(conv(engine, card.conversationId).summary).toContain('planned the importer');
    expect(engine.runner.runs(card.id)[0]!.status).toBe('done');

    // Next turn reuses the stored summary: no new summary call while the view fits.
    const n = fake.calls.length;
    engine.kanban.appendMessage(card.id, 'user', 'user', text('thanks'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    expect(fake.calls).toHaveLength(n + 1);
    expect((fake.calls[n]!.messages[0]!.content[0] as { text: string }).text).toContain(SUMMARY_LEAD);
  });

  it('when the summary fails, degrades the view instead and still answers', async () => {
    const fake = new FakeProvider([
      () => {
        throw new Error('summary model overloaded');
      },
      text('Only the last steps are left.'),
    ]);
    const { engine, card } = await longCard(fake, 'text');
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);

    const answer = fake.calls[1]!;
    expect(sizeOf(answer)).toBeLessThanOrEqual(40_000 * 0.7);
    expect(JSON.stringify(answer.messages)).toContain('chars omitted to fit the context');
    expect(answer.messages[0]!.content[0]).toEqual({ type: 'text', text: 'build the importer' });
    expect(engine.runner.runs(card.id)[0]!.status).toBe('done');
    expect(JSON.parse(events(engine, card.id, 'compaction_failed')[0]!.payload).error).toBe('summary model overloaded');
    expect(conv(engine, card.conversationId).last_input_tokens).toBeNull(); // a degraded view's size is not the conversation's
  });

  it('decides with the provider’s real token count, chars/4 only without one', async () => {
    const fake = new FakeProvider(responder(4, 'They said hello.', 'Hi again.'));
    const { engine } = await setup(fake);
    engine.models.update(engine.agents.get('atlas').modelId, { contextWindow: 40_000 });
    const card = engine.kanban.create({ title: 'Small', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('hello'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    expect(fake.calls).toHaveLength(1); // small by estimate: no compaction

    // The provider said the last prompt was 30k tokens (an estimate would say a few thousand): over 70% → compaction.
    engine.db.prepare('UPDATE conversations SET last_input_tokens = 30000, last_input_upto = 2 WHERE id = ?').run(card.conversationId);
    engine.kanban.appendMessage(card.id, 'user', 'user', text('again'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    expect(fake.calls.map((c) => (c.tools.length ? 'turn' : 'summary'))).toEqual(['turn', 'summary', 'turn']);
    const c = conv(engine, card.conversationId);
    expect(c.summary).toBe('They said hello.');
    expect(c.last_input_tokens).toBe(fake.usages[2]!.input); // a fresh reading of the new view
    expect(c.last_input_upto).toBe(3);
  });

  it('splits the system prompt into a cached stable prefix and a volatile tail', async () => {
    const fake = new FakeProvider([text('a'), text('b')]);
    const { engine } = await setup(fake);
    const card = engine.kanban.create({ title: 'Cache', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('one'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    const req = fake.calls[0]!;
    const stable = req.system.slice(0, req.cache!.systemStable);
    expect(stable).toContain('# Team');
    expect(stable).not.toContain('# Memory');
    expect(req.system.slice(req.cache!.systemStable)).toMatch(/^# Memory[\s\S]*# Current card[\s\S]*Today is /);

    // A memory edit changes only the tail: the prefix is still read from the cache.
    engine.memories.set('atlas', 'likes tea', 'atlas');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('two'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    expect(fake.calls[1]!.system.slice(0, fake.calls[1]!.cache!.systemStable)).toBe(stable);
    expect(fake.usages[1]!.cached).toBeGreaterThanOrEqual(estimateTokens(JSON.stringify(req.tools) + stable));
  });

  it('pauses at the turn limit with a note instead of failing, and a reply resumes', async () => {
    const shell = (i: number) => [{ type: 'tool_use' as const, id: 's' + i, name: 'shell', input: { command: 'echo ' + i } }];
    const fake = new FakeProvider([shell(1), shell(2), text('All three steps done.')]);
    const { engine } = await setup(fake, ':memory:', undefined, { maxTurns: 2 });
    const card = engine.kanban.create({ title: 'Steps', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('run the steps'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);

    expect(engine.runner.runs(card.id)[0]).toMatchObject({ status: 'done', error: null });
    const last = engine.kanban.messages(card.id).at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', author: 'system', content: text(pausedNote(2)) });
    expect(engine.runner.owesReply(card.id)).toBe(false);

    engine.kanban.appendMessage(card.id, 'user', 'user', text('continue'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    expect(engine.kanban.messages(card.id).at(-1)).toMatchObject({ author: 'atlas', content: text('All three steps done.') });
    expect(fake.calls[2]!.messages.at(-1)!.content.at(-1)).toEqual({ type: 'text', text: 'continue' });
  });

  it('todo_write stores the full list per conversation and returns it', async () => {
    const fake = new FakeProvider([
      [{ type: 'tool_use', id: 'w1', name: 'todo_write', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } }],
      text('Working on b.'),
    ]);
    const { engine } = await setup(fake);
    const card = engine.kanban.create({ title: 'Todos', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('plan it'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    expect(engine.kanban.todos(card.id)).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ]);
    const result = engine.kanban.messages(card.id)[2]!.content[0] as { content: string };
    expect(result.content).toBe('todo list saved (1/2 done):\n- [x] a\n- [>] b');
    expect(fake.calls[0]!.tools.map((t) => t.name)).toContain('todo_write');
  });

  it('history_search finds and reads omitted parts of the transcript', async () => {
    const { engine, card } = await longCard(new FakeProvider([]));
    const ctx = { kanban: engine.kanban, agentId: 'atlas', cardId: card.id };
    const found = runCardTool('history_search', { query: 'log 7 ' }, ctx);
    expect(found.isError).toBe(false);
    expect(found.output).toMatch(/^#17 tool: …← log 7 /);
    const full = runCardTool('history_search', { seq: 17 }, ctx);
    expect(full.output).toContain('log 7 '.padEnd(8000, '.'));
    expect(runCardTool('history_search', {}, ctx).isError).toBe(true);
    expect(runCardTool('history_search', { query: 'nowhere-to-be-found' }, ctx).output).toBe('no message contains "nowhere-to-be-found"');
  });
});
