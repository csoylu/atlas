import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card, Message, RewindPreview, RewindResult, Timeline } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { buildMessages } from './context.ts';
import type { ModelRequest } from './providers/types.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop().catch(() => {});
  engine = undefined;
});
const json = { 'content-type': 'application/json' };

async function setup(script: ConstructorParameters<typeof FakeProvider>[0], o: { dataDir?: string; dbFile?: string } = {}) {
  const fake = new FakeProvider(script);
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-rw-'));
  engine = await startEngine({ dbFile: o.dbFile ?? ':memory:', dataDir, port: 0, providers: () => fake, manageLocal: false });
  const u = engine.url + '/api';
  const work = join(dataDir, 'workspaces', 'atlas');
  mkdirSync(work, { recursive: true });
  const file = (p: string) => (existsSync(join(work, p)) ? readFileSync(join(work, p), 'utf8') : null);
  const e = engine;
  const say = async (cardId: string, text: string) => {
    const r = await fetch(u + `/cards/${cardId}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text }) });
    expect(r.status).toBe(201);
  };
  const idle = (cardId: string) => expect.poll(() => e.runner.current(cardId), { timeout: 8000 }).toBeNull();
  const rewind = async (cardId: string, seq?: number) =>
    (await (await fetch(u + `/cards/${cardId}/rewind`, { method: 'POST', headers: json, body: JSON.stringify(seq ? { seq } : {}) })).json()) as RewindResult | null;
  const undo = (id: string) => fetch(u + `/rewinds/${id}/undo`, { method: 'POST' });
  const chat = async () => (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as Card;
  return { fake, e, u, work, dataDir, file, say, idle, rewind, undo, chat };
}
const write = (cmd: string) => [{ type: 'tool_use' as const, id: 't' + Math.random().toString(36).slice(2, 8), name: 'shell', input: { command: cmd } }];
const text = (t: string) => [{ type: 'text' as const, text: t }];
const userTexts = (ms: Message[]) => ms.filter((m) => m.author === 'user').map((m) => (m.content[0] as { text: string }).text);

describe('rewind', () => {
  it('« Rewind to here » hides that message and the rest, restores the files, and Undo brings both back', async () => {
    const t = await setup([write('echo one > a.txt'), text('wrote one'), write('echo two > a.txt && echo new > b.txt && rm keep.txt'), text('wrote two')]);
    writeFileSync(join(t.work, 'keep.txt'), 'keep');
    const c = await t.chat();
    await t.say(c.id, 'write one');
    await t.idle(c.id);
    await t.say(c.id, 'write two');
    await t.idle(c.id);
    expect([t.file('a.txt'), t.file('b.txt'), t.file('keep.txt')]).toEqual(['two\n', 'new\n', null]);
    const second = t.e.kanban.messages(c.id).filter((m) => m.author === 'user')[1]!;

    const preview = (await (await fetch(t.u + `/cards/${c.id}/rewind?seq=${second.seq}`)).json()) as RewindPreview;
    expect(preview).toMatchObject({ seq: second.seq, hidden: 3, filesError: null });
    expect(preview.files).toEqual([
      { path: 'a.txt', change: 'restored' },
      { path: 'b.txt', change: 'deleted' },
      { path: 'keep.txt', change: 'recreated' },
    ]);

    const r = (await t.rewind(c.id, second.seq))!;
    expect(r).toMatchObject({ text: 'write two', hidden: 3, filesError: null });
    expect(r.files).toHaveLength(3);
    expect([t.file('a.txt'), t.file('b.txt'), t.file('keep.txt')]).toEqual(['one\n', null, 'keep']);
    // Gone from the chat and the model's view; still in the transcript, marked.
    expect(userTexts(t.e.kanban.messages(c.id))).toEqual(['write one']);
    expect(userTexts(t.e.kanban.messages(c.id, { rewound: true }))).toEqual(['write one', 'write two']);
    expect(t.e.kanban.messages(c.id, { rewound: true }).filter((m) => m.rewound).length).toBeGreaterThan(3);
    const view = await (await fetch(t.u + `/cards/${c.id}/messages`)).json() as Message[];
    expect(view.every((m) => !m.rewound)).toBe(true);

    expect((await t.undo(r.id)).status).toBe(200);
    expect([t.file('a.txt'), t.file('b.txt'), t.file('keep.txt')]).toEqual(['two\n', 'new\n', null]);
    expect(userTexts(t.e.kanban.messages(c.id))).toEqual(['write one', 'write two']);
    // Once only.
    expect((await t.undo(r.id)).status).toBe(409);
  });

  it('rewound messages never reach the model; a summary covering them is dropped', async () => {
    const t = await setup([text('a1'), text('a2'), (req: ModelRequest) => text(JSON.stringify(req.messages))]);
    const c = await t.chat();
    await t.say(c.id, 'first');
    await t.idle(c.id);
    await t.say(c.id, 'second secret');
    await t.idle(c.id);
    const second = t.e.kanban.messages(c.id).filter((m) => m.author === 'user')[1]!;
    t.e.db.prepare('UPDATE conversations SET summary = ?, summary_upto_seq = ? WHERE id = ?').run('summary mentions second secret', second.seq + 1, c.conversationId);
    await t.rewind(c.id, second.seq);
    expect(t.e.db.prepare('SELECT summary, summary_upto_seq FROM conversations WHERE id = ?').get(c.conversationId)).toEqual({ summary: null, summary_upto_seq: null });
    await t.say(c.id, 'third');
    await t.idle(c.id);
    const sent = JSON.stringify(t.fake.calls.at(-1)!.messages);
    expect(sent).toContain('third');
    expect(sent).not.toContain('second secret');
    expect(buildMessages).toBeTypeOf('function');
  });

  it('Stop during a running tool rewinds the turn: the command is killed, files restored, the text comes back', async () => {
    const t = await setup([write('echo changed > a.txt && sleep 20')]);
    writeFileSync(join(t.work, 'a.txt'), 'orig');
    const c = await t.chat();
    await t.say(c.id, 'change a.txt');
    await expect.poll(() => t.file('a.txt'), { timeout: 8000 }).toBe('changed\n');
    const r = (await t.rewind(c.id))!;
    expect(r).toMatchObject({ text: 'change a.txt', filesError: null });
    expect(t.e.runner.current(c.id)).toBeNull();
    expect(t.e.runner.runs(c.id)[0]).toMatchObject({ status: 'stopped', error: 'rewound by you' });
    expect(t.file('a.txt')).toBe('orig');
    expect(t.e.kanban.messages(c.id)).toEqual([]);
    // Nothing running: Stop/Esc rewinds nothing.
    expect(await t.rewind(c.id)).toBeNull();
  });

  it('Undo after a Stop/Esc rewind puts the agent back to work where it stopped', async () => {
    const t = await setup([write('sleep 20'), text('finished after undo')]);
    const c = await t.chat();
    await t.say(c.id, 'do the long thing');
    await expect.poll(() => t.e.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE status = 'running'").get(), { timeout: 8000 }).toEqual({ n: 1 });
    const r = (await t.rewind(c.id))!;
    expect(t.e.kanban.messages(c.id)).toEqual([]);
    const u = (await (await t.undo(r.id)).json()) as { resume: boolean };
    expect(u.resume).toBe(true);
    await expect
      .poll(() => t.e.kanban.messages(c.id).flatMap((m) => m.content).some((b) => b.type === 'text' && b.text === 'finished after undo'), { timeout: 8000 })
      .toBe(true);
  });

  it('Undo of « Rewind to here » on an answered chat does not start a run', async () => {
    const t = await setup([text('a1'), text('a2')]);
    const c = await t.chat();
    await t.say(c.id, 'first');
    await t.idle(c.id);
    const r = (await t.rewind(c.id, t.e.kanban.messages(c.id)[0]!.seq))!;
    const u = (await (await t.undo(r.id)).json()) as { resume: boolean };
    expect(u.resume).toBe(false);
    expect(t.fake.calls).toHaveLength(1);
  });

  it('the timeline (#66) lists failed runs (Retry answers again), the summary point and the rewind with Undo', async () => {
    const t = await setup([
      () => {
        throw new Error('boom');
      },
      text('answered'),
      write('echo x > a.txt'),
      text('wrote'),
    ]);
    const c = await t.chat();
    const timeline = async () => (await (await fetch(t.u + `/cards/${c.id}/timeline`)).json()) as Timeline;
    await t.say(c.id, 'hi');
    await t.idle(c.id);
    expect((await timeline()).runs).toMatchObject([{ status: 'failed', error: 'boom', next: null }]);
    expect((await fetch(t.u + `/cards/${c.id}/retry`, { method: 'POST' })).status).toBe(200);
    await expect.poll(() => t.e.kanban.messages(c.id).some((m) => m.content.some((b) => b.type === 'text' && b.text === 'answered')), { timeout: 8000 }).toBe(true);
    await t.idle(c.id);
    const tl = await timeline();
    expect(tl.runs).toHaveLength(1);
    expect(tl.runs[0]!.next).not.toBeNull();
    expect(tl.summary).toBeNull();
    const first = t.e.kanban.messages(c.id)[0]!;
    t.e.db.prepare('UPDATE conversations SET summary = ?, summary_upto_seq = ? WHERE id = ?').run('the summary', first.seq, c.conversationId);
    expect((await timeline()).summary).toEqual({ uptoSeq: first.seq, text: 'the summary' });

    await t.say(c.id, 'write');
    await t.idle(c.id);
    const second = t.e.kanban.messages(c.id).filter((m) => m.author === 'user').at(-1)!;
    const r = (await t.rewind(c.id, second.seq))!;
    expect((await timeline()).rewinds).toEqual([{ id: r.id, fromSeq: second.seq, at: expect.any(String), hidden: 3, files: [{ path: 'a.txt', change: 'deleted' }], filesError: null, effects: [], undoable: true }]);
    expect((await t.undo(r.id)).status).toBe(200);
    expect((await timeline()).rewinds).toEqual([]);
  });

  it('a work card goes back to its status at that point (an event records it); Undo puts the later status back', async () => {
    const t = await setup([text('ok'), [{ type: 'tool_use', id: 'r1', name: 'task_request_review', input: { summary: 'done' } }]]);
    const card = (await (await fetch(t.u + '/cards', { method: 'POST', headers: json, body: JSON.stringify({ title: 'T', assignee: null, status: 'triage' }) })).json()) as Card;
    t.e.kanban.update(card.id, { assignee: 'atlas', status: 'blocked' }, 'user');
    t.e.kanban.block(card.id, { kind: 'needs_input', reason: 'which one?' }, 'atlas');
    await t.say(card.id, 'the blue one');
    await t.idle(card.id);
    const seq = t.e.kanban.messages(card.id).find((m) => m.author === 'user')!.seq;
    await t.e.kanban.update(card.id, { status: 'review' }, 'atlas');
    const r = (await t.rewind(card.id, seq))!;
    expect(t.e.kanban.get(card.id)).toMatchObject({ status: 'blocked', block: { reason: 'which one?' } });
    expect(t.e.db.prepare("SELECT COUNT(*) AS n FROM card_events WHERE card_id = ? AND kind = 'rewound'").get(card.id)).toEqual({ n: 1 });
    await t.undo(r.id);
    expect(t.e.kanban.get(card.id).status).toBe('review');
  });

  it('a restart mid-rewind finishes restoring the files', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-rw-'));
    const dbFile = join(dataDir, 'k.db');
    let t = await setup([write('echo two > a.txt'), text('ok')], { dataDir, dbFile });
    writeFileSync(join(t.work, 'a.txt'), 'one');
    const c = await t.chat();
    await t.say(c.id, 'go');
    await t.idle(c.id);
    expect(t.file('a.txt')).toBe('two\n');
    const seq = t.e.kanban.messages(c.id)[0]!.seq;
    // Kill after the transaction, before the files: what rewind() commits first.
    const ch = t.e.db.prepare("SELECT * FROM file_changes WHERE card_id = ? AND path = 'a.txt'").get(c.id) as Record<string, string>;
    const ops = [{ workdir: t.work, path: 'a.txt', from: { sha: ch.after_sha, mode: ch.after_mode }, to: { sha: ch.before_sha, mode: ch.before_mode } }];
    t.e.db.transaction(() => {
      t.e.db
        .prepare("INSERT INTO rewinds (id, card_id, from_seq, upto_seq, workdir, ops, card_before, state, at) VALUES ('rw_x', ?, ?, ?, ?, ?, '{}', 'restoring', ?)")
        .run(c.id, seq, 99, t.work, JSON.stringify(ops), new Date().toISOString());
      t.e.db.prepare("UPDATE messages SET rewind_id = 'rw_x' WHERE conversation_id = ? AND seq >= ?").run(c.conversationId, seq);
    })();
    await t.e.stop();
    engine = undefined;
    t = await setup([], { dataDir, dbFile });
    expect(t.file('a.txt')).toBe('one');
    expect(t.e.db.prepare("SELECT state, files FROM rewinds WHERE id = 'rw_x'").get()).toEqual({ state: 'done', files: JSON.stringify([{ path: 'a.txt', change: 'restored' }]) });
    expect(t.e.kanban.messages(c.id)).toEqual([]);
  });

  // #68: a rewind wiped another card's work in the shared workdir.
  it('a rewind only puts back its own chat\'s files: another chat\'s new file and edit stay, and Undo too', async () => {
    const t = await setup([
      write('echo A > a.txt'), text('A done'),
      write('echo B > b.txt && echo B-edit > shared.txt'), text('B done'),
    ]);
    writeFileSync(join(t.work, 'shared.txt'), 'orig');
    const a = await t.chat();
    const b = await t.chat();
    await t.say(a.id, 'write a');
    await t.idle(a.id);
    await t.say(b.id, 'write b');
    await t.idle(b.id);
    const seq = t.e.kanban.messages(a.id)[0]!.seq;
    const r = (await t.rewind(a.id, seq))!;
    expect(r).toMatchObject({ filesError: null, files: [{ path: 'a.txt', change: 'deleted' }] });
    expect([t.file('a.txt'), t.file('b.txt'), t.file('shared.txt')]).toEqual([null, 'B\n', 'B-edit\n']);
    expect((await t.undo(r.id)).status).toBe(200);
    expect([t.file('a.txt'), t.file('b.txt'), t.file('shared.txt')]).toEqual(['A\n', 'B\n', 'B-edit\n']);
  });

  it('a file changed by both chats is a conflict: nothing is restored, the conflict is listed', async () => {
    const t = await setup([
      write('echo A > x.txt && echo A > mine.txt'), text('A done'),
      write('echo B > x.txt'), text('B done'),
    ]);
    const a = await t.chat();
    const b = await t.chat();
    await t.say(a.id, 'write');
    await t.idle(a.id);
    await t.say(b.id, 'write');
    await t.idle(b.id);
    const seq = t.e.kanban.messages(a.id)[0]!.seq;
    const preview = (await (await fetch(t.u + `/cards/${a.id}/rewind?seq=${seq}`)).json()) as RewindPreview;
    expect(preview.files).toEqual([]);
    expect(preview.filesError).toMatch(/files not restored.*x\.txt was also changed by the chat/);
    const r = (await t.rewind(a.id, seq))!;
    expect(r.files).toEqual([]);
    expect(r.filesError).toMatch(/x\.txt was also changed/);
    expect([t.file('x.txt'), t.file('mine.txt')]).toEqual(['B\n', 'A\n']);
    expect(t.e.kanban.messages(a.id)).toEqual([]); // the messages are still rewound
  });

  it('a file edited by hand since the chat changed it is a conflict too; Undo refuses to overwrite a later change', async () => {
    const t = await setup([write('echo A > x.txt'), text('A done'), write('echo A > y.txt'), text('done')]);
    const a = await t.chat();
    await t.say(a.id, 'write');
    await t.idle(a.id);
    writeFileSync(join(t.work, 'x.txt'), 'by hand');
    const seq = t.e.kanban.messages(a.id)[0]!.seq;
    const r = (await t.rewind(a.id, seq))!;
    expect(r.filesError).toMatch(/x\.txt was changed by something else since/);
    expect(t.file('x.txt')).toBe('by hand');

    const c = await t.chat();
    await t.say(c.id, 'write y');
    await t.idle(c.id);
    const r2 = (await t.rewind(c.id, t.e.kanban.messages(c.id)[0]!.seq))!;
    expect(r2.files).toEqual([{ path: 'y.txt', change: 'deleted' }]);
    writeFileSync(join(t.work, 'y.txt'), 'someone else');
    const u = await t.undo(r2.id);
    expect(u.status).toBe(409);
    expect(((await u.json()) as { error: string }).error).toMatch(/y\.txt changed since the rewind/);
    expect(t.file('y.txt')).toBe('someone else');
  });

  it('another chat\'s write during this chat\'s command is not taken for this chat\'s change', async () => {
    const t = await setup([
      write('sleep 1.5'),
      [{ type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'b.txt', content: 'B' } }],
      text('B done'),
      text('A done'),
    ]);
    const a = await t.chat();
    const b = await t.chat();
    await t.say(a.id, 'wait');
    await expect.poll(() => t.e.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE status = 'running'").get(), { timeout: 8000 }).toEqual({ n: 1 });
    await t.say(b.id, 'write b');
    await t.idle(b.id);
    await t.idle(a.id);
    // A's command saw b.txt appear; it was B's write.
    expect(t.e.db.prepare("SELECT COUNT(*) AS n FROM file_changes WHERE card_id = ? AND path = 'b.txt'").get(a.id)).toEqual({ n: 1 });
    const r = (await t.rewind(a.id, t.e.kanban.messages(a.id)[0]!.seq))!;
    expect(r).toMatchObject({ files: [], filesError: null });
    expect(t.file('b.txt')).toBe('B');
    // And B's rewind takes its own file back.
    const rb = (await t.rewind(b.id, t.e.kanban.messages(b.id)[0]!.seq))!;
    expect(rb).toMatchObject({ files: [{ path: 'b.txt', change: 'deleted' }], filesError: null });
    expect(t.file('b.txt')).toBeNull();
  });

  // #138: what the rewound part did outside the chat and its files.
  const call = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: 't' + Math.random().toString(36).slice(2, 8), name, input });
  it('lists every side effect of the rewound part; closes a task nobody started and Undo reopens it; what was acted on is kept', async () => {
    const t = await setup([
      [
        call('task_create', { title: 'Fresh task', status: 'todo' }),
        call('task_create', { title: 'Worked task', status: 'todo' }),
        call('memory_add', { kind: 'fact', text: 'the build lives in dist' }),
        call('schedule_create', { prompt: 'digest', title: 'Daily digest', cron: '0 9 * * *' }),
        call('canvas_create', { name: 'Sketch' }),
        ...write('echo git push origin main'),
      ],
      text('did things'),
      [call('task_message', { id: '1', text: 'not read yet' })],
      text('sent'),
    ]);
    const c = await t.chat();
    await t.say(c.id, 'do things');
    await t.idle(c.id);
    const fresh = t.e.kanban.list().find((k) => k.title === 'Fresh task')!;
    const worked = t.e.kanban.list().find((k) => k.title === 'Worked task')!;
    expect(fresh.number).toBe(1);
    await t.say(c.id, 'tell it');
    await t.idle(c.id);
    // Someone already worked on the second task: it can't be taken back.
    t.e.db.prepare("INSERT INTO runs (id, card_id, agent_id, status, started_at, ended_at) VALUES ('run_w', ?, 'atlas', 'done', ?, ?)").run(worked.id, new Date().toISOString(), new Date().toISOString());
    const first = t.e.kanban.messages(c.id)[0]!;

    const preview = (await (await fetch(t.u + `/cards/${c.id}/rewind?seq=${first.seq}`)).json()) as RewindPreview;
    expect(preview.effects.map((e) => [e.kind, e.outcome, e.action])).toEqual([
      ['task', 'undone', 'closed'],
      ['task', 'kept', 'stays'],
      ['memory', 'undone', 'archived'],
      ['schedule', 'undone', 'turned off'],
      ['canvas', 'kept', 'stays'],
      ['push', 'kept', 'stays'],
      ['message', 'undone', 'withdrawn'],
    ]);
    expect(preview.effects[0]).toMatchObject({ label: '#1 Fresh task', cardId: fresh.id });
    expect(preview.effects[1]).toMatchObject({ why: '@atlas already worked on it' });
    // The preview changes nothing.
    expect(t.e.kanban.get(fresh.id).status).toBe('todo');

    const r = (await t.rewind(c.id, first.seq))!;
    expect(r.effects).toEqual(preview.effects);
    const memory = t.e.db.prepare("SELECT id, status FROM memories WHERE text = 'the build lives in dist'").get() as { id: number; status: string };
    const sched = () => (t.e.db.prepare("SELECT enabled FROM schedules WHERE title = 'Daily digest'").get() as { enabled: number }).enabled;
    expect([t.e.kanban.get(fresh.id).status, t.e.kanban.get(worked.id).status, memory.status, sched()]).toEqual(['closed', 'todo', 'archived', 0]);
    expect(t.e.kanban.messages(fresh.id).some((m) => m.content.some((b) => b.type === 'text' && b.text.includes('not read yet')))).toBe(false);
    const tl = (await (await fetch(t.u + `/cards/${c.id}/timeline`)).json()) as Timeline;
    expect(tl.rewinds[0]!.effects).toEqual(preview.effects);

    expect((await t.undo(r.id)).status).toBe(200);
    const mem2 = t.e.db.prepare('SELECT status FROM memories WHERE id = ?').get(memory.id) as { status: string };
    expect([t.e.kanban.get(fresh.id).status, mem2.status, sched()]).toEqual(['todo', 'active', 1]);
    expect(t.e.kanban.messages(fresh.id).some((m) => m.content.some((b) => b.type === 'text' && b.text.includes('not read yet')))).toBe(true);
    // A rewind again lists them again (the records are free once undone).
    const again = (await (await fetch(t.u + `/cards/${c.id}/rewind?seq=${first.seq}`)).json()) as RewindPreview;
    expect(again.effects).toHaveLength(7);
  });

  it('a restart after a rewind keeps what it did; Undo still brings it back (one transaction, rule 2)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-rw-'));
    const dbFile = join(dataDir, 'k.db');
    let t = await setup([[call('task_create', { title: 'Fresh task', status: 'todo' })], text('made')], { dataDir, dbFile });
    const c = await t.chat();
    await t.say(c.id, 'make');
    await t.idle(c.id);
    const fresh = t.e.kanban.list().find((k) => k.title === 'Fresh task')!;
    const r = (await t.rewind(c.id, t.e.kanban.messages(c.id)[0]!.seq))!;
    expect(t.e.kanban.get(fresh.id).status).toBe('closed');
    await t.e.stop();
    engine = undefined;
    t = await setup([], { dataDir, dbFile });
    expect(t.e.kanban.get(fresh.id).status).toBe('closed');
    expect(((await (await fetch(t.u + `/cards/${c.id}/timeline`)).json()) as Timeline).rewinds[0]).toMatchObject({ undoable: true, effects: [{ kind: 'task', outcome: 'undone' }] });
    expect((await t.undo(r.id)).status).toBe(200);
    expect(t.e.kanban.get(fresh.id).status).toBe('todo');
  });

  it('two rewinds in a row are one row in the chat, and its Undo undoes both', async () => {
    const t = await setup([write('echo one > a.txt'), text('one'), [call('task_create', { title: 'T', status: 'todo' })], text('two')]);
    const c = await t.chat();
    await t.say(c.id, 'first');
    await t.idle(c.id);
    await t.say(c.id, 'second');
    await t.idle(c.id);
    const [m1, m2] = t.e.kanban.messages(c.id).filter((m) => m.author === 'user');
    const r2 = (await t.rewind(c.id, m2!.seq))!;
    const r1 = (await t.rewind(c.id, m1!.seq))!;
    const tl = (await (await fetch(t.u + `/cards/${c.id}/timeline`)).json()) as Timeline;
    expect(tl.rewinds).toHaveLength(1);
    expect(tl.rewinds[0]).toMatchObject({ id: r1.id, fromSeq: m1!.seq, hidden: 6, undoable: true, files: [{ path: 'a.txt', change: 'deleted' }], effects: [{ kind: 'task', action: 'closed' }] });
    expect(r2.effects).toHaveLength(1);
    expect((await t.undo(r1.id)).status).toBe(200);
    expect(userTexts(t.e.kanban.messages(c.id))).toEqual(['first', 'second']);
    expect(t.file('a.txt')).toBe('one\n');
    expect(t.e.kanban.list().find((k) => k.title === 'T')!.status).toBe('todo');
    expect((await (await fetch(t.u + `/cards/${c.id}/timeline`)).json() as Timeline).rewinds).toEqual([]);
  });
});
