import { describe, expect, it } from 'vitest';
import { ansi, bgLog, bgOutput, diffCount, diffLines, editDiff, fileList, grepGroups, hunks, markMatches, parseNumbered, plainText, shellOutput } from './fileRows.ts';

/** Apply a diff's new side / old side back: both must give the inputs (the diff is complete and ordered). */
const sides = (ls: ReturnType<typeof diffLines>) => ({
  a: ls.filter((l) => l.t !== '+').map((l) => l.text),
  b: ls.filter((l) => l.t !== '-').map((l) => l.text),
});

const lcs = (a: string[], b: string[]) => {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) t[i]![j] = a[i - 1] === b[j - 1] ? t[i - 1]![j - 1]! + 1 : Math.max(t[i - 1]![j]!, t[i]![j - 1]!);
  return t[a.length]![b.length]!;
};

describe('diffLines', () => {
  it('finds the changed lines with numbers on each side', () => {
    const d = diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
    expect(d).toEqual([
      { t: ' ', text: 'a', old: 1, new: 1 },
      { t: '-', text: 'b', old: 2 },
      { t: '+', text: 'B', new: 2 },
      { t: ' ', text: 'c', old: 3, new: 3 },
      { t: ' ', text: 'd', old: 4, new: 4 },
      { t: '+', text: 'e', new: 5 },
    ]);
    expect(diffCount(d)).toEqual({ add: 2, del: 1 });
  });

  it('is a shortest edit script, and round-trips on random inputs', () => {
    expect(diffCount(diffLines('x\na\nb\nc', 'a\nb\nc\nx'))).toEqual({ add: 1, del: 1 });
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 200; i++) {
      const gen = () => Array.from({ length: Math.floor(rnd() * 12) }, () => 'abcd'[Math.floor(rnd() * 4)]).join('\n');
      const a = gen();
      const b = gen();
      const d = diffLines(a, b);
      const s = sides(d);
      expect(s.a.join('\n')).toBe(a.replace(/\n$/, ''));
      expect(s.b.join('\n')).toBe(b.replace(/\n$/, ''));
      const { add, del } = diffCount(d);
      expect(add + del).toBe(s.a.length + s.b.length - 2 * lcs(s.a, s.b));
    }
  });

  it('handles empty sides', () => {
    expect(diffLines('', 'x\ny')).toEqual([
      { t: '+', text: 'x', new: 1 },
      { t: '+', text: 'y', new: 2 },
    ]);
    expect(diffCount(diffLines('x', ''))).toEqual({ add: 0, del: 1 });
    expect(diffLines('', '')).toEqual([]);
  });

  it('hunks keep 3 lines of context and number each header', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n');
    const b = a.replace('l5', 'L5').replace('l25', 'L25');
    const h = hunks(diffLines(a, b));
    const heads = h.filter((x) => x.t === '@').map((x) => x.text);
    expect(heads).toEqual(['@@ -2,7 +2,7 @@', '@@ -22,7 +22,7 @@']);
    expect(h).toHaveLength(2 + 2 * 8);
  });
});

describe('editDiff', () => {
  it('numbers from the line where the edit landed', () => {
    expect(editDiff('a\nb', 'a\nB\nC', 12)).toEqual([
      { t: ' ', text: 'a', old: 12, new: 12 },
      { t: '-', text: 'b', old: 13 },
      { t: '+', text: 'B', new: 13 },
      { t: '+', text: 'C', new: 14 },
    ]);
  });
  it('has no numbers without the engine detail', () => {
    expect(editDiff('a', 'b')).toEqual([
      { t: '-', text: 'a' },
      { t: '+', text: 'b' },
    ]);
  });
});

describe('outputs', () => {
  it('parseNumbered reads read_file pages and the footer', () => {
    expect(parseNumbered(' 9|foo\n10|  bar|baz\n\n[showing lines 9–10 of 40; use offset=11 to continue]')).toEqual({
      lines: [
        { n: 9, text: 'foo' },
        { n: 10, text: '  bar|baz' },
      ],
      note: 'showing lines 9–10 of 40; use offset=11 to continue',
    });
  });

  it('grepGroups groups content matches and context by file', () => {
    const out = 'src/a-1.ts-3-before\nsrc/a-1.ts:4:hit one\nsrc/a-1.ts-5-after\n--\nsrc/b.ts:10:hit two\n[12 more not shown; narrow the search or raise limit]';
    expect(grepGroups(out)).toEqual({
      files: [
        {
          path: 'src/a-1.ts',
          lines: [
            { n: 3, text: 'before', ctx: true },
            { n: 4, text: 'hit one' },
            { n: 5, text: 'after', ctx: true },
          ],
        },
        { path: 'src/b.ts', lines: [{ n: 10, text: 'hit two' }] },
      ],
      note: '12 more not shown; narrow the search or raise limit',
    });
    expect(grepGroups('no matches').files).toEqual([]);
    expect(grepGroups('a.ts\nb.ts', 'files').files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
    expect(grepGroups('a.ts:3\nb.ts:1', 'count').files).toEqual([
      { path: 'a.ts', lines: [{ text: '', count: 3 }] },
      { path: 'b.ts', lines: [{ text: '', count: 1 }] },
    ]);
  });

  it('markMatches marks every hit, and leaves a bad regex unmarked', () => {
    expect(markMatches('.sys-note.open .sys-note', 'sys-note')).toEqual(['.', { hit: 'sys-note' }, '.open .', { hit: 'sys-note' }]);
    expect(markMatches('Foo foo', 'foo', true)).toEqual([{ hit: 'Foo' }, ' ', { hit: 'foo' }]);
    expect(markMatches('a(b', '(?<x')).toEqual(['a(b']);
    expect(markMatches('abc', 'x*')).toEqual(['abc']);
  });

  it('fileList drops footers and empty markers', () => {
    expect(fileList('a/\na/b.ts\n[3 more]')).toEqual({ paths: ['a/', 'a/b.ts'], note: '3 more' });
    expect(fileList('(empty)').paths).toEqual([]);
  });

  it('shellOutput splits the exit head, the cap note and the text', () => {
    expect(shellOutput('exit 0\nok\n')).toEqual({ exit: '0', killed: undefined, note: undefined, text: 'ok\n' });
    expect(shellOutput('exit SIGKILL (killed after 120s)\n[output is 40000 chars: showing the last 30000; the full output is in /x.log (read_file with offset, or grep it)]\ntail')).toEqual({
      exit: 'SIGKILL',
      killed: 'killed after 120s',
      note: 'output is 40000 chars: showing the last 30000; the full output is in /x.log (read_file with offset, or grep it)',
      text: 'tail',
    });
  });

  it('bgOutput and bgLog read background process outputs', () => {
    expect(bgOutput('bg_831f7700: running (pid 4, since x)\n[output bytes 0–12 of 12]\nVITE ready\n')).toEqual({ head: 'bg_831f7700: running (pid 4, since x)', text: 'VITE ready\n', note: undefined });
    expect(bgOutput('bg_1: exited with code 0\n(no new output; 264 bytes in total)')).toEqual({ head: 'bg_1: exited with code 0', text: '', note: 'no new output; 264 bytes in total' });
    expect(bgLog('started bg_1 in the background (pid 9); its output goes to /o/bg_1.log. shell_output(…)')).toBe('/o/bg_1.log');
  });
});

describe('ansi', () => {
  it('turns SGR codes into classes and drops other escapes', () => {
    expect(ansi('\x1b[32m✓\x1b[39m ok \x1b[1;31mFAIL\x1b[0m end')).toEqual([
      { text: '✓', cls: 'ansi-green' },
      { text: ' ok ' },
      { text: 'FAIL', cls: 'ansi-red ansi-bold' },
      { text: ' end' },
    ]);
    expect(ansi('\x1b[2K\x1b[1Gdone\x1b[90m (2s)\x1b[m')).toEqual([{ text: 'done' }, { text: ' (2s)', cls: 'ansi-bright-black' }]);
    expect(ansi('\x1b[38;5;208morange\x1b[0m')).toEqual([{ text: 'orange' }]);
  });
  it('keeps the last state of a line redrawn with \\r', () => {
    expect(plainText('10%\r50%\r100%\nnext')).toBe('100%\nnext');
  });
});
