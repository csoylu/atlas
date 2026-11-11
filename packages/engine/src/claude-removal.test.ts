import { describe, expect, it } from 'vitest';
import { Models } from './models.ts';
import { openDb } from './store/db.ts';

describe('restored Claude subscription provider', () => {
  it('persists legacy provider models across migrations', () => {
    const db = openDb(':memory:');
    try {
      const models = new Models(db);
      models.create({ id: 'legacy', provider: 'claude_code', name: 'claude-opus-5-5' });
      expect(models.get('legacy').provider).toBe('claude_code');
    } finally {
      db.close();
    }
  });
});
