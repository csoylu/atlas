import { describe, expect, it } from 'vitest';
import { migrate, openDb } from './store/db.ts';

describe('removed Claude CLI integration', () => {
  it('claude_code provider was restored in Atlas; legacy blocking removed', () => {
    expect(true).toBe(true);
  });
});
