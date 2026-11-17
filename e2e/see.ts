import type { Locator } from 'playwright-core';
import { expect } from 'vitest';

/** Assertions on what the page shows. They retry for a few seconds (the UI updates over the WebSocket), then fail. */
const T = { timeout: 8000 };

export const see = {
  /** At least one match is on screen. */
  visible: (l: Locator, msg?: string) => expect.poll(() => l.first().isVisible(), { ...T, message: msg }).toBe(true),
  /** Nothing matches. */
  absent: (l: Locator, msg?: string) => expect.poll(() => l.count(), { ...T, message: msg }).toBe(0),
  count: (l: Locator, n: number, msg?: string) => expect.poll(() => l.count(), { ...T, message: msg }).toBe(n),
  /** The matches' texts, in order, each containing (string) or matching (RegExp) the expected one. */
  texts: (l: Locator, want: (string | RegExp)[], msg?: string) =>
    expect
      .poll(
        async () => {
          const got = await l.allInnerTexts();
          return got.length === want.length && want.every((w, i) => (typeof w === 'string' ? got[i]!.includes(w) : w.test(got[i]!))) ? 'ok' : JSON.stringify(got);
        },
        { ...T, message: msg },
      )
      .toBe('ok'),
  value: (l: Locator, v: string) => expect.poll(() => l.inputValue(), T).toBe(v),
};
