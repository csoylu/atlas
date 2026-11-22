import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GeminiPlanStatus } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { GOOGLE_TOKEN_URL, GOOGLE_USERINFO_URL, resetIn } from './gemini-plan.ts';

class MemoryStore {
  label = 'test keychain';
  m = new Map<string, string>();
  names = () => [...this.m.keys()];
  get = (n: string) => this.m.get(n);
  set = (n: string, v: string) => void this.m.set(n, v);
  delete = (n: string) => void this.m.delete(n);
}

const ENDPOINT = 'https://cc.test';

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const answer = (text: string) =>
  sse([
    {
      response: {
        candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
      },
    },
  ]);

/** A fake Google + Cloud Code: OAuth grants, user info, project discovery, catalog, and scripted answers. */
function fakeGoogle() {
  const seen: { url: string; form?: URLSearchParams; json?: Record<string, unknown>; headers: Headers }[] = [];
  let n = 0;
  const o = {
    seen,
    load: {} as Record<string, unknown>,
    onboard: { done: true, response: { cloudaicompanionProject: 'proj-1' } } as Record<string, unknown>,
    answers: [] as (() => Response)[],
    refreshFails: null as string | null,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      if (url === GOOGLE_TOKEN_URL || url === 'https://oauth2.googleapis.com/revoke') {
        const form = new URLSearchParams(String(init?.body));
        seen.push({ url, form, headers });
        if (url.endsWith('/revoke')) return new Response('', { status: 200 });
        if (form.get('grant_type') === 'refresh_token' && o.refreshFails) return Response.json({ error: o.refreshFails }, { status: 400 });
        n++;
        return Response.json({ access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: 3600, scope: 'cloud-platform' });
      }
      if (url.startsWith(GOOGLE_USERINFO_URL)) {
        seen.push({ url, headers });
        return Response.json({ email: 'can@example.com' });
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      seen.push({ url, json: body, headers });
      if (url === ENDPOINT + '/v1internal:loadCodeAssist') return Response.json(o.load);
      if (url === ENDPOINT + '/v1internal:onboardUser') return Response.json(o.onboard);
      if (url === ENDPOINT + '/v1internal:fetchAvailableModels')
        return Response.json({
          models: {
            'gemini-4-neon': { displayName: 'Gemini 4 Neon', maxTokens: 1_000_000 },
            'gemini-off': { displayName: 'Off', disabled: true },
            'claude-x': { displayName: 'Claude through Antigravity' },
          },
        });
      if (url.startsWith(ENDPOINT + '/v1internal:streamGenerateContent')) return (o.answers.length > 1 ? o.answers.shift()! : o.answers[0]!)();
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  };
  return o;
}

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});

async function setup(env: NodeJS.ProcessEnv = { ATLAS_GEMINI_CLIENT_ID: 'atlas-client', ATLAS_GEMINI_CLIENT_SECRET: 'atlas-secret' }) {
  const clock = { t: Date.parse('2026-11-20T12:00:00Z') };
  const g = fakeGoogle();
  g.answers = [() => answer('Hello from the Gemini plan.')];
  const secrets = new MemoryStore();
  engine = await startEngine({
    dbFile: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    secrets,
    dispatch: false,
    env,
    gemini: { fetch: g.fetch, now: () => clock.t, port: 0, endpoint: ENDPOINT },
  });
  const u = engine.url + '/api';
  const status = async () => (await (await fetch(u + '/gemini')).json()) as GeminiPlanStatus;
  const login = async () => (await (await fetch(u + '/gemini/login', { method: 'POST' })).json()) as { url: string };
  const signIn = async () => {
    const { url } = await login();
    const q = new URL(url).searchParams;
    const redirect = new URL(q.get('redirect_uri')!);
    const res = await fetch(`http://127.0.0.1:${redirect.port}/oauth-callback?code=code-1&state=${q.get('state')!}`);
    return { q, ok: res.ok };
  };
  const call = async () => {
    const { model, provider } = engine!.models.provider('gemini');
    return provider.complete(
      { model: model.name, maxTokens: 50, system: 'You are atlas.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] },
      () => {},
      AbortSignal.timeout(5000),
    );
  };
  return { clock, g, secrets, u, status, login, signIn, call };
}

describe('Gemini plan (Antigravity quota)', () => {
  it('refuses to sign in until the OAuth client is entered', async () => {
    const { status, u } = await setup({});
    const s = await status();
    expect(s.configured).toBe(false);
    expect(s.configProblems).toHaveLength(2);
    const res = await fetch(u + '/gemini/login', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('OAuth client ID');
  });

  it('builds the Antigravity OAuth URL out of the box', async () => {
    const { login, status } = await setup();
    expect((await status()).available).toBe(true);
    const { url } = await login();
    const q = new URL(url).searchParams;
    expect(q.get('client_id')).toBe('atlas-client');
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/oauth-callback$/);
    expect(q.get('scope')).toContain('https://www.googleapis.com/auth/cloud-platform');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBeTruthy();
  });

  it('exchanges the code on the loopback callback, keeps tokens, resolves the project and imports models', async () => {
    const { g, secrets, signIn, status, u } = await setup();
    const { ok } = await signIn();
    expect(ok).toBe(true);

    const s = await status();
    expect(s).toMatchObject({ signedIn: true, email: 'can@example.com', project: 'proj-1', pausedUntil: null });
    expect(JSON.parse(secrets.get('GEMINI_TOKENS')!)).toEqual({ access: 'at1', refresh: 'rt1' });

    const tokenCall = g.seen.find((x) => x.form?.get('grant_type') === 'authorization_code')!;
    expect(tokenCall.form!.get('code')).toBe('code-1');
    expect(tokenCall.form!.get('code_verifier')).toBeTruthy();
    expect(tokenCall.form!.get('client_secret')).toBe('atlas-secret');

    const models = (await (await fetch(u + '/gemini/models')).json()) as { id: string; displayName: string; contextWindow: number }[];
    expect(models).toEqual([{ id: 'gemini-4-neon', displayName: 'Gemini 4 Neon', contextWindow: 1_000_000 }]);
  });

  it('runs agent calls through Cloud Code with the plan’s token and project', async () => {
    const { g, signIn, u, call } = await setup();
    await signIn();
    await fetch(u + '/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'gemini', provider: 'gemini_plan', name: 'gemini-4-neon' }),
    });

    const out = await call();
    expect(out.content).toEqual([{ type: 'text', text: 'Hello from the Gemini plan.' }]);

    const req = g.seen.find((x) => x.url.includes('/v1internal:streamGenerateContent'))!;
    expect(req.headers.get('authorization')).toBe('Bearer at1');
    expect(req.headers.get('user-agent')).toMatch(/^antigravity\/hub\//);
    expect(req.json).toMatchObject({ project: 'proj-1', model: 'gemini-4-neon', requestType: 'agent', userAgent: 'antigravity' });
  });

  it('provisions a project when loadCodeAssist returns none', async () => {
    const { g, signIn, status } = await setup();
    g.load = { allowedTiers: [{ id: 'free-tier', isDefault: true }] };
    await signIn();
    expect((await status()).project).toBe('proj-1');
    const onboard = g.seen.find((x) => x.url.endsWith('/v1internal:onboardUser'))!;
    expect(onboard.json).toMatchObject({ tier_id: 'free-tier' });
  });

  it('refreshes near expiry, pauses on 429 until the reset, and signs out on 401', async () => {
    const { clock, g, secrets, signIn, status, u, call } = await setup();
    await signIn();
    await fetch(u + '/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'gemini', provider: 'gemini_plan', name: 'gemini-4-neon' }),
    });

    clock.t += 58 * 60_000; // 2 min left: refresh
    await call();
    expect(g.seen.filter((x) => x.form?.get('grant_type') === 'refresh_token')).toHaveLength(1);
    expect(g.seen.filter((x) => x.url.includes('streamGenerateContent')).at(-1)!.headers.get('authorization')).toBe('Bearer at2');
    expect(JSON.parse(secrets.get('GEMINI_TOKENS')!)).toEqual({ access: 'at2', refresh: 'rt2' });

    g.answers = [() => Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, { status: 429, headers: { 'retry-after': '120' } })];
    await expect(call()).rejects.toThrow(/limit reached/);
    const paused = await status();
    expect(Date.parse(paused.pausedUntil!)).toBe(clock.t + 120_000);
    clock.t += 121_000;
    expect((await status()).pausedUntil).toBeNull();

    g.answers = [() => Response.json({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'bad token' } }, { status: 401 })];
    await expect(call()).rejects.toThrow(/sign in again/);
    expect(secrets.get('GEMINI_TOKENS')).toBeUndefined();
    expect((await status()).signedIn).toBe(false);
  });

  it('a dead refresh token signs out; sign-out revokes at Google', async () => {
    const { clock, g, secrets, signIn, status, u, call } = await setup();
    await signIn();
    await fetch(u + '/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'gemini', provider: 'gemini_plan', name: 'gemini-4-neon' }),
    });

    await fetch(u + '/gemini/logout', { method: 'POST' });
    expect(g.seen.find((x) => x.url === 'https://oauth2.googleapis.com/revoke')).toBeDefined();
    expect(secrets.get('GEMINI_TOKENS')).toBeUndefined();

    await signIn();
    g.refreshFails = 'invalid_grant';
    clock.t += 59 * 60_000;
    await expect(call()).rejects.toThrow(/invalid_grant/);
    expect((await status()).signedIn).toBe(false);
  });

  it('pause length: retry-after, else Google’s RetryInfo, else a minute', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    expect(resetIn(new Headers({ 'retry-after': '30' }), now)).toBe(30_000);
    expect(resetIn(null, now, JSON.stringify({ error: { details: [{ retryDelay: '37s' }] } }))).toBe(37_000);
    expect(resetIn(null, now)).toBe(60_000);
  });
});
