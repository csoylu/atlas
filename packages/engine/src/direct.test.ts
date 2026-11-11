import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { chatTitle } from './kanban.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});
const json = { 'content-type': 'application/json' };

describe('direct chat with an agent', () => {
  it('makes a new chat per click, off the board, named by the first message, answered in chat mode, refusing work-card moves', async () => {
    const fake = new FakeProvider([[{ type: 'text', text: 'Hello Can.' }]]);
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, providers: () => fake });
    const u = engine.url + '/api';
    const newChat = async () => (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as Card;
    const chat = await newChat();
    expect(chat).toMatchObject({ board: 'direct', assignee: 'atlas', status: 'done', title: 'New chat' });
    // A second click is a second chat; neither is on the board.
    const other = await newChat();
    expect(other.id).not.toBe(chat.id);
    expect(((await (await fetch(u + '/cards')).json()) as Card[]).some((c) => c.board === 'direct')).toBe(false);
    expect((await fetch(u + '/agents/nobody/chats', { method: 'POST' })).status).toBe(404);

    await fetch(u + `/cards/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'hi, how is the   build going?' }) });
    await expect.poll(() => engine!.kanban.messages(chat.id).some((m) => m.author === 'atlas'), { timeout: 5000 }).toBe(true);
    // Named by Can's first message, not renamed by the answer; the chat with activity comes first in the history.
    expect(engine.kanban.get(chat.id).title).toBe('hi, how is the build going?');
    expect(((await (await fetch(u + '/chats')).json()) as Card[]).map((c) => c.id)).toEqual([chat.id, other.id]);
    expect(fake.calls[0]!.system).toMatch(/direct chat with Can/);
    expect(fake.calls[0]!.system).not.toMatch(/Current card:/);
    // Still a chat: not moved by the run.
    expect(engine.kanban.get(chat.id).status).toBe('done');

    // An agent (or the UI) can't turn it into a work card.
    const move = await fetch(u + `/cards/${chat.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'ready' }) });
    expect(move.status).toBe(400);
    expect(() => engine!.kanban.block(chat.id, { kind: 'needs_input', reason: 'x' }, 'atlas')).toThrow(/direct chat/);
  });

  it("uses the chat's own model and effort when picked, without moving it up the history", async () => {
    const fake = new FakeProvider([[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]]);
    const used: string[] = [];
    engine = await startEngine({
      dbFile: ':memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'atlas-')),
      port: 0,
      providers: (m) => {
        used.push(m.id);
        return fake;
      },
    });
    const u = engine.url + '/api';
    await fetch(u + '/models', { method: 'POST', headers: json, body: JSON.stringify({ id: 'other', provider: 'openai_compat', name: 'other-model', baseUrl: 'http://127.0.0.1:9/v1' }) });
    const chat = (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as Card;
    const later = (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as Card;
    await fetch(u + `/cards/${later.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'first' }) });
    await expect.poll(() => engine!.kanban.messages(later.id).some((m) => m.author === 'atlas'), { timeout: 5000 }).toBe(true);
    expect(fake.calls[0]!.effort).toBeUndefined();

    const picked = await fetch(u + `/cards/${chat.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ modelId: 'other', effort: 'high' }) });
    expect(await picked.json()).toMatchObject({ modelId: 'other', effort: 'high' });
    // Picking isn't activity: the other chat stays first.
    expect(((await (await fetch(u + '/chats')).json()) as Card[])[0]!.id).toBe(later.id);
    expect((await fetch(u + `/cards/${chat.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ modelId: 'nope' }) })).status).toBe(409);
    expect((await fetch(u + `/cards/${chat.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ effort: 'extreme' }) })).status).toBe(400);
    // « Off » (thinking off on local models) is stored like the others.
    expect(await (await fetch(u + `/cards/${chat.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ effort: 'none' }) })).json()).toMatchObject({ effort: 'none' });
    await fetch(u + `/cards/${chat.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ effort: 'high' }) });

    used.length = 0;
    await fetch(u + `/cards/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'hi' }) });
    await expect.poll(() => engine!.kanban.messages(chat.id).some((m) => m.author === 'atlas'), { timeout: 5000 }).toBe(true);
    expect(used).toContain('other');
    expect(fake.calls[1]).toMatchObject({ model: 'other-model', effort: 'high' });

    // Back to the agent's model and the model's default effort.
    expect(await (await fetch(u + `/cards/${chat.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ modelId: null, effort: null }) })).json()).toMatchObject({ modelId: null, effort: null });
  });

  it('titles a chat with the start of a long first message, cut at a word', () => {
    expect(chatTitle('short')).toBe('short');
    const t = chatTitle('please look at the failing deploy on the staging server and tell me what broke last night');
    expect(t.length).toBeLessThanOrEqual(61);
    expect(t).toBe('please look at the failing deploy on the staging server and…');
  });
});
