import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card, ClearEvent, CompactResult, RewindResult, Timeline } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { SUMMARY_LEAD, TODO_LEAD } from './context.ts';
import type { ModelRequest } from './providers/types.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop().catch(() => {});
  engine = undefined;
});
const json = { 'content-type': 'application/json' };
const text = (t: string) => [{ type: 'text' as const, text: t }];
/** A reply that echoes what the model was sent, so the test can read its view. */
const echo = (req: ModelRequest) => text('VIEW ' + JSON.stringify(req.messages));

async function setup(script: ConstructorParameters<typeof FakeProvider>[0], o: { dataDir?: string; dbFile?: string } = {}) {
  const fake = new FakeProvider(script);
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-slash-'));
  engine = await startEngine({ dbFile: o.dbFile ?? ':memory:', dataDir, port: 0, providers: () => fake, manageLocal: false });
  mkdirSync(join(dataDir, 'workspaces', 'atlas'), { recursive: true });
  const u = engine.url + '/api';
  const e = engine;
  const say = async (cardId: string, t: string) => {
    const r = await fetch(u + `/cards/${cardId}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: t }) });
    expect(r.status).toBe(201);
  };
  const idle = (cardId: string) => expect.poll(() => e.runner.current(cardId), { timeout: 8000 }).toBeNull();
  const command = (cardId: string, command: 'clear' | 'compact', arg?: string) =>
    fetch(u + `/cards/${cardId}/command`, { method: 'POST', headers: json, body: JSON.stringify(arg ? { command, arg } : { command }) });
  const timeline = async (cardId: string) => (await (await fetch(u + `/cards/${cardId}/timeline`)).json()) as Timeline;
  const chat = async () => (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as Card;
  const lastView = () => JSON.stringify(fake.calls.at(-1)!.messages);
  return { fake, e, u, dataDir, say, idle, command, timeline, chat, lastView };
}

describe('/clear', () => {
  it('the agent forgets everything before it (no summary, no todos); the messages stay, Undo brings it back', async () => {
    const t = await setup([text('a1'), echo, echo]);
    const c = await t.chat();
    await t.say(c.id, 'old secret topic');
    await t.idle(c.id);
    t.e.kanban.setTodos(c.id, [{ content: 'old todo', status: 'pending' }]);
    t.e.db.prepare('UPDATE conversations SET summary = ?, summary_upto_seq = ? WHERE id = ?').run('summary of old', 1, c.conversationId);

    const r = await t.command(c.id, 'clear');
    expect(r.status).toBe(200);
    const { clear } = (await r.json()) as { clear: ClearEvent };
    expect(clear).toMatchObject({ uptoSeq: 2, hidden: 2, undoable: true });
    expect(t.e.db.prepare('SELECT summary, summary_upto_seq, todos FROM conversations WHERE id = ?').get(c.conversationId)).toEqual({ summary: null, summary_upto_seq: null, todos: null });
    // Nothing deleted: the chat still has them (it folds them), history_search reads them.
    expect(t.e.kanban.messages(c.id)).toHaveLength(2);
    expect((await t.timeline(c.id)).clears).toEqual([clear]);
    // Twice in a row: nothing to clear.
    expect((await t.command(c.id, 'clear')).status).toBe(409);

    // Undo (before the next message): the view has the old messages, the summary and todos again.
    expect((await fetch(t.u + `/clears/${clear.id}/undo`, { method: 'POST' })).status).toBe(200);
    expect(t.e.db.prepare('SELECT summary, todos FROM conversations WHERE id = ?').get(c.conversationId)).toEqual({ summary: 'summary of old', todos: JSON.stringify([{ content: 'old todo', status: 'pending' }]) });
    expect((await t.timeline(c.id)).clears).toEqual([]);
    expect((await fetch(t.u + `/clears/${clear.id}/undo`, { method: 'POST' })).status).toBe(409);

    // Clear again, then write: the model sees only the new message.
    const again = ((await (await t.command(c.id, 'clear')).json()) as { clear: ClearEvent }).clear;
    await t.say(c.id, 'fresh start');
    await t.idle(c.id);
    const view = t.lastView();
    expect(view).toContain('fresh start');
    expect(view).not.toContain('old secret topic');
    expect(view).not.toContain('a1');
    expect(view).not.toContain(SUMMARY_LEAD);
    expect(view).not.toContain(TODO_LEAD);
    // Undo only until the next message.
    expect((await t.timeline(c.id)).clears![0]).toMatchObject({ id: again.id, undoable: false });
    expect((await fetch(t.u + `/clears/${again.id}/undo`, { method: 'POST' })).status).toBe(409);
  });

  it('stops a running agent first (as Stop, not a rewind), then clears', async () => {
    const t = await setup([[{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'sleep 20' } }], echo]);
    const c = await t.chat();
    await t.say(c.id, 'long job');
    await expect.poll(() => t.e.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE status = 'running'").get(), { timeout: 8000 }).toEqual({ n: 1 });
    const r = await t.command(c.id, 'clear');
    expect(r.status).toBe(200);
    expect(t.e.runner.current(c.id)).toBeNull();
    expect(t.e.runner.runs(c.id)[0]).toMatchObject({ status: 'stopped', error: 'stopped by you' });
    // Not a rewind: the messages are still there.
    expect(t.e.kanban.messages(c.id).some((m) => m.author === 'user')).toBe(true);
    await t.say(c.id, 'next');
    await t.idle(c.id);
    expect(t.lastView()).not.toContain('long job');
  });

  it('rewind to a message before the clear takes the clear away; undoing the rewind brings it back', async () => {
    const t = await setup([text('a1'), text('a2'), echo]);
    const c = await t.chat();
    await t.say(c.id, 'first');
    await t.idle(c.id);
    await t.say(c.id, 'second');
    await t.idle(c.id);
    const clear = ((await (await t.command(c.id, 'clear')).json()) as { clear: ClearEvent }).clear;
    const second = t.e.kanban.messages(c.id).filter((m) => m.author === 'user')[1]!;
    const rw = (await (await fetch(t.u + `/cards/${c.id}/rewind`, { method: 'POST', headers: json, body: JSON.stringify({ seq: second.seq }) })).json()) as RewindResult;
    expect(rw.text).toBe('second');
    expect((await t.timeline(c.id)).clears).toEqual([]);
    expect(t.e.runner.contextStart(c.id)).toBe(0);

    // Undo of the rewind: the messages and the clear come back.
    expect((await fetch(t.u + `/rewinds/${rw.id}/undo`, { method: 'POST' })).status).toBe(200);
    expect((await t.timeline(c.id)).clears!.map((x) => x.id)).toEqual([clear.id]);

    // Rewind again and continue from there: the model sees « first » (before the target), not the cleared state.
    await fetch(t.u + `/cards/${c.id}/rewind`, { method: 'POST', headers: json, body: JSON.stringify({ seq: second.seq }) });
    await t.say(c.id, 'second again');
    await t.idle(c.id);
    const view = t.lastView();
    expect(view).toContain('first');
    expect(view).toContain('second again');
  });

  it('a rewind to a message after the clear keeps the clear', async () => {
    const t = await setup([text('a1'), text('a2')]);
    const c = await t.chat();
    await t.say(c.id, 'before');
    await t.idle(c.id);
    await t.command(c.id, 'clear');
    await t.say(c.id, 'after');
    await t.idle(c.id);
    const after = t.e.kanban.messages(c.id).find((m) => m.author === 'user' && m.seq > 2)!;
    await fetch(t.u + `/cards/${c.id}/rewind`, { method: 'POST', headers: json, body: JSON.stringify({ seq: after.seq }) });
    expect((await t.timeline(c.id)).clears).toHaveLength(1);
    expect(t.e.runner.contextStart(c.id)).toBe(2);
  });

  it('survives a restart (rule 2: the clear point is in SQLite)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-slash-'));
    const dbFile = join(dataDir, 'atlas.db');
    let t = await setup([text('a1')], { dataDir, dbFile });
    const c = await t.chat();
    await t.say(c.id, 'old');
    await t.idle(c.id);
    await t.command(c.id, 'clear');
    await engine!.stop();
    t = await setup([echo], { dataDir, dbFile });
    expect(t.e.runner.contextStart(c.id)).toBe(2);
    await t.say(c.id, 'new');
    await t.idle(c.id);
    expect(t.lastView()).not.toContain('old');
  });
});

describe('/compact', () => {
  it('folds every message into the summary now, with the focus; the chat shows « by you »', async () => {
    let summaryReq: ModelRequest | null = null;
    const t = await setup([
      text('a1'),
      text('a2'),
      (req) => {
        summaryReq = req;
        return text('THE SUMMARY');
      },
      echo,
      text('Chat title'), // the 3rd user message names the chat
    ]);
    const c = await t.chat();
    await t.say(c.id, 'first');
    await t.idle(c.id);
    await t.say(c.id, 'second');
    await t.idle(c.id);
    const r = await t.command(c.id, 'compact', 'keep the rewind design');
    expect(r.status).toBe(200);
    const { compact } = (await r.json()) as { compact: CompactResult };
    expect(compact).toEqual({ uptoSeq: 4, messages: 4, summaryChars: 'THE SUMMARY'.length });
    const body = JSON.stringify(summaryReq!.messages);
    expect(body).toContain('keep the rewind design');
    expect(body).toContain('second');
    expect(t.e.db.prepare('SELECT summary, summary_upto_seq FROM conversations WHERE id = ?').get(c.conversationId)).toEqual({ summary: 'THE SUMMARY', summary_upto_seq: 4 });
    expect((await t.timeline(c.id)).summary).toEqual({ uptoSeq: 4, text: 'THE SUMMARY', byUser: true });
    // Nothing new since: refused.
    expect((await t.command(c.id, 'compact')).status).toBe(409);

    await t.say(c.id, 'third');
    await t.idle(c.id);
    const view = t.lastView();
    expect(view).toContain(SUMMARY_LEAD);
    expect(view).toContain('THE SUMMARY');
    expect(view).toContain('third');
    expect(view).not.toContain('a1');
  });

  it('stops a running agent first, then compacts, and does not restart the stopped job (zurich #100)', async () => {
    const t = await setup([[{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'sleep 20' } }], text('S'), echo]);
    const c = await t.chat();
    await t.say(c.id, 'long job');
    await expect.poll(() => t.e.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE status = 'running'").get(), { timeout: 8000 }).toEqual({ n: 1 });
    const r = await t.command(c.id, 'compact');
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    expect(t.e.runner.current(c.id)).toBeNull();
    expect(t.e.runner.runs(c.id)).toHaveLength(1);
    expect(t.e.runner.runs(c.id)[0]).toMatchObject({ status: 'stopped', error: 'stopped by you' });
    // The next message is answered as usual, from the summary.
    await t.say(c.id, 'next');
    await t.idle(c.id);
    expect(t.e.runner.runs(c.id)).toHaveLength(2);
    expect(t.lastView()).toContain('S');
  });

  it('after a clear, compacts only what came after it', async () => {
    let summaryReq: ModelRequest | null = null;
    const t = await setup([
      text('a1'),
      text('a2'),
      (req) => {
        summaryReq = req;
        return text('S');
      },
    ]);
    const c = await t.chat();
    await t.say(c.id, 'cleared away');
    await t.idle(c.id);
    await t.command(c.id, 'clear');
    await t.say(c.id, 'kept');
    await t.idle(c.id);
    expect((await t.command(c.id, 'compact')).status).toBe(200);
    const body = JSON.stringify(summaryReq!.messages);
    expect(body).toContain('kept');
    expect(body).not.toContain('cleared away');
  });

  it('a summary from before a clear brought back by an undone rewind is ignored', async () => {
    const t = await setup([text('a1')]);
    const c = await t.chat();
    await t.say(c.id, 'x');
    await t.idle(c.id);
    await t.command(c.id, 'clear');
    t.e.db.prepare('UPDATE conversations SET summary = ?, summary_upto_seq = ? WHERE id = ?').run('stale', 1, c.conversationId);
    expect(t.e.runner.summaryOf(c.id)).toBeNull();
  });
});
