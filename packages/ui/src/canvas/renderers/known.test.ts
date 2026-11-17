import { describe, expect, it } from 'vitest';
import { isKnown } from './index.ts';

describe('isKnown', () => {
  it('draws the current kinds and skips removed or unknown ones (v3: drawings) instead of crashing', () => {
    expect(['markdown', 'html', 'url'].every((kind) => isKnown({ kind }))).toBe(true);
    expect(isKnown({ kind: 'drawing' })).toBe(false);
    expect(isKnown({ kind: 'toString' })).toBe(false);
  });
});
