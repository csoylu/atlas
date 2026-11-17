import { describe, expect, it } from 'vitest';
import { grownHeight } from './useAutoGrow.ts';

describe('grownHeight (#102)', () => {
  it('keeps the 4-line minimum for short text', () => expect(grownHeight(25, 88, 400)).toBe(88));
  it('follows the text in between', () => expect(grownHeight(200, 88, 400)).toBe(200));
  it('stops at the cap, then the box scrolls', () => expect(grownHeight(900, 88, 400)).toBe(400));
  it('never goes below the minimum on a tiny window', () => expect(grownHeight(900, 88, 40)).toBe(88));
});
