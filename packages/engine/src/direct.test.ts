import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { chatTitle } from './kanban.ts';
import { cleanTitle } from './runner.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});
const json = { 'content-type': 'application/json' };

describe('direct chat with an agent', () => {
  it('makes a new chat per click, off the board, named by the first message, answered in chat mode, refusing work-card moves', async () => {
    const fake = new FakeProvider([[{ type: 'text', text: 'Hello.' }]]);
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
    // Named by the user's first message, not renamed by the answer; the chat with activity comes first in the history.
    expect(engine.kanban.get(chat.id).title).toBe('hi, how is the build going?');
    expect(((await (await fetch(u + '/chats')).json()) as Card[]).map((c) => c.id)).toEqual([chat.id, other.id]);
    expect(fake.calls[0]!.system).toMatch(/direct chat with the user/);
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

  it('flags a chat as working while its agent answers (live, both chats at once), without moving it up the history', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = new FakeProvider([[{ type: 'text', text: 'a' }], [{ type: 'text', text: 'b' }]]);
    const complete = fake.complete.bind(fake);
    fake.complete = async (req, onText, signal) => {
      if (!req.system.startsWith('You name a chat')) await gate;
      return complete(req, onText, signal);
    };
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, providers: () => fake });
    const u = engine.url + '/api';
    const newChat = async () => (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as Card;
    const [a, b, idle] = [await newChat(), await newChat(), await newChat()];
    expect(a.working).toBe(false);
    const live = new Map<string, boolean>();
    engine.bus.on((e) => { if (e.type === 'card.updated') live.set(e.card.id, e.card.working); });
    for (const c of [a, b])
      await fetch(u + `/cards/${c.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'hi ' + c.id }) });
    await expect.poll(() => live.get(a.id) && live.get(b.id), { timeout: 5000 }).toBe(true);
    const chats = (await (await fetch(u + '/chats')).json()) as Card[];
    expect(chats.filter((c) => c.working).map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(chats.find((c) => c.id === idle.id)!.working).toBe(false);
    const before = engine.kanban.get(b.id).updatedAt;
    release();
    await expect.poll(() => live.get(a.id) === false && live.get(b.id) === false, { timeout: 5000 }).toBe(true);
    expect(engine.kanban.get(a.id).working).toBe(false);
    // The run ending re-sends the chat but does not bump its activity time (its answer message does, separately).
    expect(engine.kanban.get(b.id).updatedAt >= before).toBe(true);
  });

  it("has the model rename a chat at the user's 3rd message, once, showing it is naming meanwhile", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = new FakeProvider([]);
    const complete = fake.complete.bind(fake);
    fake.complete = async (req, onText, signal) => {
      if (req.system.startsWith('You name a chat')) {
        fake.calls.push(structuredClone(req));
        await gate;
        return { content: [{ type: 'text', text: '"Deploy failure on staging."' }], stopReason: 'end_turn', usage: { input: 1, output: 1 } };
      }
      return complete(req, onText, signal);
    };
    for (let i = 0; i < 4; i++) (fake as unknown as { script: unknown[] }).script.push([{ type: 'text', text: 'ok' }]);
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, providers: () => fake });
    const u = engine.url + '/api';
    const chat = (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as Card;
    const say = async (text: string, n: number) => {
      await fetch(u + `/cards/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text }) });
      await expect.poll(() => engine!.kanban.messages(chat.id).filter((m) => m.author === 'atlas').length, { timeout: 5000 }).toBe(n);
    };
    await say('hi', 1);
    await say('the deploy broke', 2);
    expect(engine.kanban.get(chat.id)).toMatchObject({ title: 'hi', naming: false });
    await say('on staging, last night', 3);
    expect(engine.kanban.get(chat.id)).toMatchObject({ title: 'hi', naming: true });
    release();
    await expect.poll(() => engine!.kanban.get(chat.id).naming, { timeout: 5000 }).toBe(false);
    expect(engine.kanban.get(chat.id).title).toBe('Deploy failure on staging');
    const titleCall = fake.calls.find((c) => c.system.startsWith('You name a chat'))!;
    expect(JSON.stringify(titleCall.messages)).toMatch(/the user: hi.*the deploy broke.*on staging/);
    // Once only.
    await say('more', 4);
    expect(fake.calls.filter((c) => c.system.startsWith('You name a chat'))).toHaveLength(1);
    expect(engine.kanban.get(chat.id).title).toBe('Deploy failure on staging');
  });

  it('tidies the model title', () => {
    expect(cleanTitle('Title: “Fix the login bug”.\nmore')).toBe('Fix the login bug');
    expect(cleanTitle('  ')).toBe('');
  });

  it("puts the user's name and own description in the prompt, and requires both", async () => {
    const fake = new FakeProvider([[{ type: 'text', text: 'Hi Ada.' }]]);
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, providers: () => fake });
    const u = engine.url + '/api';
    const patch = (body: unknown) => fetch(u + '/settings', { method: 'PATCH', headers: json, body: JSON.stringify(body) });
    expect(await (await fetch(u + '/settings')).json()).toMatchObject({ userName: null, userAbout: null });
    expect((await patch({ userName: '  ' })).status).toBe(400);
    expect((await patch({ userAbout: 'x'.repeat(201) })).status).toBe(400);
    expect(await (await patch({ userName: ' Ada ', userAbout: 'Mathematician, 36, new to programming.' })).json()).toMatchObject({
      userName: 'Ada',
      userAbout: 'Mathematician, 36, new to programming.',
    });
    const chat = (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as Card;
    await fetch(u + `/cards/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'hi' }) });
    await expect.poll(() => fake.calls.length, { timeout: 5000 }).toBe(1);
    const system = fake.calls[0]!.system;
    expect(system).toMatch(/works for Ada, the user: the only human here/);
    expect(system).toContain('# Ada\nIn their own words: "Mathematician, 36, new to programming."');
    expect(system).toMatch(/A direct chat with Ada, not a card/);
    expect(system).toMatch(/Today is \w+day,? \d+ \w+ \d{4} \(.+\)\.$/);
    expect(system).not.toMatch(/\bCan\b|\b(he|him|his)\b/);
    expect(engine.kanban.messages(chat.id)[0]!.author).toBe('user');
  });
});
