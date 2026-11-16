import { describe, expect, it } from 'vitest';
import { clearDraft, draftKey, readDraft, writeDraft } from './drafts.ts';

const mem = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};

describe('drafts', () => {
  it('keys per conversation', () => {
    expect(draftKey('card', 'c_1')).toBe('atlas.draft.card.c_1');
    expect(draftKey('new')).toBe('atlas.draft.new');
  });
  it('round-trips text with line breaks, per key', () => {
    const s = mem();
    writeDraft('a', 'line 1\n\nline 2  ', s);
    writeDraft('b', 'other', s);
    expect(readDraft('a', s)).toBe('line 1\n\nline 2  ');
    expect(readDraft('b', s)).toBe('other');
  });
  it('missing or corrupt entries read as empty', () => {
    const s = mem();
    expect(readDraft('none', s)).toBe('');
    s.setItem('bad', '{not json');
    expect(readDraft('bad', s)).toBe('');
    s.setItem('obj', '{"x":1}');
    expect(readDraft('obj', s)).toBe('');
    const broken = { getItem: () => { throw new Error('denied'); }, setItem() {}, removeItem() {} };
    expect(readDraft('x', broken)).toBe('');
  });
  it('empty drafts and clear remove the key', () => {
    const s = mem();
    writeDraft('a', 'hi', s);
    writeDraft('a', '  \n', s);
    expect(s.m.has('a')).toBe(false);
    writeDraft('a', 'hi', s);
    clearDraft('a', s);
    expect(s.m.has('a')).toBe(false);
  });
});
