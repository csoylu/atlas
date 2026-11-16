import { cardRef } from '@atlas/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});
const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input });
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
async function until(cond: () => boolean, what: string) {
  const end = Date.now() + 3000;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('team: memory, messages between cards, agent and model management', () => {
  it('keeps memory in the instructions and lets agents edit it', async () => {
    const fake = new FakeProvider([[use('memory_edit', { text: 'The user likes short answers.' }), use('memory_edit', { scope: 'shared', text: 'Repo: ~/atlas' })], text('Noted.'), text('ok')]);
    const e = (engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, providers: () => fake, env: {} }));
    const card = e.kanban.create({ title: 'x', assignee: 'atlas', status: 'done' }, 'user');
    e.kanban.appendMessage(card.id, 'user', 'user', text('remember this'));
    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    expect(e.memories.get('atlas').text).toBe('The user likes short answers.');
    expect(e.memories.get('shared').text).toBe('Repo: ~/atlas');
    e.kanban.appendMessage(card.id, 'user', 'user', text('again'));
    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    expect(fake.calls[2]!.system).toContain('Yours (only you edit it, with memory_edit):\nThe user likes short answers.');
    expect(fake.calls[2]!.system).toContain('Shared by all agents:\nRepo: ~/atlas');
    expect(() => e.memories.set('atlas', 'x'.repeat(5000), 'atlas')).toThrow(/limited to 4000/);
  });

  it('delivers a message from one card to the agent of another', async () => {
    let target = '';
    const fake = new FakeProvider([
      () => [use('card_message', { id: target, text: 'Which port does the API use?' })],
      text('Asked.'),
      text('Port 4317.'),
    ]);
    const e = (engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, providers: () => fake, env: {} }));
    e.dispatcher.stop();
    e.agents.create({ id: 'munih', modelId: 'sonnet' });
    target = e.kanban.create({ title: 'API', assignee: 'munih', status: 'done' }, 'user').id;
    const asker = e.kanban.create({ title: 'UI', assignee: 'atlas', status: 'done' }, 'user');
    e.kanban.appendMessage(asker.id, 'user', 'user', text('ask munih'));
    e.runner.wake(asker.id);
    await e.runner.settled(asker.id);
    await until(() => e.kanban.messages(target).at(-1)?.author === 'munih', 'munih reply');
    const msgs = e.kanban.messages(target);
    expect(msgs[0]).toMatchObject({ author: 'atlas', content: text(`[from @atlas, card ${cardRef(asker)}] Which port does the API use?`) });
    expect(e.kanban.get(target).status).toBe('done'); // an agent's message never changes the card status
  });

  it('manages agents and models with clear refusals', async () => {
    const e = (engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, env: { ANTHROPIC_API_KEY: 'k' } }));
    expect(e.models.get('sonnet').credentialPresent).toBe(true);
    expect(e.models.get('local').credentialPresent).toBe(false);
    const m = e.models.create({ id: 'ollama', provider: 'openai_compat', name: 'qwen', baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(m).toMatchObject({ credentialEnv: null, verifiedAt: null, lastError: null });
    expect(() => e.models.create({ id: 'bad', provider: 'openai_compat', name: 'x' })).toThrow(/base URL/);
    expect(() => e.models.remove('sonnet')).toThrow(/used by @atlas/);
    e.models.record('ollama', 'boom');
    expect(e.models.update('ollama', { name: 'qwen2' })).toMatchObject({ name: 'qwen2', lastError: null }); // editing clears the old check
    e.models.remove('ollama');

    e.agents.create({ id: 'paris', modelId: 'sonnet', rolePrompt: 'Engineer' });
    const c = e.kanban.create({ title: 'x', assignee: 'paris', status: 'ready' }, 'user');
    const cancelled = e.kanban.create({ title: 'y', assignee: 'paris', status: 'ready' }, 'user');
    e.kanban.update(cancelled.id, { status: 'closed' }, 'user');
    // An open card blocks; the closed (cancelled) one isn't listed.
    expect(() => e.agents.remove('paris')).toThrow(new RegExp(`open cards: ${cardRef(c)}\\. Reassign`));
    expect(() => e.agents.remove('atlas')).toThrow(/triage agent: pick another one in Settings → Board/);
    e.kanban.update(c.id, { status: 'done' }, 'user');
    e.agents.remove('paris'); // only done + closed cards left: deletable
    expect(e.kanban.get(c.id).assignee).toBeNull();
    expect(e.kanban.get(cancelled.id).assignee).toBeNull();
    expect(() => e.agents.get('paris')).toThrow(/paris/);
  });
});
