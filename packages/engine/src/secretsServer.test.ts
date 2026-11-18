import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContentBlock, SecretInfo, SecretList, SecretStoreStatus, ServerEvent } from '@atlas/shared';
import { eventually, launch } from '../test/kit/index.ts';
import type { ModelRequest } from './providers/types.ts';
import { SECRETS_LOCKED, serverSecretStore, SecretFile } from './secretFile.ts';

/** #208: a server engine with secrets.enc: unlock, lock, password, and what a locked store stops (and what it doesn't). */

const opts = { N: 2 ** 10, failDelayMs: 0 };
const PW = 'server secrets password';
const B = 'b-value-1234567890';
const MODEL_KEY = 'sk-model-key-in-the-store-000';
const ENV_KEY = 'sk-model-key-in-the-env-0000';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const shell = (id: string, command: string): ContentBlock[] => [{ type: 'tool_use', id, name: 'shell', input: { command } }];
const results = (req: ModelRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));
const rev = (s: string) => [...s].reverse().join('');

async function server(script: NonNullable<Parameters<typeof launch>[0]>['script'] = [], o: { dataDir?: string; dbFile?: string; env?: NodeJS.ProcessEnv; failDelayMs?: number } = {}) {
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-srv-'));
  const env = o.env ?? {};
  const store = await serverSecretStore(dataDir, env, { ...opts, failDelayMs: o.failDelayMs ?? 0 });
  const l = await launch({ script, secrets: store, dispatch: false, env, dataDir, ...(o.dbFile ? { dbFile: o.dbFile } : {}) });
  const bodies: string[] = [];
  const raw = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(l.api + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    bodies.push(t);
    return { status: r.status, body: t ? JSON.parse(t) : null };
  };
  return { ...l, store, raw, bodies };
}

async function run(l: Awaited<ReturnType<typeof server>>) {
  const card = l.engine.kanban.create({ title: 'secrets', assignee: 'atlas' }, 'user');
  l.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
  l.engine.runner.wake(card.id);
  await l.engine.runner.settled(card.id);
  return card;
}

describe('server secrets (secrets.enc)', () => {
  it('API: first password creates the file, lock now, unlock (wrong = 403 after the delay), change the password; no value or password ever comes back', async () => {
    const l = await server([], { failDelayMs: 200 });
    const events: ServerEvent[] = [];
    l.engine.bus.on((e) => void events.push(e));
    expect((await l.raw('GET', '/secrets/status')).body).toMatchObject({ kind: 'file', exists: false, locked: true });
    // No password yet: writes say what to do.
    const early = await l.raw('PUT', '/secrets/OPENROUTER_KEY', { value: MODEL_KEY });
    expect(early.status).toBe(409);
    expect(early.body.error).toMatch(/no secrets password yet/);
    expect((await l.raw('POST', '/secrets/unlock', { password: PW })).status).toBe(409); // nothing to unlock
    expect((await l.raw('POST', '/secrets/password', { next: 'short' })).status).toBe(400);

    const made = await l.raw('POST', '/secrets/password', { next: PW });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ kind: 'file', exists: true, locked: false, source: 'ui' });
    expect(events.some((e) => e.type === 'secrets.status')).toBe(true);
    expect((await l.raw('POST', '/secrets', { name: 'S_B', value: B, grant: 'all' })).status).toBe(201);
    expect((await l.raw('PUT', '/secrets/OPENROUTER_KEY', { value: MODEL_KEY })).status).toBe(204);

    const locked = await l.raw('POST', '/secrets/lock');
    expect(locked.body).toMatchObject({ locked: true, source: null });
    // Locked: the list still has names and metadata, writes stop with the clear error.
    const list = (await l.raw('GET', '/secrets')).body as SecretList;
    expect(list.status.locked).toBe(true);
    expect(list.secrets.find((s: SecretInfo) => s.name === 'S_B')).toMatchObject({ kind: 'agent', grant: 'all', hasValue: true });
    expect(list.secrets.find((s: SecretInfo) => s.name === 'OPENROUTER_KEY')).toMatchObject({ kind: 'model_key', hasValue: true });
    for (const [m, p, b] of [
      ['POST', '/secrets', { name: 'S_NEW', value: 'new-value-1234567' }],
      ['PUT', '/secrets/S_B', { value: 'rotated-value-123456' }],
      ['DELETE', '/secrets/S_B', undefined],
    ] as const) {
      const r = await l.raw(m, p, b);
      expect(r.status, `${m} ${p}`).toBe(409);
      expect(r.body.error).toBe(SECRETS_LOCKED);
    }
    expect((await l.raw('GET', '/secrets')).body.secrets.map((s: SecretInfo) => s.name).sort()).toEqual(['OPENROUTER_KEY', 'S_B']);

    const t0 = Date.now();
    const wrong = await l.raw('POST', '/secrets/unlock', { password: 'guess-guess' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('wrong secrets password');
    expect((await l.raw('GET', '/secrets/status')).body.locked).toBe(true);
    const ok = await l.raw('POST', '/secrets/unlock', { password: PW });
    expect(ok.body).toMatchObject({ locked: false, source: 'ui' });

    expect((await l.raw('POST', '/secrets/password', { next: 'another password' })).status).toBe(409); // current needed
    expect((await l.raw('POST', '/secrets/password', { current: 'guess-guess', next: 'another password' })).status).toBe(403);
    expect((await l.raw('POST', '/secrets/password', { current: PW, next: 'another password' })).status).toBe(200);
    const fresh = new SecretFile(l.store.file, opts);
    await fresh.unlock('another password', 'ui');
    expect(fresh.get('S_B')).toBe(B);

    for (const t of l.bodies) for (const v of [B, MODEL_KEY, PW, 'another password', 'guess-guess']) expect(t).not.toContain(v);
  });

  it('locked: a command using a secret stops with the clear error, one without runs; a model whose key is in the store stops, an env key keeps working; unlock brings both back', async () => {
    const l = await server(
      [
        shell('t1', 'printf "%s" "$S_B" | rev'),
        shell('t2', 'echo plain'),
        text('done'),
        shell('t3', 'printf "%s" "$S_B" | rev'),
        text('done'),
      ],
      { env: { ENV_KEY } },
    );
    await l.raw('POST', '/secrets/password', { next: PW });
    await l.raw('POST', '/secrets', { name: 'S_B', value: B, grant: 'all' });
    await l.raw('PUT', '/secrets/STORE_KEY', { value: MODEL_KEY });
    for (const [id, env] of [['in-store', 'STORE_KEY'], ['in-env', 'ENV_KEY']])
      expect((await l.raw('POST', '/models', { id, provider: 'anthropic', name: 'claude-x', credentialEnv: env })).status).toBe(201);
    expect(() => l.engine.models.provider('in-store')).not.toThrow();

    await l.raw('POST', '/secrets/lock');
    expect(() => l.engine.models.provider('in-store')).toThrow(`model in-store: ${SECRETS_LOCKED}`);
    expect(() => l.engine.models.provider('in-env')).not.toThrow();
    const models = (await l.raw('GET', '/models')).body as { id: string; credentialPresent: boolean }[];
    expect(models.find((m) => m.id === 'in-store')?.credentialPresent).toBe(false);

    await run(l);
    expect(results(l.fake.calls[1]!)[0]).toBe(`${SECRETS_LOCKED} (the command uses $S_B)`);
    expect(results(l.fake.calls[2]!)[0]).toBe('exit 0\nplain\n');

    await l.raw('POST', '/secrets/unlock', { password: PW });
    expect(() => l.engine.models.provider('in-store')).not.toThrow();
    await run(l);
    expect(results(l.fake.calls[4]!)[0]).toBe(`exit 0\n${rev(B)}\n`);
    // The redactor knows the store's values again once unlocked.
    expect(l.engine.secrets.redact(`key=${MODEL_KEY}`).text).toBe('key=[secret STORE_KEY]');
  });

  it('a restart with ATLAS_SECRETS_PASSWORD resumes a run that needs a secret: unlocked before the run, no one types anything', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-srv-'));
    const dbFile = join(dataDir, 'atlas.db');
    const env = { ATLAS_SECRETS_PASSWORD: PW };
    const first = await server([], { dataDir, dbFile, env });
    expect(first.engine.secrets.status()).toMatchObject({ locked: false, source: 'env' });
    expect((await first.raw('POST', '/secrets', { name: 'S_B', value: B, grant: 'all' })).status).toBe(201);
    // The engine dies with a work run in progress (its lease ran out).
    const card = first.engine.kanban.create({ title: 'needs S_B', status: 'running', assignee: 'atlas' }, 'user');
    first.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    first.engine.db
      .prepare("INSERT INTO runs (id, card_id, agent_id, kind, status, started_at) VALUES ('r_dead', ?, 'atlas', 'work', 'running', ?)")
      .run(card.id, new Date().toISOString());
    await first.engine.stop();

    const second = await server([shell('t1', 'printf "%s" "$S_B" | rev'), [{ type: 'tool_use', id: 'c', name: 'task_complete', input: { summary: 'ok' } }]], { dataDir, dbFile, env });
    await eventually(() => expect(second.fake.calls.length).toBeGreaterThanOrEqual(2), { timeout: 8000, what: 'the resumed run to call the model twice' });
    expect(results(second.fake.calls[1]!)[0]).toBe(`exit 0\n${rev(B)}\n`);
    expect((second.engine.secrets.status() as SecretStoreStatus).source).toBe('env');
  });
});
