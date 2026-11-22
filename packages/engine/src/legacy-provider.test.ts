import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { Model, UsageSummary } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';

// #341: a database from before 0071 that still holds the legacy provider (0017, removed in 0018), as a model an agent
// uses and as usage history, opens, and the Models and Usage pages' endpoints load.
const LEGACY = 'claude_code';

describe('0071: the legacy Claude Code provider leaves', () => {
  let engine: Engine | null = null;
  afterEach(async () => {
    await engine?.stop();
    engine = null;
  });

  it('turns its models into Claude plan models (agents keep them) and counts its usage under Claude plan', async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'store', 'migrations');
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const file = join(dataDir, 'atlas.db');
    const db = new Database(file);
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.pragma('foreign_keys = OFF');
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0071').sort()) {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, 'x');
    }
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO models (id, provider, name, base_url, credential_env, verified_at, last_error) VALUES ('legacy', ?, 'claude-opus-5-5', 'https://example.test', 'OLD_KEY', 'x', 'removed')").run(LEGACY);
    db.prepare("INSERT INTO agents (id, role_prompt, model_id, workdir) VALUES ('munih', 'r', 'legacy', '/w/munih')").run();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO model_usage (at, model_id, provider, kind, input, output) VALUES (?, 'legacy', ?, 'turn', 100, 20)").run(now, LEGACY);
    db.close();

    engine = await startEngine({ dbFile: file, dataDir, port: 0, dispatch: false, env: {} });
    const models = await fetch(engine.url + '/api/models');
    expect(models.status).toBe(200);
    expect(((await models.json()) as Model[]).find((m) => m.id === 'legacy')).toMatchObject({
      provider: 'claude_plan',
      name: 'claude-opus-5-5',
      baseUrl: null,
      credentialEnv: null,
      verifiedAt: null,
      lastError: null,
    });
    expect(engine.db.prepare("SELECT model_id FROM agents WHERE id = 'munih'").get()).toEqual({ model_id: 'legacy' });

    const usage = await fetch(engine.url + '/api/usage');
    expect(usage.status).toBe(200);
    const s = (await usage.json()) as UsageSummary;
    expect(s.total).toMatchObject({ calls: 1, input: 100, output: 20 });
    expect(s.perDay.at(-1)).toMatchObject({ claude_plan: 120 });
    expect(s.models).toEqual([expect.objectContaining({ modelId: 'legacy', provider: 'claude_plan' })]);
    expect(engine.db.prepare('SELECT COUNT(*) AS n FROM model_usage WHERE provider = ?').get(LEGACY)).toEqual({ n: 0 });

    // The value is gone from the schema: it can no longer be stored, even below the API.
    expect(() => engine!.db.prepare("INSERT INTO models (id, provider, name) VALUES ('again', ?, 'x')").run(LEGACY)).toThrow(/CHECK/);
  });
});
