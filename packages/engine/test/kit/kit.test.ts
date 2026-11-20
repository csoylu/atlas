import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { eventually, launch, pgrepPids, pgrepWorks, retry, until } from './index.ts';

describe('test kit', () => {
  it('eventually: waits for a condition, returns its value, names what it waited for on timeout', async () => {
    let n = 0;
    expect(await eventually(() => ++n >= 3 && 'ok')).toBe('ok');
    await expect(eventually(() => false, { timeout: 60, what: 'a thing that never happens' })).rejects.toThrow(/timed out after 60 ms waiting for a thing that never happens/);
  });
  it('eventually: an assertion that throws is retried; the last error is in the message', async () => {
    let n = 0;
    await eventually(() => expect(++n).toBeGreaterThan(2));
    await expect(eventually(() => expect(1).toBe(2), { timeout: 40 })).rejects.toThrow(/expected 1 to be 2/);
  });
  it('pgrepPids: a live process by its pattern, [] once it is gone; skipped where pgrep cannot list (#322)', async (ctx) => {
    if (!pgrepWorks()) return ctx.skip('pgrep cannot list processes here (Mac sandbox)');
    const mark = `kit-pgrep-${process.pid}-${Date.now()}`;
    const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)', mark], { stdio: 'ignore' });
    await eventually(() => pgrepPids(mark).includes(p.pid!), { what: 'pgrep to see the sleeper' });
    p.kill('SIGKILL');
    await eventually(() => expect(pgrepPids(mark)).toEqual([]), { what: 'the sleeper gone' });
  });
  it('until: the boolean shape', async () => {
    const t = Date.now() + 30;
    await until(() => Date.now() > t, 'the clock');
  });
  it('retry: runs again on a throw, only for errors retryIf accepts, then gives up', async () => {
    let n = 0;
    expect(await retry((a) => { n++; if (a < 3) throw new Error('flaky'); return a; }, { delayMs: 1 })).toBe(3);
    await expect(retry(() => { throw new Error('nope'); }, { times: 2, delayMs: 1 })).rejects.toThrow('nope');
    let m = 0;
    await expect(retry(() => { m++; throw new Error('fatal'); }, { retryIf: (e) => !/fatal/.test(String(e)) })).rejects.toThrow('fatal');
    expect(m).toBe(1);
  });
  it('launch: an engine with an injected model, a chat, a run, cleanup by itself', async () => {
    const t = await launch({ script: [[{ type: 'text', text: 'hello back' }]] });
    const c = await t.chat();
    await t.say(c.id, 'hi');
    await t.idle(c.id);
    expect(t.fake.calls).toHaveLength(1);
    const msgs = (await t.call<{ author: string }[]>('GET', `/cards/${c.id}/messages`)).body;
    expect(msgs.map((m) => m.author)).toContain('user');
  });
});
