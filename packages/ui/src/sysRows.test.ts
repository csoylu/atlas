import { describe, expect, it } from 'vitest';
import { RESUME_KICK, TRIAGE_KICK, WORK_KICK, type EndedRun, type Message, type RewindEvent } from '@atlas/shared';
import { distribute, messageRow, rewindRow, runRow, summaryRow, timelineRows } from './sysRows.ts';
import { REWOUND } from './rewindText.ts';
import { badInput, toolRow } from './toolRows.ts';

let seq = 0;
const msg = (role: Message['role'], author: string, text: string, at = '2026-11-14T10:00:00.000Z'): Message => ({
  id: 'm' + ++seq, conversationId: 'c', seq, role, author, content: [{ type: 'text', text }], at,
});
const run = (p: Partial<EndedRun>): EndedRun => ({
  id: 'r1', cardId: 'c', agentId: 'atlas', kind: 'work', status: 'failed', error: null, startedAt: '2026-11-14T10:00:00.000Z', endedAt: '2026-11-14T10:05:00.000Z', next: null, ...p,
});
const hm = (iso: string) => iso.slice(11, 16);

// The exact texts the engine writes (dispatcher.ts kicks, teamTools.ts card_message, schedules.ts).
describe('messageRow', () => {
  it('start prompts become « Started » rows', () => {
    expect(messageRow(msg('user', 'system', WORK_KICK), 'atlas')).toMatchObject({ icon: 'play', verb: 'Started', object: 'card assigned to @atlas', rest: `“${WORK_KICK}”` });
    expect(messageRow(msg('user', 'system', TRIAGE_KICK), null)).toMatchObject({ verb: 'Started triage' });
    expect(messageRow(msg('user', 'system', RESUME_KICK), 'atlas')).toMatchObject({ verb: 'Resumed', object: 'after a restart' });
  });

  it('a card’s message: « Message from #N », its first line, the full text in the body', () => {
    const r = messageRow(msg('user', 'atlas', '[from @atlas, card #58] The **reusable** row is in.\n\nDetails here.'), 'atlas')!;
    expect(r).toMatchObject({ icon: 'msg', tone: 'acc', verb: 'Message from', ref: '#58', object: '@atlas', rest: 'The reusable row is in.' });
    expect(r.body).toEqual({ kind: 'markdown', text: 'The **reusable** row is in.\n\nDetails here.' });
    expect(messageRow(msg('user', 'scout', '[from @scout, card c_0a1b2c3d] hi'), null)).toMatchObject({ ref: 'c_0a1b2c3d', object: '@scout' });
  });

  it('a scheduled run: the prompt, and when', () => {
    const r = messageRow(msg('user', 'schedule', 'Check the funding rates.\nThen report.\n\n— from schedule sch_1a2b3c4d, every weekday at 09:00 (Europe/Paris), run by hand.'), 'atlas')!;
    expect(r).toMatchObject({ icon: 'clock', verb: 'Scheduled run', object: 'Check the funding rates.', rest: 'every weekday at 09:00 (Europe/Paris), run by hand' });
    expect(r.body).toEqual({ kind: 'markdown', text: 'Check the funding rates.\nThen report.' });
  });

  it('leaves the user’s messages, card reports and other notes alone', () => {
    expect(messageRow(msg('user', 'user', WORK_KICK), 'atlas')).toBeNull();
    expect(messageRow(msg('user', 'system', '✓ Card “X” (#5) finished: ok'), 'atlas')).toBeNull();
    expect(messageRow(msg('user', 'atlas', 'no prefix'), 'atlas')).toBeNull();
    expect(messageRow(msg('assistant', 'atlas', '[from @atlas, card #1] x'), 'atlas')).toBeNull();
  });
});

describe('runRow', () => {
  it('stopped by you; a rewind’s stop says nothing (its row does)', () => {
    expect(runRow(run({ status: 'stopped', error: 'stopped by you' }), true, hm)).toMatchObject({ icon: 'stop', tone: 'warn', verb: 'Stopped by you', at: '2026-11-14T10:05:00.000Z' });
    expect(runRow(run({ status: 'stopped', error: 'card closed' }), true, hm)).toMatchObject({ verb: 'Stopped', rest: 'card closed' });
    expect(runRow(run({ status: 'stopped', error: REWOUND }), true, hm)).toBeNull();
  });

  it('failed: the error, opened with Retry only on the latest run', () => {
    const r = runRow(run({ error: 'Expected \',\' in JSON at position 460\nmore' }), true, hm)!;
    expect(r).toMatchObject({ icon: 'alert', tone: 'bad', verb: 'Run failed', rest: 'Expected \',\' in JSON at position 460', open: true });
    expect(r.body).toEqual({ kind: 'error', text: 'Expected \',\' in JSON at position 460\nmore', retry: true, agent: 'atlas' });
    expect(runRow(run({ error: 'x' }), false, hm)).toMatchObject({ open: false, body: { retry: false } });
  });

  it('interrupted, and when it resumed', () => {
    expect(runRow(run({ status: 'interrupted', error: 'engine shutting down', next: '2026-11-14T18:04:00.000Z' }), false, hm)).toMatchObject({ verb: 'Interrupted', rest: 'engine shut down · resumed at 18:04' });
    expect(runRow(run({ status: 'interrupted', error: 'engine stopped during the run' }), false, hm)).toMatchObject({ rest: 'engine stopped' });
  });
});

describe('rewindRow and summaryRow', () => {
  const rw = (p: Partial<RewindEvent>): RewindEvent => ({ id: 'rw_1', fromSeq: 5, at: '2026-11-14T18:23:00.000Z', hidden: 13, files: [], filesError: null, undoable: false, ...p });
  it('says what was hidden and put back; Undo while it works', () => {
    const files = [{ path: 'a.ts', change: 'restored' as const }, { path: 'b.ts', change: 'deleted' as const }];
    expect(rewindRow(rw({ files, undoable: true }))).toMatchObject({ icon: 'rewind', tone: 'warn', verb: 'Rewound by you', object: '13 messages hidden', rest: '2 files put back', body: { kind: 'files', files, undoId: 'rw_1' } });
    expect(rewindRow(rw({ hidden: 1 }))).toMatchObject({ object: '1 message hidden', rest: 'no files changed', body: undefined });
    expect(rewindRow(rw({ files: null }))).toMatchObject({ rest: 'putting files back…' });
    expect(rewindRow(rw({ filesError: 'files not restored: no snapshot' }))).toMatchObject({ rest: 'files not restored', body: { error: 'files not restored: no snapshot', undoId: null } });
  });
  it('the summary point', () => {
    expect(summaryRow({ uptoSeq: 9, text: 'S' }, 142)).toMatchObject({ icon: 'compress', verb: 'Earlier messages summarized', meta: '142 messages → 1 summary', body: { kind: 'markdown', text: 'S' } });
  });
});

describe('timelineRows + distribute', () => {
  it('places each row after the group it follows', () => {
    seq = 0;
    const ms = [
      msg('user', 'user', 'a', '2026-11-14T10:00:00.000Z'), // 1
      msg('assistant', 'atlas', 'b', '2026-11-14T10:01:00.000Z'), // 2
      msg('user', 'tool', 'c', '2026-11-14T10:02:00.000Z'), // 3 (not shown, but still counts for placement)
      msg('user', 'user', 'd', '2026-11-14T10:10:00.000Z'), // 4
      msg('assistant', 'atlas', 'e', '2026-11-14T10:11:00.000Z'), // 5
    ];
    const placed = timelineRows(
      {
        runs: [run({ id: 'r1', endedAt: '2026-11-14T10:03:00.000Z' }), run({ id: 'r2', status: 'stopped', error: 'stopped by you', endedAt: '2026-11-14T10:12:00.000Z' })],
        rewinds: [{ id: 'rw', fromSeq: 4, at: '2026-11-14T10:20:00.000Z', hidden: 2, files: [], filesError: null, undoable: false }],
        summary: { uptoSeq: 2, text: 'S' },
      },
      ms,
      { latestRunId: 'r2', running: false, hhmm: hm },
    );
    expect(placed.map((p) => [p.row.key, p.after])).toEqual([['summary', 2], ['r1', 3], ['rw', 3], ['r2', 5]]);
    expect(placed[0]!.row.meta).toBe('2 messages → 1 summary');
    // Groups shown: [1], [2], [4], [5] (tool results are not).
    const d = distribute([1, 2, 4, 5], placed);
    expect(d.before).toEqual([]);
    expect(d.after.map((rs) => rs.map((r) => r.key))).toEqual([[], ['summary', 'r1', 'rw'], [], ['r2']]);
    expect(distribute([3], [{ row: placed[0]!.row, after: 1 }]).before).toHaveLength(1);
  });
});

describe('malformed tool input (#55)', () => {
  it('« Couldn’t call grep », the zod issue in plain words', () => {
    const err = 'invalid input for grep: ' + JSON.stringify([{ origin: 'number', code: 'too_big', maximum: 20, path: ['context'], message: 'Too big: expected number to be <=20' }]);
    expect(badInput('grep', err)).toBe('invalid input: context: Too big: expected number to be <=20');
    expect(badInput('grep', 'Your arguments were not valid JSON (Unexpected token). Call the tool again.')).toBe('arguments weren’t valid JSON');
    expect(badInput('grep', 'no matches')).toBeNull();
    const row = toolRow('grep', { pattern: 'x', context: 30 }, { content: err, isError: true });
    expect(row).toMatchObject({ icon: 'x', tone: 'bad', verb: 'Couldn’t call', object: 'grep', mono: true, rest: 'invalid input: context: Too big: expected number to be <=20, sent back to the model' });
  });
});
