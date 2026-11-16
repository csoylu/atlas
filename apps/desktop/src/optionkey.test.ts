// Push-to-talk « hold ⌥ » (card #75): the key-state logic with fake key events (no keyboard, no native tap).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOLD_MIN_MS, OptionHold, rawEvent, type HoldEvent, type RawKeyEvent } from './optionkey.ts';

const altDown: RawKeyEvent = { kind: 'flags', alt: true, others: false };
const altUp: RawKeyEvent = { kind: 'flags', alt: false, others: false };
const key: RawKeyEvent = { kind: 'key' };
const click: RawKeyEvent = { kind: 'mouse' };

describe('OptionHold: hold ⌥ alone to talk (#75)', () => {
  let events: HoldEvent[];
  let h: OptionHold;
  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    h = new OptionHold((e) => events.push(e));
  });
  afterEach(() => vi.useRealTimers());

  it('held: starts after 150 ms; released: ends', () => {
    h.input(altDown);
    vi.advanceTimersByTime(HOLD_MIN_MS - 1);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(['start']);
    vi.advanceTimersByTime(5000); // held while talking
    h.input(altUp);
    expect(events).toEqual(['start', 'end']);
    expect(h.state).toBe('up');
  });

  it('a short tap does nothing', () => {
    h.input(altDown);
    vi.advanceTimersByTime(100);
    h.input(altUp);
    vi.advanceTimersByTime(1000);
    expect(events).toEqual([]);
  });

  it('⌥-letter, ⌥-click, ⌥Tab before the hold starts: nothing at all, even if ⌥ stays down', () => {
    for (const other of [key, click]) {
      h.input(altDown);
      vi.advanceTimersByTime(50);
      h.input(other);
      vi.advanceTimersByTime(2000);
      h.input(altUp);
    }
    expect(events).toEqual([]);
  });

  it('a key or a click while held: cancelled (nothing sent), and nothing more until ⌥ is released', () => {
    for (const other of [key, click]) {
      h.input(altDown);
      vi.advanceTimersByTime(400);
      h.input(other);
      h.input(other);
      vi.advanceTimersByTime(2000);
      h.input(altUp);
    }
    expect(events).toEqual(['start', 'cancel', 'start', 'cancel']);
  });

  it('with another modifier: ⌥⇧, ⌘⌥ (either order) never start; one added while held cancels', () => {
    h.input({ kind: 'flags', alt: false, others: true }); // ⌘ down
    h.input({ kind: 'flags', alt: true, others: true }); // then ⌥
    vi.advanceTimersByTime(1000);
    h.input({ kind: 'flags', alt: true, others: false }); // ⌘ let go, ⌥ still down: still a combo
    vi.advanceTimersByTime(1000);
    h.input(altUp);
    expect(events).toEqual([]);

    h.input(altDown);
    vi.advanceTimersByTime(50);
    h.input({ kind: 'flags', alt: true, others: true }); // ⇧ added early
    vi.advanceTimersByTime(1000);
    h.input(altUp);
    expect(events).toEqual([]);

    h.input(altDown);
    vi.advanceTimersByTime(300);
    h.input({ kind: 'flags', alt: true, others: true }); // ⇧ added while talking
    h.input({ kind: 'flags', alt: false, others: true });
    expect(events).toEqual(['start', 'cancel']);
  });

  it('left and right ⌥ both work (both down, one let go: still held)', () => {
    h.input(altDown); // left
    vi.advanceTimersByTime(200);
    h.input(altDown); // right too: the flags still say ⌥
    h.input(altDown); // left let go, right still down
    h.input(altUp);
    expect(events).toEqual(['start', 'end']);
  });

  it('a key or click with ⌥ up does nothing; reset() cancels a hold under way', () => {
    h.input(key);
    h.input(click);
    expect(events).toEqual([]);
    h.input(altDown);
    vi.advanceTimersByTime(200);
    h.reset();
    h.input(altUp);
    expect(events).toEqual(['start', 'cancel']);
  });

  it('reads the event tap: CGEventFlags → ⌥ / other modifiers (caps lock ignored)', () => {
    expect(rawEvent(0, 0x80000)).toEqual({ kind: 'flags', alt: true, others: false });
    expect(rawEvent(0, 0x80000 | 0x10000 | 0x100)).toEqual({ kind: 'flags', alt: true, others: false }); // caps lock + device bits
    expect(rawEvent(0, 0x80000 | 0x100000)).toEqual({ kind: 'flags', alt: true, others: true }); // ⌘⌥
    expect(rawEvent(0, 0x20000)).toEqual({ kind: 'flags', alt: false, others: true });
    expect(rawEvent(0, 0x100)).toEqual({ kind: 'flags', alt: false, others: false });
    expect(rawEvent(1, 0x80000)).toEqual({ kind: 'key' });
    expect(rawEvent(2, 0)).toEqual({ kind: 'mouse' });
  });
});
