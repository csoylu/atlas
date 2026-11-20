import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock, ServerEvent } from '@atlas/shared';
import { eventually, launch } from '../test/kit/index.ts';
import type { ModelRequest } from './providers/types.ts';
import { PAGE_BYTES } from './background.ts';
import { redactWindow, type SecretStore } from './secrets.ts';

/**
 * #227: output that is cut (shell's last 30000 chars, the live tail's last 8000, a page of a background log, the tail
 * in a background exit note, a long line of read_file or grep) is redacted first and cut second, so a value crossing
 * the cut never shows a piece of itself. A value split across two stream chunks is hidden too.
 */

class MemoryStore implements SecretStore {
  label = 'test store';
  map = new Map<string, string>();
  names = () => [...this.map.keys()];
  get = (n: string) => this.map.get(n);
  set = (n: string, v: string) => void this.map.set(n, v);
  delete = (n: string) => void this.map.delete(n);
}

const V = 'c-value-abcdefghij'; // 18 chars
const HEAD = V.slice(0, 7); // what a cut 7 chars into the value would leave of its start…
const TAIL = V.slice(7); // …and of its end
const MARK = '[secret S_C]';
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const tool = (id: string, name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id, name, input }];
const sh = (id: string, command: string, background = false) => tool(id, 'shell', { command, background });
/** `n` times the character `c` on stdout, no newline. */
const chars = (n: number, c: string) => `head -c ${n} /dev/zero | tr "\\0" ${c}`;
const results = (req: ModelRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));

async function setup(script: ConstructorParameters<typeof import('./providers/fake.ts').FakeProvider>[0]) {
  const l = await launch({ script, secrets: new MemoryStore(), dispatch: false, env: {} });
  expect((await l.call('POST', '/secrets', { name: 'S_C', value: V, grant: 'all', agents: [], description: '' })).status).toBe(201);
  const events: ServerEvent[] = [];
  l.engine.bus.on((e) => events.push(e));
  const tails = () => events.flatMap((e) => (e.type === 'toolcall.updated' && e.call.tail !== undefined ? [e.call.tail] : []));
  return { ...l, events, tails };
}

async function run(l: Awaited<ReturnType<typeof setup>>) {
  const card = l.engine.kanban.create({ title: 'cut', assignee: 'atlas' }, 'user');
  l.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
  l.engine.runner.wake(card.id);
  await l.engine.runner.settled(card.id);
  return card;
}

/** No piece of the value anywhere: what the model got, the stored transcript and tool calls, the events (the WebSocket). */
function nowhere(l: Awaited<ReturnType<typeof setup>>) {
  const stored = JSON.stringify(l.engine.db.prepare('SELECT content FROM messages').all()) + JSON.stringify(l.engine.db.prepare('SELECT output FROM tool_calls').all());
  const sinks = { stored, model: JSON.stringify(l.fake.calls), events: JSON.stringify(l.events) };
  for (const [where, s] of Object.entries(sinks)) for (const piece of [HEAD, TAIL]) expect(s.includes(piece), `${piece} in ${where}`).toBe(false);
}

describe('redactWindow', () => {
  const vals = [{ name: 'S_C', value: V }];
  const w = (t: string, s: number, e: number, o = {}) => redactWindow(vals, t, s, e, o);

  it('a value crossing either edge of the window is hidden whole', () => {
    const t = `aaaa${V}bbbb${V}cccc`; // values at 4..22 and 26..44
    expect(w(t, 11, 30)).toEqual({ text: `${MARK}bbbb${MARK}`, hidden: 2, dropped: 0 });
    expect(w(t, 0, t.length)).toEqual({ text: `aaaa${MARK}bbbb${MARK}cccc`, hidden: 2, dropped: 0 });
    expect(w(t, 0, 3).text).toBe('aaa');
  });

  it('cutStart: a value whose tail opens the text is hidden; open: a possible start at the end is left out', () => {
    expect(w(`${TAIL}xyz`, 0, 14, { cutStart: true })).toEqual({ text: `${MARK}xyz`, hidden: 1, dropped: 0 });
    expect(w(`${TAIL}xyz`, 0, 14).text).toBe(`${TAIL}xyz`); // not cut: it is not a value
    expect(w(`xyz${HEAD}`, 0, 10, { open: true })).toEqual({ text: 'xyz', hidden: 0, dropped: 7 });
    expect(w(`xyz${V}`, 0, 21, { open: true })).toEqual({ text: `xyz${MARK}`, hidden: 1, dropped: 0 });
  });
});

describe('cut output is redacted before it is cut (#227)', () => {
  it('shell: a value across the 30000-character cut; read_file and grep: a value across a long line\'s cut', async () => {
    const l = await setup([
      sh('t1', `${chars(100, 'x')}; printf %s "$S_C"; ${chars(30000 - V.length + 7, 'z')}`),
      tool('t2', 'read_file', { path: 'long.txt' }),
      tool('t3', 'grep', { pattern: 'q', path: 'long2.txt' }),
      text('done'),
    ]);
    writeFileSync(join(l.workdir, 'long.txt'), `${'x'.repeat(5000 - 15)}${V}${'y'.repeat(10)}\n`);
    writeFileSync(join(l.workdir, 'long2.txt'), `${'q'.repeat(500 - 'long2.txt:1:'.length - 15)}${V}${'q'.repeat(50)}\n`);
    const card = await run(l);
    const [shell] = results(l.fake.calls[1]!);
    expect(shell).toMatch(/showing the last 30000/);
    expect(shell).toContain('secret S_C]'); // the marker itself may be cut: harmless
    const saved = shell!.match(/the full output is in (.+?) \(/)![1]!;
    expect(readFileSync(saved, 'utf8')).toContain(`x${MARK}z`);
    expect(results(l.fake.calls[2]!)[0]).toContain(`x${MARK}y`);
    expect(results(l.fake.calls[3]!)[0]).toContain(MARK);
    nowhere(l);
    expect(l.engine.runner.toolCalls(card.id).map((c) => c.secretsHidden ?? 0)).toEqual([1, 1, 1]);
  });

  it('live tail: a value across the 8000-character cut of the tail sent to the chat', async () => {
    const l = await setup([sh('t1', `${chars(20000, 'x')}; printf %s "$S_C"; ${chars(8000 - V.length + 7, 'z')}; sleep 1`), text('done')]);
    await run(l);
    const tails = l.tails();
    expect(tails.length).toBeGreaterThan(0);
    expect(tails.some((t) => t.includes('z'))).toBe(true);
    for (const t of tails) if (t.includes('z')) expect(t.startsWith(MARK)).toBe(true);
    nowhere(l);
  });

  it('live tail: a value split across two chunks is never shown in part', async () => {
    const l = await setup([
      // The first chunk ends inside the value; the second (a second later) completes it.
      sh('t1', `printf "start "; printf %s "$S_C" | head -c 9; sleep 1; printf %s "$S_C" | tail -c +10; printf " end"; sleep 1`),
      text('done'),
    ]);
    await run(l);
    const tails = l.tails();
    expect(tails).toContain('start '); // the first chunk, its possible value start left out
    expect(tails).toContain(`start ${MARK} end`);
    expect(results(l.fake.calls[1]!)[0]).toBe(`exit 0\nstart ${MARK} end`);
    nowhere(l);
  });

  it("secret_set: a failing command's stderr, cut to its last 600 characters, a value across that cut", async () => {
    const l = await setup([tool('t1', 'secret_set', { name: 'NEW_KEY', command: `printf %s "$S_C" >&2; ${chars(600 - V.length + 7, 'z')} >&2; exit 3` }), text('done')]);
    await run(l);
    const [r] = results(l.fake.calls[1]!);
    expect(r).toMatch(/exited with 3: nothing stored\nstderr: \[secret S_C\]z+$/);
    nowhere(l);
  });

  it('background: a value across the edge of a shell_output page, one still being written, and in the exit note', async () => {
    const l = await setup([sh('t1', `${chars(2000 - V.length + 7, 'y')} >&2; printf %s "$S_C"; ${chars(2000 - V.length + 7, 'z')}`, true), text('started'), text('noted'), text('noted'), text('noted')]);
    const reg = l.engine.runner.background;
    const env = { ...process.env, S_C: V };
    const own = l.engine.kanban.create({ title: 'bg', assignee: null }, 'user');
    const base = { cwd: l.workdir, logDir: join(l.dataDir, 'outputs', 'atlas'), agentId: 'atlas', cardId: own.id, env };
    // Page edge: the value starts 7 bytes before the end of the first page.
    const a = reg.start({ ...base, command: `${chars(PAGE_BYTES - 7, 'x')}; printf %s "$S_C"; echo` });
    await eventually(() => expect(reg.get(a.id)!.status).not.toBe('running'), { timeout: 5000, what: 'the first process to end' });
    const p1 = reg.read(a.id, 'atlas', undefined, l.engine.secrets);
    const p2 = reg.read(a.id, 'atlas', undefined, l.engine.secrets);
    expect(p1.endsWith(`x${MARK}\n[output bytes 0–${PAGE_BYTES} of ${PAGE_BYTES - 7 + V.length + 1}; shell_output(id, offset=${PAGE_BYTES}) for more]`)).toBe(true);
    expect(p2).toContain(`]\n${MARK}\n`);
    // Still running, its value half written: that half is not shown (nor skipped: the next read shows the marker).
    const b = reg.start({ ...base, command: `printf "go "; printf %s "$S_C" | head -c 9; while [ ! -f "${join(l.workdir, 'go')}" ]; do sleep 0.05; done; printf %s "$S_C" | tail -c +10` });
    await eventually(() => expect(reg.read(b.id, 'atlas', 0)).toContain(HEAD), { timeout: 5000, what: 'the half value in the log' });
    const half = reg.read(b.id, 'atlas', 0, l.engine.secrets);
    expect(half).toContain('\n[output bytes 0–3 of 12]\ngo \n[output bytes 0–3 of 12; shell_output(id, offset=3) for more]');
    writeFileSync(join(l.workdir, 'go'), '');
    await eventually(() => expect(reg.get(b.id)!.status).not.toBe('running'), { timeout: 5000, what: 'the second process to end' });
    expect(reg.read(b.id, 'atlas', undefined, l.engine.secrets)).toMatch(new RegExp(`\\]\\n${MARK.replace(/[[\]]/g, '\\$&')}$`));
    for (const r of [p1, p2, half]) for (const piece of [HEAD, TAIL]) expect(r).not.toContain(piece);

    // Exit note: the last 2000 bytes of the log, the value starting 7 bytes before them.
    const card = await run(l);
    await eventually(
      () => expect(JSON.stringify(l.engine.db.prepare("SELECT content FROM messages WHERE author = 'system'").all())).toContain('Background process'),
      { timeout: 5000, what: 'the exit note' },
    );
    const note = JSON.stringify(l.engine.db.prepare("SELECT content FROM messages WHERE author = 'system'").all());
    expect(note).toContain(`${MARK}zzz`);
    await l.engine.runner.settled(card.id);
    nowhere(l);
  });
});
