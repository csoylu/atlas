import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { Card, ContentBlock, ServerEvent, Settings } from '@atlas/shared';
import { eventually, launch } from '../test/kit/index.ts';
import { preview } from './chatReads.ts';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input });

/** Every chat.replied event of the engine, in order. */
function replies(l: Awaited<ReturnType<typeof launch>>) {
  const seen: Extract<ServerEvent, { type: 'chat.replied' }>[] = [];
  l.engine.bus.on((e) => {
    if (e.type === 'chat.replied') seen.push(e);
  });
  return seen;
}

describe('unread replies in chats (#338)', () => {
  it('a final reply marks the chat unread, once; tool steps and task notes do not', async () => {
    const l = await launch({
      script: [[{ type: 'text', text: 'Looking.' }, use('todo_write', { todos: [] })], text('Ready. CI is green.\n\nOne thing for you: should a waiting task count as stuck?')],
    });
    const seen = replies(l);
    const chat = await l.chat();
    expect(chat).toMatchObject({ unread: false, readSeq: 0 });
    // Master is not looking (no window views it): the reply arrives in the background.
    const midRun: boolean[] = [];
    l.engine.bus.on((e) => {
      if (e.type === 'toolcall.updated' && e.cardId === chat.id) midRun.push(l.engine.kanban.get(chat.id).unread);
    });
    await l.say(chat.id, 'is #237 ready?');
    await l.idle(chat.id);
    // The tool step ran while the chat stayed read; only the run's last message counts.
    expect(midRun.length).toBeGreaterThan(0);
    expect(midRun.every((u) => !u)).toBe(true);
    const after = l.engine.kanban.get(chat.id);
    expect(after.unread).toBe(true);
    const last = l.engine.kanban.messages(chat.id).at(-1)!;
    expect(seen).toEqual([{ type: 'chat.replied', chatId: chat.id, agentId: 'atlas', projectId: chat.projectId, seq: last.seq, text: 'Ready. CI is green. One thing for you: should a waiting task count as stuck?' }]);
    // The chat list says it too.
    const list = (await l.call<Card[]>('GET', '/chats')).body;
    expect(list.find((c) => c.id === chat.id)).toMatchObject({ unread: true, readSeq: 0 });

    // Mark as read; then a task note in the chat (a task it made finished) does not turn it unread again.
    await l.call('POST', `/chats/${chat.id}/read`);
    expect(l.engine.kanban.get(chat.id)).toMatchObject({ unread: false, readSeq: last.seq });
    const card = l.engine.kanban.create({ title: 'Job', status: 'running', assignee: 'atlas' }, 'atlas', chat.id);
    l.engine.kanban.update(card.id, { status: 'done' }, 'atlas', 'all good');
    expect(l.engine.kanban.messages(chat.id).at(-1)!.author).toBe('system');
    expect(l.engine.kanban.get(chat.id).unread).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('a chat on screen in a focused window never turns unread; leaving it reads what was seen', async () => {
    const l = await launch({ script: [text('One.'), text('Two.')] });
    const seen = replies(l);
    const chat = await l.chat();
    // A real window: its socket says which chat it shows.
    const ws = new WebSocket(l.api.replace('http', 'ws') + '/events');
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'viewing', chatId: chat.id }));
    await eventually(() => expect(l.engine.reads.viewed(chat.id)).toBe(true));
    await l.say(chat.id, 'hi');
    await l.idle(chat.id);
    expect(l.engine.kanban.get(chat.id)).toMatchObject({ unread: false, readSeq: l.engine.kanban.messages(chat.id).at(-1)!.seq });
    expect(seen).toEqual([]);

    // Atlas goes to the background: the next reply is unread and notified.
    ws.send(JSON.stringify({ type: 'viewing', chatId: null }));
    await eventually(() => expect(l.engine.reads.viewed(chat.id)).toBe(false));
    await l.say(chat.id, 'again');
    await l.idle(chat.id);
    const before = l.engine.kanban.get(chat.id);
    expect(before.unread).toBe(true);
    expect(seen.map((e) => e.text)).toEqual(['Two.']);
    // Back on it: read at once, in every window (card.updated); the readSeq the window opened with places « New ».
    ws.send(JSON.stringify({ type: 'viewing', chatId: chat.id }));
    await eventually(() => expect(l.engine.kanban.get(chat.id).unread).toBe(false));
    // A closed window stops viewing.
    ws.close();
    await eventually(() => expect(l.engine.reads.viewed(chat.id)).toBe(false));
    // Junk on the socket is refused, not fatal.
    const junk = new WebSocket(l.api.replace('http', 'ws') + '/events');
    await new Promise((r) => junk.once('open', r));
    junk.send('not json');
    junk.send(JSON.stringify({ type: 'viewing', chatId: 'c_missing' }));
    junk.close();
  });

  it('mark all as read clears every chat; an unknown chat is a 404', async () => {
    const l = await launch({ script: [text('A.'), text('B.')] });
    const a = await l.chat();
    const b = await l.chat();
    await l.say(a.id, 'a');
    await l.idle(a.id);
    await l.say(b.id, 'b');
    await l.idle(b.id);
    expect(l.engine.reads.unreadCount()).toBe(2);
    await l.call('POST', '/chats/read');
    expect(l.engine.reads.unreadCount()).toBe(0);
    expect([l.engine.kanban.get(a.id).unread, l.engine.kanban.get(b.id).unread]).toEqual([false, false]);
    expect((await l.call('POST', '/chats/c_nope/read')).status).toBe(404);
  });

  it('read state, unread flags and both switches survive a restart (rule 2)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-t-'));
    const dbFile = join(dataDir, 'atlas.db');
    const first = await launch({ dbFile, dataDir, script: [text('Read me.'), text('And me.')] });
    const read = await first.chat();
    const unread = await first.chat();
    await first.say(read.id, 'x');
    await first.idle(read.id);
    await first.call('POST', `/chats/${read.id}/read`);
    await first.say(unread.id, 'y');
    await first.idle(unread.id);
    expect((await first.call<Settings>('GET', '/settings')).body).toMatchObject({ notifyReplies: true, countBadge: true });
    await first.call('PATCH', '/settings', { notifyReplies: false, countBadge: false });
    const readSeq = first.engine.kanban.get(read.id).readSeq;
    await first.engine.stop();

    const second = await launch({ dbFile, dataDir });
    expect(second.engine.kanban.get(read.id)).toMatchObject({ unread: false, readSeq });
    expect(second.engine.kanban.get(unread.id)).toMatchObject({ unread: true, readSeq: 0 });
    expect(second.engine.reads.unreadCount()).toBe(1);
    expect((await second.call<Settings>('GET', '/settings')).body).toMatchObject({ notifyReplies: false, countBadge: false });
  });

  it('the notification text is the first lines, cut with an ellipsis', () => {
    expect(preview('Line one.\n\nLine two.')).toBe('Line one. Line two.');
    const long = preview('word '.repeat(100));
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith('…')).toBe(true);
  });
});
