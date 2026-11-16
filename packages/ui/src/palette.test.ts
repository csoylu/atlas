import { describe, expect, it } from 'vitest';
import { fuzzy, matchItem, moveSel, rank, sectionOrder, type PaletteItem } from './palette.ts';

const item = (section: PaletteItem['section'], title: string, extra: Partial<PaletteItem> = {}): PaletteItem => ({ id: title, section, title, ...extra });

describe('fuzzy matcher', () => {
  it('matches substrings and letters in order, case-insensitively', () => {
    expect(fuzzy('lib', 'Go to Library')).not.toBeNull();
    expect(fuzzy('LIB', 'go to library')!.hits).toEqual([6, 7, 8]);
    expect(fuzzy('gtl', 'Go to Library')).not.toBeNull();
    expect(fuzzy('xyz', 'Go to Library')).toBeNull();
    expect(fuzzy('bil', 'Library')).toBeNull(); // order matters
    expect(fuzzy('lib', 'claude like a big thing')).toBeNull(); // spread over 3 words
    expect(fuzzy('board', 'Backfill Binance funding rates, orderbook and depth')).toBeNull(); // too scattered
  });
  it('every query word must match, in any order', () => {
    expect(fuzzy('design linear', 'Design refresh: Linear direction')).not.toBeNull();
    expect(fuzzy('linear design', 'Design refresh: Linear direction')).not.toBeNull();
    expect(fuzzy('linear board', 'Design refresh: Linear direction')).toBeNull();
  });
  it('empty query matches everything with score 0', () => {
    expect(fuzzy('  ', 'anything')).toEqual({ score: 0, hits: [] });
  });
  it('ranks prefix > word start > mid-word > scattered letters', () => {
    const s = (q: string, t: string) => fuzzy(q, t)!.score;
    expect(s('lib', 'Library')).toBeGreaterThan(s('lib', 'Go to Library'));
    expect(s('lib', 'Go to Library')).toBeGreaterThan(s('lib', 'Go to Shoblib'));
    expect(s('lib', 'Go to Shoblib')).toBeGreaterThan(s('lib', 'Lit bin'));
  });
  it('prefers a word-start occurrence for highlighting', () => {
    expect(fuzzy('art', 'Smart artifacts')!.hits).toEqual([6, 7, 8]);
  });
  it('subsequence highlights the letters it used', () => {
    expect(fuzzy('nc', 'New card')!.hits).toEqual([0, 4]);
  });
});

describe('matchItem', () => {
  it('#12 and 12 find card 12 first, then numbers starting with 12', () => {
    const c12 = item('Cards', 'Export CSV', { number: 12 });
    const c123 = item('Cards', 'Other', { number: 123 });
    expect(matchItem(c12, '#12')!.score).toBe(1000);
    expect(matchItem(c12, '12')!.score).toBe(1000);
    expect(matchItem(c123, '#12')!.score).toBeLessThan(1000);
    expect(matchItem(item('Cards', 'x', { number: 7 }), '#12')).toBeNull();
  });
  it('falls back to keywords, ranked below a title match, highlights only the title', () => {
    const doc = item('Artifacts', 'Atlas design', { keywords: 'docs/design.md @atlas' });
    expect(matchItem(doc, 'md')).not.toBeNull();
    expect(matchItem(doc, 'md')!.hits.every((h) => h < doc.title.length)).toBe(true);
    expect(matchItem(item('Artifacts', 'Design md'), 'md')!.score).toBeGreaterThan(matchItem(doc, 'md')!.score);
    // Not letters scattered over title + keywords: « lib » is not in « Inline canvas test whiteboard ».
    expect(matchItem(item('Artifacts', 'Inline canvas test', { keywords: 'whiteboard @atlas' }), 'lib')).toBeNull();
    expect(matchItem(item('Artifacts', 'Inline canvas test', { keywords: 'whiteboard @atlas' }), 'atlas canvas')).not.toBeNull();
  });
});

describe('rank', () => {
  const items = [
    item('Artifacts', 'Design refresh: Linear direction'),
    item('Artifacts', 'System overview'),
    item('Navigation', 'Go to Library'),
    item('Navigation', 'Go to Board'),
    item('Actions', 'New card'),
    item('Cards', 'Library screen', { number: 42 }),
    item('Chats', 'Orderbook ingestion'),
  ];
  it('empty query: every section in the screen order, recency kept', () => {
    const g = rank(items, '', sectionOrder('chat'));
    expect(g.map((x) => x.section)).toEqual(['Artifacts', 'Chats', 'Cards', 'Navigation', 'Actions']);
    expect(g[0]!.items.map((r) => r.item.title)).toEqual(['Design refresh: Linear direction', 'System overview']);
  });
  it('empty query: boosted items first, artifacts capped', () => {
    const many = Array.from({ length: 8 }, (_, i) => item('Artifacts', 'Doc ' + i, { boost: i === 6 ? 50 : 0 }));
    const g = rank(many, '', sectionOrder('library'), 6, 4);
    expect(g[0]!.items).toHaveLength(4);
    expect(g[0]!.items[0]!.item.title).toBe('Doc 6');
  });
  it('a query drops empty sections and puts the best match first', () => {
    const g = rank(items, 'board', sectionOrder('chat'));
    expect(g.map((x) => x.section)).toEqual(['Navigation']);
    expect(g[0]!.items[0]!.item.title).toBe('Go to Board');
  });
  it("the screen's sections get a head start: « lib » in a chat lists artifacts before navigation", () => {
    const docs = [item('Artifacts', 'Library screen spec'), item('Navigation', 'Go to Library')];
    expect(rank(docs, 'lib', sectionOrder('chat')).map((g) => g.section)).toEqual(['Artifacts', 'Navigation']);
    expect(rank(docs, 'lib', sectionOrder('settings')).map((g) => g.section)).toEqual(['Navigation', 'Artifacts']);
  });
  it('#42 jumps to the card', () => {
    const g = rank(items, '#42', sectionOrder('chat'));
    expect(g[0]!.section).toBe('Cards');
    expect(g[0]!.items[0]!.item.number).toBe(42);
  });
  it('caps each section with a query', () => {
    const many = Array.from({ length: 10 }, (_, i) => item('Cards', 'Card ' + i));
    expect(rank(many, 'card', sectionOrder('board'), 6)[0]!.items).toHaveLength(6);
  });
});

describe('moveSel', () => {
  it('wraps around', () => {
    expect(moveSel(3, 2, 1)).toBe(0);
    expect(moveSel(3, 0, -1)).toBe(2);
    expect(moveSel(0, 0, 1)).toBe(0);
  });
});
