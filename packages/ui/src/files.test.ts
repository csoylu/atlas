import { describe, expect, it } from 'vitest';
import type { WsFile } from '@atlas/shared';
import { ancestors, binaryWhat, fileState, fileTitle, fmtBytes, langOf, parsePathRef, rowIcon, splitPath, treeBeside } from './files.ts';

describe('parsePathRef (#303, file paths in chat)', () => {
  it('reads a path and its line', () => {
    expect(parsePathRef('src/pages/Tenders.tsx:42')).toEqual({ path: 'src/pages/Tenders.tsx', line: 42 });
    expect(parsePathRef('packages/ui/src/docPanel.ts')).toEqual({ path: 'packages/ui/src/docPanel.ts', line: null });
    expect(parsePathRef('a/b.ts:12:5')).toEqual({ path: 'a/b.ts', line: 12 });
    expect(parsePathRef('./scripts/x.mjs')).toEqual({ path: './scripts/x.mjs', line: null });
    expect(parsePathRef('README.md')).toEqual({ path: 'README.md', line: null });
    expect(parsePathRef('src/data')).toEqual({ path: 'src/data', line: null });
  });

  it('leaves code that is not a path alone', () => {
    for (const t of ['npm test', 'api.panelOpen', 'useState', '0.3.0', 'https://x.io/a.ts', 'a/b/', '~/x/y.ts', '', 'foo()', 'x => y', 'v1.2'])
      expect(parsePathRef(t), t).toBeNull();
  });
});

describe('Files helpers', () => {
  it('names tabs and splits paths', () => {
    expect(fileTitle('a/b/c.ts')).toBe('c.ts');
    expect(fileTitle('')).toBe('Files');
    expect(splitPath('a/b/c.ts')).toEqual({ dir: 'a/b/', name: 'c.ts' });
    expect(splitPath('c.ts')).toEqual({ dir: '', name: 'c.ts' });
    expect(ancestors('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestors('c.ts')).toEqual([]);
  });

  it('puts the tree beside the editor only in a wide side pane', () => {
    expect(treeBeside('side', 700)).toBe(true);
    expect(treeBeside('side', 500)).toBe(false);
    expect(treeBeside('overlay', 900)).toBe(false);
    expect(treeBeside('full', 900)).toBe(false);
  });

  it('says sizes and binary kinds in plain words', () => {
    expect(fmtBytes(3.1 * 1024 * 1024)).toBe('3.1 MB');
    expect(fmtBytes(2048)).toBe('2 KB');
    expect(fmtBytes(1)).toBe('1 byte');
    expect(binaryWhat('data/atlas.sqlite', 2 * 1024 * 1024)).toBe('SQLite database, 2.0 MB');
    expect(binaryWhat('x.weird', 10)).toBe('10 bytes');
  });

  it('gives the bar its state', () => {
    const f = (readOnly: WsFile['readOnly'], size = 10) => ({ readOnly, size }) as WsFile;
    expect(fileState(f(null), false, false, null)).toEqual({ kind: 'saved' });
    expect(fileState(f(null), true, false, null)).toEqual({ kind: 'unsaved' });
    expect(fileState(f(null), true, true, null)).toEqual({ kind: 'saving' });
    expect(fileState(f('binary'), false, false, null)).toEqual({ kind: 'ro', label: 'Read only · binary' });
    expect(fileState(f('large', 3.1 * 1024 * 1024), false, false, null)).toEqual({ kind: 'ro', label: 'Read only · 3.1 MB' });
    expect(fileState(f('image'), false, false, { w: 390, h: 844 })).toEqual({ kind: 'ro', label: '390 × 844' });
  });

  it('picks a language and a row icon', () => {
    expect(langOf('a/b.tsx')).toBe('tsx');
    expect(langOf('x.yml')).toBe('yaml');
    expect(langOf('Makefile')).toBeNull();
    expect(rowIcon('shot.png')).toBe('image');
    expect(rowIcon('notes.md')).toBe('md');
    expect(rowIcon('a.ts')).toBe('code');
    expect(rowIcon('db.sqlite')).toBe('file');
  });
});
