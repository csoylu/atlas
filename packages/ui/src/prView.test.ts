import { describe, expect, it } from 'vitest';
import type { CardPr } from '@atlas/shared';
import { prBits, prUnreadable, readAgo, tilePrs } from './prView.ts';

const pr = (over: Partial<CardPr> = {}): CardPr => ({
  repo: 'csoylu/atlas', number: 41, url: 'https://github.com/csoylu/atlas/pull/41', branch: 'feat/170-x', base: 'main', headSha: 'aaaaaaa1111',
  state: 'open', mergeSha: null, mergeable: true, ci: 'pending', ciFailed: null, qa: null, qaDescription: null, checkedAt: '2026-11-18T10:00:00Z', error: null, errorSince: null, reviewedSha: null,
  ...over,
});

describe('pull requests on tasks (#189)', () => {
  it('says CI, conflicts and QA in plain bits', () => {
    expect(prBits(pr(), 'zurich', false)).toEqual([{ text: '○ CI running', tone: 'muted' }]);
    expect(prBits(pr({ ci: 'success' }), 'zurich', true).map((b) => b.text)).toEqual(['✓ CI', 'QA: @zurich checking']);
    expect(prBits(pr({ ci: 'success', mergeable: false, qa: 'failure' }), 'zurich', false).map((b) => b.tone)).toEqual(['ok', 'bad', 'bad']);
    expect(prBits(pr({ state: 'merged', mergeSha: 'e96a8e2ffff' }), null, false)).toEqual([{ text: 'merged · e96a8e2', tone: 'info' }]);
  });
  it('tile shows open PRs while in review, the merged ones when done, none in triage', () => {
    const open = pr(), merged = pr({ number: 40, state: 'merged' });
    expect(tilePrs({ status: 'review', prs: [merged, open] })).toEqual([open]);
    expect(tilePrs({ status: 'done', prs: [merged, open] })).toEqual([merged]);
    expect(tilePrs({ status: 'triage', prs: [open] })).toEqual([]);
    expect(prUnreadable({ status: 'review', prs: [pr({ error: 'gh: not logged in' })] })).toBe(true);
  });
  it('read time', () => {
    expect(readAgo(pr(), Date.parse('2026-11-18T10:00:40Z'))).toBe('read 40 s ago');
    expect(readAgo(pr({ checkedAt: null }))).toBe('reading…');
    expect(readAgo(pr({ error: 'x' }))).toMatch(/^last read \d\d:\d\d$/);
  });
});
