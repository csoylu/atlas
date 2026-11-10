import { describe, expect, it } from 'vitest';
import { CreateModel, UpdateModel } from '@atlas/shared';
import { migrate, openDb } from './store/db.ts';
import { Models } from './models.ts';

describe('removed Claude CLI integration', () => {
  it('rejects new legacy providers and fails existing models without a fallback', async () => {
    expect(CreateModel.safeParse({ id: 'legacy', provider: 'claude_code', name: 'sonnet' }).success).toBe(false);
    expect(UpdateModel.safeParse({ provider: 'claude_code' }).success).toBe(false);
    const db = openDb(':memory:');
    db.prepare("INSERT INTO models (id, provider, name) VALUES ('legacy', 'claude_code', 'sonnet')").run();
    const models = new Models(db);
    expect(models.get('legacy').credentialPresent).toBe(false);
    expect(() => models.provider('legacy')).toThrow('Direct subscription OAuth requires Anthropic authorization');
    expect(await models.test('legacy')).toMatchObject({ ok: false });
    db.close();
  });

  it('forward migration preserves model references and clears obsolete verification', () => {
    const db = openDb(':memory:');
    // Simulate an installation that has applied 0017, before 0018 arrives.
    db.prepare("DELETE FROM schema_migrations WHERE name = '0018_remove_claude_code.sql'").run();
    db.prepare("INSERT INTO models (id, provider, name, verified_at) VALUES ('legacy', 'claude_code', 'sonnet', '2026-11-10')").run();
    db.prepare("INSERT INTO agents (id, model_id) VALUES ('legacy-agent', 'legacy')").run();
    expect(migrate(db)).toEqual(['0018_remove_claude_code.sql']);
    expect(db.prepare("SELECT provider, verified_at, last_error FROM models WHERE id = 'legacy'").get()).toMatchObject({
      provider: 'claude_code', verified_at: null, last_error: expect.stringContaining('integration removed'),
    });
    expect(db.prepare("SELECT model_id FROM agents WHERE id = 'legacy-agent'").get()).toEqual({ model_id: 'legacy' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(migrate(db)).toEqual([]);
    db.close();
  });
});
