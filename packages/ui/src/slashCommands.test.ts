import { describe, expect, it } from 'vitest';
import { parseSlash, slashKey, slashMatches, type SlashKeyEvent } from './slashCommands.ts';

const key = (k: string, o: Partial<SlashKeyEvent> = {}): SlashKeyEvent => ({ key: k, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...o });
const names = (t: string) => slashMatches(t).map((c) => c.name);

describe('slash popup filter', () => {
  it('opens only when / is the first character, filtered as you type', () => {
    expect(names('/')).toEqual(['clear', 'compact']);
    expect(names('/c')).toEqual(['clear', 'compact']);
    expect(names('/co')).toEqual(['compact']);
    expect(names('/CL')).toEqual(['clear']);
    expect(names('/x')).toEqual([]);
    expect(names('')).toEqual([]);
    expect(names('see a/b')).toEqual([]);
    expect(names(' /clear')).toEqual([]);
    // A space: the name is done (a focus follows), the popup closes.
    expect(names('/compact keep it')).toEqual([]);
  });
});

describe('slash popup keys', () => {
  const all = slashMatches('/');
  it('↑/↓ move and wrap, Esc closes', () => {
    expect(slashKey(key('ArrowDown'), { matches: all, index: 0 })).toEqual({ kind: 'move', index: 1 });
    expect(slashKey(key('ArrowDown'), { matches: all, index: 1 })).toEqual({ kind: 'move', index: 0 });
    expect(slashKey(key('ArrowUp'), { matches: all, index: 0 })).toEqual({ kind: 'move', index: 1 });
    expect(slashKey(key('Escape'), { matches: all, index: 0 })).toEqual({ kind: 'close' });
  });
  it('Enter or Tab runs the highlighted command', () => {
    expect(slashKey(key('Enter'), { matches: all, index: 1 })).toEqual({ kind: 'run', name: 'compact' });
    expect(slashKey(key('Tab'), { matches: slashMatches('/co'), index: 0 })).toEqual({ kind: 'run', name: 'compact' });
    // An index past the list (it got shorter as you typed) picks the last one.
    expect(slashKey(key('Enter'), { matches: slashMatches('/co'), index: 1 })).toEqual({ kind: 'run', name: 'compact' });
  });
  it('leaves other keys, Shift+Enter, IME and a closed popup alone', () => {
    expect(slashKey(key('a'), { matches: all, index: 0 })).toBeNull();
    expect(slashKey(key('Enter', { shiftKey: true }), { matches: all, index: 0 })).toBeNull();
    expect(slashKey(key('Enter', { isComposing: true }), { matches: all, index: 0 })).toBeNull();
    expect(slashKey(key('Enter', { metaKey: true }), { matches: all, index: 0 })).toBeNull();
    expect(slashKey(key('Enter'), { matches: [], index: 0 })).toBeNull();
  });
});

describe('parseSlash', () => {
  it('reads an exact command and the /compact focus; anything else is a message', () => {
    expect(parseSlash('/clear')).toEqual({ name: 'clear', arg: '' });
    expect(parseSlash('  /compact  ')).toEqual({ name: 'compact', arg: '' });
    expect(parseSlash('/compact keep the rewind design')).toEqual({ name: 'compact', arg: 'keep the rewind design' });
    expect(parseSlash('/clear now please')).toBeNull();
    expect(parseSlash('/co')).toBeNull();
    expect(parseSlash('a/b')).toBeNull();
    expect(parseSlash('/unknown')).toBeNull();
  });
});
