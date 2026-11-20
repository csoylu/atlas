import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEngine, type Engine } from './index.ts';
import type { SecretStore } from './secrets.ts';

class MemoryStore implements SecretStore {
  label = 'test store';
  map = new Map<string, string>();
  names = () => [...this.map.keys()];
  get = (n: string) => this.map.get(n);
  set = (n: string, v: string) => void this.map.set(n, v);
  delete = (n: string) => void this.map.delete(n);
}

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});
const put = (url: string, value: string) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });

describe('secrets', () => {
  it('stores keys in the store, applies them live, and never returns values', async () => {
    const store = new MemoryStore();
    store.set('ATLAS_LOCAL_API_KEY', 'old');
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, env: {}, secrets: store });
    expect(engine.models.get('local').credentialPresent).toBe(true);
    expect(engine.models.get('sonnet').credentialPresent).toBe(false);
    expect((await put(engine.url + '/api/secrets/ANTHROPIC_API_KEY', 'sk-test')).status).toBe(204);
    expect(store.get('ANTHROPIC_API_KEY')).toBe('sk-test');
    expect(engine.models.get('sonnet').credentialPresent).toBe(true);
    const listed = await (await fetch(engine.url + '/api/secrets')).text();
    expect(listed).not.toContain('sk-test');
    expect(JSON.parse(listed)).toMatchObject({ store: 'test store', names: ['ATLAS_LOCAL_API_KEY', 'ANTHROPIC_API_KEY'] });
    expect((await put(engine.url + '/api/secrets/bad-name', 'x')).status).toBe(409);
    expect((await fetch(engine.url + '/api/secrets/ANTHROPIC_API_KEY', { method: 'DELETE' })).status).toBe(204);
    expect(engine.models.get('sonnet').credentialPresent).toBe(false);
  });

  it('#322: takes the model keys, plan tokens and engine passwords out of process.env (inherited by gh, git, Chrome…), keeps using them, keeps other variables', async () => {
    const set = { ANTHROPIC_API_KEY: 'sk-env-322', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-322', ATLAS_SECRETS_PASSWORD: 'pw-322', ATLAS_PASSWORD: 'login-322', CLAUDE_TOKENS: 'plan-322', GH_TOKEN: 'gh-322' };
    const before = { ...process.env };
    Object.assign(process.env, set);
    try {
      engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false });
      for (const n of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ATLAS_SECRETS_PASSWORD', 'ATLAS_PASSWORD', 'CLAUDE_TOKENS']) expect(process.env[n], n).toBeUndefined();
      expect(process.env.GH_TOKEN).toBe('gh-322'); // a server's own gh may need it
      expect(engine.models.get('sonnet').credentialPresent).toBe(true); // the engine still has the key
    } finally {
      for (const n of Object.keys(set)) delete process.env[n];
      for (const n of Object.keys(set)) if (before[n] !== undefined) process.env[n] = before[n];
    }
  });

  it('refuses to store keys on an engine without a store (server mode)', async () => {
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, env: {} });
    const r = await put(engine.url + '/api/secrets/ANTHROPIC_API_KEY', 'sk');
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/environment/);
  });
});
