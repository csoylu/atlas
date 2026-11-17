import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import type { ModelRequest, ModelResponse, OnDelta, Provider } from './providers/types.ts';
import { runTeamTool, type TeamToolContext } from './teamTools.ts';

/** agent_message (#96). The fake model answers from one script per agent (runs of different agents overlap). */
type Step = ContentBlock[] | ((req: ModelRequest) => ContentBlock[]);
class AgentFake implements Provider {
  calls: { agent: string; req: ModelRequest }[] = [];
  constructor(public scripts: Record<string, Step[]>) {}
  async complete(req: ModelRequest, _onText: OnDelta, signal: AbortSignal): Promise<ModelResponse> {
    const agent = /You are "([^"]+)"/.exec(req.system)![1]!;
    this.calls.push({ agent, req: structuredClone(req) });
    const step = this.scripts[agent]?.shift();
    if (!step) throw new Error(`fake: script of @${agent} exhausted`);
    const content = typeof step === 'function' ? step(req) : step;
    await new Promise((r) => setTimeout(r, 1));
    signal.throwIfAborted();
    return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input: 1, output: 1 } };
  }
}

const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input });
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const texts = (e: Engine, cardId: string) => e.kanban.messages(cardId).map((m) => `${m.author}: ${m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? `(${String(b.content)})` : `[${b.type}]`)).join(' ')}`);

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});
async function setup(fake: Provider, o: { dbFile?: string; dataDir?: string; dispatch?: boolean } = {}) {
  const e = await startEngine({
    memoryReview: false,
    dbFile: o.dbFile ?? ':memory:',
    dataDir: o.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    dispatch: o.dispatch ?? true,
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

describe('agent_message', () => {
  it('reaches an agent with no task in its main chat, wakes it, and its answer comes back to the sender (one hop)', async () => {
    const fake = new AgentFake({
      atlas: [[use('agent_message', { agent: '@munih', text: 'Which port does the API use?' })], text('Asked munih.'), text('Thanks: 4317.')],
      munih: [text('Port 4317.')],
    });
    const e = await setup(fake);
    e.agents.create({ id: 'munih', modelId: 'sonnet' });
    const asker = e.kanban.create({ title: 'UI', assignee: 'atlas', status: 'done' }, 'user');
    e.kanban.appendMessage(asker.id, 'user', 'user', text('ask munih'));
    e.runner.wake(asker.id);

    await until(() => e.kanban.pendingAgentMessages().length === 0 && !e.runner.current(asker.id) && fake.scripts.atlas!.length === 0, 'reply read by atlas');
    const main = e.kanban.mainChat('munih');
    expect(texts(e, main.id)).toEqual([`atlas: [message from @atlas (task ${e.kanban.ref(asker.id)}); your answer is sent back to them] Which port does the API use?`, 'munih: Port 4317.']);
    // The sender is the author: the UI shows it on the message.
    expect(e.kanban.messages(main.id)[0]).toMatchObject({ role: 'user', author: 'atlas' });
    // The reply may land before or after atlas's « Asked munih. » (munih answers while atlas's turn is in flight).
    const thread = texts(e, asker.id);
    expect(thread.slice(0, 3)).toEqual(['user: ask munih', 'atlas: [tool_use]', 'tool: (message sent to @munih (its main chat); its answer will come back here)']);
    expect(thread.slice(3, 5).sort()).toEqual(['atlas: Asked munih.', 'system: reply from @munih: Port 4317.']);
    expect(thread.slice(5)).toEqual(['atlas: Thanks: 4317.']);
    // One hop: atlas's answer to the reply isn't forwarded back to munih.
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls.filter((c) => c.agent === 'munih')).toHaveLength(1);
    expect(texts(e, main.id)).toHaveLength(2);
  });

  it('lands in the one active task when there is exactly one; else in the main chat. Errors are clear', async () => {
    const e = await setup(new AgentFake({}), { dispatch: false });
    e.agents.create({ id: 'munih', modelId: 'sonnet' });
    const from = e.kanban.create({ title: 'mine', assignee: 'atlas', status: 'done' }, 'user');
    const delivered: string[] = [];
    const ctx = { kanban: e.kanban, agentId: 'atlas', cardId: from.id, deliver: (id: string) => delivered.push(id) } as unknown as TeamToolContext;

    e.kanban.create({ title: 'blocked one', assignee: 'munih', status: 'blocked' }, 'user');
    e.kanban.create({ title: 'finished', assignee: 'munih', status: 'done' }, 'user');
    const work = e.kanban.create({ title: 'API', assignee: 'munih', status: 'running' }, 'user');
    expect(runTeamTool('agent_message', { agent: 'munih', text: 'hi' }, ctx)).toEqual({ output: `message sent to @munih (its task ${e.kanban.ref(work.id)}); its answer will come back here`, isError: false });
    expect(e.kanban.messages(work.id).at(-1)).toMatchObject({ author: 'atlas', content: text(`[message from @atlas (task ${e.kanban.ref(from.id)}); your answer is sent back to them] hi`) });
    expect(delivered).toEqual([work.id]);

    // Two active tasks: ambiguous, so the main chat.
    e.kanban.create({ title: 'second', assignee: 'munih', status: 'ready' }, 'user');
    expect(runTeamTool('agent_message', { agent: 'munih', text: 'again' }, ctx).output).toMatch(/its main chat/);
    expect(e.kanban.messages(e.kanban.mainChat('munih').id).at(-1)!.author).toBe('atlas');
    expect(e.kanban.pendingAgentMessages()).toHaveLength(2);

    expect(runTeamTool('agent_message', { agent: 'nobody', text: 'hi' }, ctx)).toEqual({ output: 'agent @nobody does not exist', isError: true });
    expect(runTeamTool('agent_message', { agent: 'atlas', text: 'hi' }, ctx)).toEqual({ output: 'that is you: you cannot send a message to yourself', isError: true });
    expect(runTeamTool('agent_message', { agent: 'munih', text: '   ' }, ctx)).toMatchObject({ isError: true, output: expect.stringMatching(/invalid input for agent_message/) });
    expect(e.kanban.pendingAgentMessages()).toHaveLength(2);
    expect(delivered).toHaveLength(2);
  });

  it('a restart between the send and the delivery still delivers it, and the answer still comes back', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const dbFile = join(dataDir, 'k.db');
    const first = await setup(new AgentFake({}), { dbFile, dataDir, dispatch: false });
    first.agents.create({ id: 'zurich', modelId: 'sonnet' });
    const chat = first.kanban.mainChat('zurich');
    // Committed (message + outbox row), then killed before the wake.
    first.kanban.sendAgentMessage('zurich', chat.id, 'atlas', 'Is the build green?');
    first.db.close();
    engines = [];

    const fake = new AgentFake({ atlas: [text('Yes, green.')], zurich: [text('Good, atlas says green.')] });
    const second = await setup(fake, { dbFile, dataDir });
    await until(() => second.kanban.pendingAgentMessages().length === 0 && !second.runner.current(chat.id) && fake.scripts.zurich!.length === 0, 'answer read by zurich');
    expect(texts(second, second.kanban.mainChat('atlas').id)).toEqual(['zurich: [message from @zurich (main chat); your answer is sent back to them] Is the build green?', 'atlas: Yes, green.']);
    expect(texts(second, chat.id)).toEqual(['system: reply from @atlas: Yes, green.', 'zurich: Good, atlas says green.']);
  });

  it('tells the sender when the target cannot answer', async () => {
    const fake = new AgentFake({ zurich: [text('ok, noted.')] }); // munih has no script: its run fails
    const e = await setup(fake);
    e.agents.create({ id: 'munih', modelId: 'sonnet' });
    e.agents.create({ id: 'zurich', modelId: 'sonnet' });
    const chat = e.kanban.mainChat('zurich');
    const target = e.kanban.sendAgentMessage('zurich', chat.id, 'munih', 'hello?');
    e.dispatcher.tick();
    await until(() => e.kanban.pendingAgentMessages().length === 0 && fake.scripts.zurich!.length === 0 && !e.runner.current(chat.id), 'failure read');
    expect(texts(e, chat.id)[0]).toBe('system: @munih could not answer: its run failed: fake: script of @munih exhausted.');
    expect(e.runner.runs(target.id).map((r) => r.status)).toEqual(['failed']); // tried once, no retry loop
  });
});
