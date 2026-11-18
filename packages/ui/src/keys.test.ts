import { describe, expect, it } from 'vitest';
import { globalKey, G_WINDOW, isTyping, nextRow } from './keys.ts';

const key = (k: string, extra: Partial<KeyboardEvent> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, repeat: false, ...extra }) as KeyboardEvent;
const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, closest: () => null, ...extra }) as unknown as EventTarget;
const idle = { gAt: null, now: 10_000 };
const at = (k: string, extra: Partial<KeyboardEvent> = {}, target: EventTarget | null = null, opts = idle) => globalKey(key(k, extra), target, opts)?.kind ?? null;

describe('isTyping', () => {
  it('inputs, textareas, selects and contenteditable have the keyboard', () => {
    expect(isTyping(el('INPUT'))).toBe(true);
    expect(isTyping(el('TEXTAREA'))).toBe(true);
    expect(isTyping(el('SELECT'))).toBe(true);
    expect(isTyping(el('DIV', { isContentEditable: true }))).toBe(true);
    expect(isTyping(el('BUTTON'))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe('globalKey', () => {
  it('⌘K / Ctrl+K open the palette, even while typing or with a modal open', () => {
    expect(at('k', { metaKey: true })).toBe('palette');
    expect(at('K', { ctrlKey: true })).toBe('palette');
    expect(at('k', { metaKey: true }, el('TEXTAREA'))).toBe('palette');
    expect(globalKey(key('k', { metaKey: true }), null, { ...idle, blocked: true })?.kind).toBe('palette');
  });
  it('⌘N new chat and ⌘\\ panel, also while typing; nothing else when blocked', () => {
    expect(at('n', { metaKey: true }, el('TEXTAREA'))).toBe('newChat');
    expect(at('\\', { metaKey: true })).toBe('togglePanel');
    expect(globalKey(key('n', { metaKey: true }), null, { ...idle, blocked: true })).toBeNull();
    expect(globalKey(key('c'), null, { ...idle, blocked: true })).toBeNull();
  });
  it('letters are ignored while typing or with a modifier', () => {
    expect(at('c')).toBe('newCard');
    expect(at('c', {}, el('INPUT'))).toBeNull();
    expect(at('c', { altKey: true })).toBeNull();
    expect(at('c', { shiftKey: true })).toBeNull();
    expect(at('c', { metaKey: true })).toBeNull(); // ⌘C is copy
    expect(at('c', { defaultPrevented: true })).toBeNull();
    expect(at('x')).toBeNull();
  });
  it('? opens the cheat sheet', () => {
    expect(at('?', { shiftKey: true })).toBe('help');
    expect(at('?', { shiftKey: true }, el('INPUT'))).toBeNull();
  });
  it('G then B / L / I / S jumps, within the window', () => {
    expect(at('g')).toBe('goPrefix');
    expect(globalKey(key('b'), null, { gAt: 9_000, now: 9_500 })).toEqual({ kind: 'go', to: 'board' });
    expect(globalKey(key('l'), null, { gAt: 9_000, now: 9_500 })).toEqual({ kind: 'go', to: 'library' });
    expect(globalKey(key('I'), null, { gAt: 9_000, now: 9_500 })).toEqual({ kind: 'go', to: 'inbox' });
    expect(globalKey(key('w'), null, { gAt: 9_000, now: 9_500 })).toEqual({ kind: 'go', to: 'workflows' });
    expect(globalKey(key('b'), null, { gAt: 9_000, now: 9_000 + G_WINDOW + 1 })).toBeNull();
    expect(globalKey(key('b'), null, idle)).toBeNull();
  });
  it('J / K move in lists (repeat allowed), C and G not on repeat', () => {
    expect(at('j')).toBe('listNext');
    expect(at('k')).toBe('listPrev');
    expect(at('j', { repeat: true })).toBe('listNext');
    expect(at('c', { repeat: true })).toBeNull();
    expect(at('g', { repeat: true })).toBeNull();
  });
});

describe('nextRow', () => {
  it('starts at the first (J) or last (K) row, stays at the ends', () => {
    expect(nextRow(3, -1, 1)).toBe(0);
    expect(nextRow(3, -1, -1)).toBe(2);
    expect(nextRow(3, 2, 1)).toBe(2);
    expect(nextRow(3, 0, -1)).toBe(0);
    expect(nextRow(3, 1, 1)).toBe(2);
    expect(nextRow(0, -1, 1)).toBeNull();
  });
});
