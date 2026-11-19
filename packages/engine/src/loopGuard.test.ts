import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { launch, eventually } from '../test/kit/index.ts';
import { FakeProvider } from './providers/fake.ts';
import type { ModelRequest, ModelResponse, Provider } from './providers/types.ts';
import { afterTools, FAIL_TURNS_LIMIT, freshGuard, REPEAT_LIMIT, stopNote, type GuardCall } from './loopGuard.ts';

const call = (name: string, input: unknown, output: string, isError = false): GuardCall => ({ name, input, output, isError });
let n = 0;
const use = (name: string, input: unknown): ContentBlock[] => [{ type: 'tool_use', id: 'u' + ++n, name, input }];
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
/** The same call that fails the same way every time. */
const missing = () => use('read_file', { path: 'nowhere/missing.txt' });

describe('loop guard rules (#239)', () => {
  it('stops on the same call with the same result REPEAT_LIMIT times in a row, saying what repeated', () => {
    let s = freshGuard();
    const npm = call('shell', { command: 'npm test' }, 'exit 1\nFAIL src/a.test.ts', true);
    for (let i = 1; i < REPEAT_LIMIT; i++) {
      const r = afterTools(s, [npm]);
      expect(r.stop).toBeNull();
      s = r.state;
    }
    const r = afterTools(s, [npm]);
    expect(r.stop).toBe('`npm test` failed the same way 5 times in a row (exit 1)');
  });

  it('does not stop on the same call with a different result, nor on distinct calls', () => {
    let s = freshGuard();
    for (let i = 0; i < 50; i++) {
      const r = afterTools(s, [call('shell', { command: 'npm test' }, `exit 1\nrun ${i}`, true), call('read_file', { path: `f${i}` }, 'x')]);
      expect(r.stop).toBeNull();
      s = r.state;
    }
    expect(s.failStreak).toBe(0); // one call of each turn succeeded
  });

  it('stops after FAIL_TURNS_LIMIT turns in a row where every call failed, and a success resets the count', () => {
    let s = freshGuard();
    for (let i = 0; i < FAIL_TURNS_LIMIT - 1; i++) s = afterTools(s, [call('shell', { command: `try ${i}` }, `error ${i}`, true)]).state;
    s = afterTools(s, [call('shell', { command: 'ok' }, 'fine')]).state;
    expect(s.failStreak).toBe(0);
    let stop: string | null = null;
    for (let i = 0; i < FAIL_TURNS_LIMIT; i++) ({ state: s, stop } = afterTools(s, [call('shell', { command: `try ${i}` }, `error ${i}`, true)]));
    expect(stop).toBe('every tool call failed for 30 turns in a row (last: `try 29`: error 29)');
  });

  it('a turn without tool calls changes nothing', () => {
    const s = { turns: 3, failStreak: 2, repeatStreak: 4, repeatKey: 'k' };
    expect(afterTools(s, [])).toEqual({ state: s, stop: null });
  });
});

describe('loop guard in runs (#239)', () => {
  it('300 distinct progressing turns are not paused', async () => {
    const script = Array.from({ length: 300 }, (_, i) => use('todo_write', { todos: [{ content: `step ${i}`, status: 'in_progress' }] }));
    const t = await launch({ script: [...script, use('task_complete', { summary: 'all 300 steps' })] });
    const card = t.engine.kanban.create({ title: 'Big build', status: 'ready', assignee: 'atlas' }, 'user');
    await eventually(() => expect(t.engine.kanban.get(card.id).status).toBe('done'), { timeout: 60_000, what: 'the task done' });
    expect(t.fake.calls).toHaveLength(301);
    expect(t.engine.kanban.messages(card.id).some((m) => m.author === 'system' && m.role === 'assistant')).toBe(false);
  }, 90_000);

  it("a repeated failing call stops the lead's own task at the limit and the block reaches Master with the reason", async () => {
    const t = await launch({ script: Array.from({ length: REPEAT_LIMIT }, missing) });
    const card = t.engine.kanban.create({ title: 'Loop', status: 'ready', assignee: 'atlas' }, 'user');
    expect(t.engine.kanban.leadOf(card.projectId)).toBe('atlas');
    await eventually(() => expect(t.engine.kanban.get(card.id).status).toBe('blocked'), { what: 'blocked for Master' });
    const reason = '`read_file {"path":"nowhere/missing.txt"}` failed the same way 5 times in a row';
    expect(t.engine.kanban.get(card.id).block).toMatchObject({ kind: 'needs_input' });
    expect(t.engine.kanban.get(card.id).block!.reason).toContain(reason);
    expect(t.engine.runner.runs(card.id)[0]).toMatchObject({ status: 'done', error: null });
    expect(t.engine.runner.runs(card.id)[0]!.limit).toContain(reason);
    expect(t.engine.kanban.messages(card.id).at(-1)).toMatchObject({ role: 'assistant', author: 'system' });
    expect(t.fake.calls).toHaveLength(REPEAT_LIMIT);
  });

  it("another agent's stop wakes the lead in the thread; the lead continues and the assignee goes on", async () => {
    const t = await launch({
      script: [
        ...Array.from({ length: REPEAT_LIMIT }, missing), // munih loops
        text('@munih: the file is not there, create it first.'), // atlas, the lead
        use('task_complete', { summary: 'created it' }), // munih again
      ],
    });
    t.engine.agents.create({ id: 'munih', modelId: t.engine.agents.get('atlas').modelId });
    const card = t.engine.kanban.create({ title: 'Loop', status: 'ready', assignee: 'munih' }, 'user');
    await eventually(() => expect(t.engine.kanban.get(card.id).status).toBe('done'), { what: 'the task done after the lead answered' });
    const runs = t.engine.runner.runs(card.id).reverse();
    expect(runs.map((r) => r.agentId)).toEqual(['munih', 'atlas', 'munih']);
    expect(runs[0]!.limit).toMatch(/failed the same way 5 times/);
    // The lead got the stop with its own job; the assignee got the lead's answer.
    const leadCall = t.fake.calls[REPEAT_LIMIT]!;
    expect(leadCall.system).toContain("@munih's run on the task below was stopped by the loop guard");
    expect(JSON.stringify(leadCall.messages.at(-1))).toContain('You are the project lead');
    expect(JSON.stringify(t.fake.calls[REPEAT_LIMIT + 1]!.messages.at(-1))).toContain('@atlas (project lead) answered above');
    expect(t.engine.kanban.eventCount(card.id, 'run_limited')).toBe(1);
  });

  it('the lead can block it for Master', async () => {
    const t = await launch({
      script: [...Array.from({ length: REPEAT_LIMIT }, missing), use('task_block', { kind: 'needs_input', question: 'Is this file supposed to exist?' })],
    });
    t.engine.agents.create({ id: 'munih', modelId: t.engine.agents.get('atlas').modelId });
    const card = t.engine.kanban.create({ title: 'Loop', status: 'ready', assignee: 'munih' }, 'user');
    await eventually(() => expect(t.engine.kanban.get(card.id).status).toBe('blocked'), { what: 'blocked by the lead' });
    expect(t.engine.kanban.get(card.id).block).toMatchObject({ kind: 'needs_input', reason: 'Is this file supposed to exist?' });
  });

  it('the safety ceiling stops a direct chat with a message in the chat', async () => {
    const t = await launch({ script: [use('todo_write', { todos: [{ content: 'a', status: 'in_progress' }] }), use('todo_write', { todos: [{ content: 'b', status: 'in_progress' }] })], maxTurns: 2 });
    const chat = await t.chat();
    await t.say(chat.id, 'go');
    await t.idle(chat.id);
    expect(t.engine.kanban.messages(chat.id).at(-1)).toMatchObject({ role: 'assistant', author: 'system', content: text(stopNote('reached the safety ceiling of 2 turns in one run')) });
    expect(t.engine.runner.owesReply(chat.id)).toBe(false);
  });

  it('a kill mid-count resumes from the counters, not from zero', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-guard-'));
    const dbFile = join(dataDir, 'a.db');
    const copy = join(dataDir, 'b.db');
    // First engine: 3 identical failures, then the 4th call hangs (the engine is "killed" while it waits).
    const fake1 = new FakeProvider(Array.from({ length: 3 }, missing));
    let hung = false;
    const hanging: Provider = {
      complete: (req: ModelRequest, onText, signal): Promise<ModelResponse> => {
        if (fake1.calls.length < 3) return fake1.complete(req, onText, signal);
        hung = true;
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      },
    } as Provider;
    const a = await launch({ provider: hanging, dbFile, dataDir, leaseMs: 300 });
    const card = a.engine.kanban.create({ title: 'Loop', status: 'ready', assignee: 'atlas' }, 'user');
    await eventually(() => expect(hung).toBe(true), { what: 'the 4th model call' });
    expect(a.engine.db.prepare("SELECT turns, repeat_streak FROM runs WHERE status = 'running'").get()).toEqual({ turns: 3, repeat_streak: 3 });
    // A hard kill: the database as it is now, run still 'running' with a lease that will expire.
    await a.engine.db.backup(copy);
    await a.engine.stop();

    const b = await launch({ script: Array.from({ length: 2 }, missing), dbFile: copy, dataDir, leaseMs: 300 });
    await eventually(() => expect(b.engine.kanban.get(card.id).status).toBe('blocked'), { what: 'stopped after the restart' });
    expect(b.fake.calls).toHaveLength(2); // 3 before the kill + 2 after = 5
    const runs = b.engine.runner.runs(card.id);
    expect(runs.map((r) => r.status).sort()).toEqual(['done', 'interrupted']);
    expect(runs[0]!.limit).toMatch(/5 times in a row/);
    expect(b.engine.db.prepare('SELECT turns FROM runs WHERE id = ?').get(runs[0]!.id)).toEqual({ turns: 5 });
  }, 30_000);

  it('a run killed right after its stop is not resumed nor stopped twice: the stop is routed after the restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-guard-'));
    const dbFile = join(dataDir, 'a.db');
    const a = await launch({ dbFile, dataDir, dispatch: false });
    const card = a.engine.kanban.create({ title: 'Loop', status: 'running', assignee: 'atlas' }, 'user');
    a.engine.kanban.appendMessage(card.id, 'assistant', 'system', text(stopNote('x repeated')));
    a.engine.db
      .prepare("INSERT INTO runs (id, card_id, agent_id, kind, status, started_at, lease_until, limit_reason) VALUES ('r_dead', ?, 'atlas', 'work', 'running', ?, ?, 'x repeated')")
      .run(card.id, new Date().toISOString(), new Date(Date.now() - 1000).toISOString());
    await a.engine.stop();

    const b = await launch({ dbFile, dataDir });
    await eventually(() => expect(b.engine.kanban.get(card.id).status).toBe('blocked'), { what: 'the stop routed to Master' });
    expect(b.engine.runner.runs(card.id)).toEqual([expect.objectContaining({ id: 'r_dead', status: 'done', limit: 'x repeated' })]);
    expect(b.fake.calls).toHaveLength(0);
    expect(b.engine.kanban.messages(card.id).filter((m) => m.author === 'system')).toHaveLength(1);
  });
});
