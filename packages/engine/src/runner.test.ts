import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import type { ModelRequest } from './providers/types.ts';
import { realProviders } from './models.ts';
import { estimateTokens, INTERRUPTED, SUMMARY_LEAD } from './context.ts';
import { runCardTool } from './cardTools.ts';

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

async function setup(fake: FakeProvider | null, dbFile = ':memory:', dataDir = mkdtempSync(join(tmpdir(), 'atlas-'))) {
  const engine = await startEngine({
    dbFile,
    dataDir,
    port: 0,
    dispatch: false,
    providers: fake ? () => fake : realProviders,
    env: {},
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
    const card = engine.kanban.create({ title: 'Hero', assignee: 'atlas' }, 'can');
    engine.kanban.appendMessage(card.id, 'user', 'can', text('make a hero'));
    const runId = engine.runner.wake(card.id);
    expect(runId).toBeTruthy();
    await engine.runner.settled(card.id);

    expect(readFileSync(join(dataDir, 'workspaces/atlas/hero.html'), 'utf8')).toBe('<h1>Hi</h1>');
    const msgs = engine.kanban.messages(card.id);
    expect(msgs.map((m) => m.author)).toEqual(['can', 'atlas', 'tool', 'atlas']);
    expect(msgs[2]!.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1' });
    expect(engine.runner.runs(card.id)[0]).toMatchObject({ status: 'done', error: null });
    expect(fake.calls[0]!.system).toContain(card.id);
    expect(fake.calls[0]!.tools.map((t) => t.name)).toContain('shell');
    expect(events.filter((e) => e.type === 'run.delta').map((e) => (e as { text: string }).text).join('')).toBe(
      'Writing it. Done: hero.html written.',
    );
    // Nothing owed: waking again does nothing.
    expect(engine.runner.wake(card.id)).toBeNull();
  });

  it('does nothing without an assignee', async () => {
    const { engine } = await setup(new FakeProvider([]));
    const card = engine.kanban.create({ title: 'x' }, 'can');
    engine.kanban.appendMessage(card.id, 'user', 'can', text('hi'));
    expect(engine.runner.wake(card.id)).toBeNull();
  });

  it('delivers a message posted mid-run at the next turn', async () => {
    let engineRef: Engine;
    let cardId = '';
    const fake = new FakeProvider([
      (req: ModelRequest) => {
        // Can writes while the model is answering.
        engineRef.kanban.appendMessage(cardId, 'user', 'can', text('also add a footer'));
        return text('Hero done.');
      },
      text('Footer done too.'),
    ]);
    const { engine } = await setup(fake);
    engineRef = engine;
    const card = engine.kanban.create({ title: 'Page', assignee: 'atlas' }, 'can');
    cardId = card.id;
    engine.kanban.appendMessage(card.id, 'user', 'can', text('make a hero'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);

    expect(fake.calls).toHaveLength(2);
    const second = fake.calls[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second[2]!.content).toEqual(text('also add a footer'));
  });

  it('fails loudly when the model has no credential', async () => {
    const { engine } = await setup(null);
    const card = engine.kanban.create({ title: 'x', assignee: 'atlas' }, 'can');
    engine.kanban.appendMessage(card.id, 'user', 'can', text('hi'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    const [run] = engine.runner.runs(card.id);
    expect(run!.status).toBe('failed');
    expect(run!.error).toMatch(/no Anthropic account/);
  });

  it('stops on request', async () => {
    const fake = new FakeProvider([
      [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'sleep 5' } }],
    ]);
    const { engine } = await setup(fake);
    const card = engine.kanban.create({ title: 'x', assignee: 'atlas' }, 'can');
    engine.kanban.appendMessage(card.id, 'user', 'can', text('go'));
    engine.runner.wake(card.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(engine.runner.stop(card.id)).toBe(true);
    await engine.runner.settled(card.id);
    expect(engine.runner.runs(card.id)[0]).toMatchObject({ status: 'stopped', error: 'stopped by can' });
  });

  it('resumes a run left running by a dead process, with a synthetic result for the unfinished tool', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const dbFile = join(dataDir, 'h.db');
    // First process: the model asks for a tool, then the process "dies" mid-tool (we simulate the stored state).
    const first = await setup(new FakeProvider([]), dbFile, dataDir);
    const card = first.engine.kanban.create({ title: 'x', assignee: 'atlas' }, 'can');
    first.engine.kanban.appendMessage(card.id, 'user', 'can', text('go'));
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
  /** A card whose transcript is ~40k tokens of tool work, then a message from Can; the model's window is 40k. */
  async function longCard(fake: FakeProvider) {
    const s = await setup(fake);
    const { engine } = s;
    engine.models.update(engine.agents.get('atlas').modelId, { contextWindow: 40_000 });
    const card = engine.kanban.create({ title: 'Long job', assignee: 'atlas' }, 'can');
    engine.kanban.appendMessage(card.id, 'user', 'can', text('build the importer'));
    for (let i = 0; i < 20; i++) {
      const at = engine.kanban.messages(card.id).at(-1)!.seq;
      engine.kanban.appendMessage(card.id, 'assistant', 'atlas', [{ type: 'tool_use', id: 'u' + i, name: 'shell', input: { command: 'step ' + i } }], at);
      engine.kanban.appendMessage(card.id, 'user', 'tool', [{ type: 'tool_result', tool_use_id: 'u' + i, content: `log ${i} `.padEnd(8000, '.') }]);
    }
    engine.kanban.appendMessage(card.id, 'user', 'can', text('what is left?'));
    return { ...s, card };
  }
  const sizeOf = (req: ModelRequest) => estimateTokens(req.system) + estimateTokens(req.tools) + estimateTokens(req.messages);

  it('folds old messages into a stored summary and sends summary + recent turns', async () => {
    const fake = new FakeProvider([text('Steps 0-15 ran the importer; logs were clean.'), text('Only the last steps are left.')]);
    const { engine, card } = await longCard(fake);
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);

    const [summaryCall, answerCall] = fake.calls;
    expect(summaryCall!.tools).toEqual([]);
    expect((summaryCall!.messages[0]!.content[0] as { text: string }).text).toContain('build the importer');
    const first = answerCall!.messages[0]!.content[0] as { text: string };
    expect(first.text).toBe(`${SUMMARY_LEAD}\n\nSteps 0-15 ran the importer; logs were clean.`);
    expect(sizeOf(answerCall!)).toBeLessThanOrEqual(40_000 * 0.7);
    expect(answerCall!.messages.at(-1)!.content.at(-1)).toEqual({ type: 'text', text: 'what is left?' });

    const conv = engine.db.prepare('SELECT summary, summary_upto_seq FROM conversations WHERE id = ?').get(card.conversationId) as {
      summary: string;
      summary_upto_seq: number;
    };
    expect(conv.summary).toContain('logs were clean');
    expect(engine.kanban.messages(card.id)).toHaveLength(43); // transcript untouched: 42 + the answer
    expect(engine.runner.runs(card.id)[0]!.status).toBe('done');

    // Next turn reuses the stored summary: no new summary call while the view fits.
    engine.kanban.appendMessage(card.id, 'user', 'can', text('thanks'));
    fake['script'].push(text('You are welcome.'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    expect(fake.calls).toHaveLength(3);
    expect((fake.calls[2]!.messages[0]!.content[0] as { text: string }).text).toContain(SUMMARY_LEAD);
  });

  it('when the summary fails, leaves old tool outputs out instead and still answers', async () => {
    const fake = new FakeProvider([
      () => {
        throw new Error('summary model overloaded');
      },
      text('Only the last steps are left.'),
    ]);
    const { engine, card } = await longCard(fake);
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);

    const answer = fake.calls[1]!;
    expect(sizeOf(answer)).toBeLessThanOrEqual(40_000 * 0.7);
    expect(JSON.stringify(answer.messages)).toContain('output omitted to fit the context (8000 chars)');
    expect(answer.messages[0]!.content[0]).toEqual({ type: 'text', text: 'build the importer' });
    expect(engine.runner.runs(card.id)[0]!.status).toBe('done');
    const ev = engine.db.prepare("SELECT payload FROM card_events WHERE card_id = ? AND kind = 'compaction_failed'").get(card.id) as { payload: string };
    expect(JSON.parse(ev.payload).error).toBe('summary model overloaded');
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
