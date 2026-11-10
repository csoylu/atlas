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
    expect(JSON.parse(listed)).toEqual({ store: 'test store', names: ['ATLAS_LOCAL_API_KEY', 'ANTHROPIC_API_KEY'] });
    expect((await put(engine.url + '/api/secrets/bad-name', 'x')).status).toBe(409);
    expect((await fetch(engine.url + '/api/secrets/ANTHROPIC_API_KEY', { method: 'DELETE' })).status).toBe(204);
    expect(engine.models.get('sonnet').credentialPresent).toBe(false);
  });

  it('refuses to store keys on an engine without a store (server mode)', async () => {
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, env: {} });
    const r = await put(engine.url + '/api/secrets/ANTHROPIC_API_KEY', 'sk');
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/environment/);
  });
});
