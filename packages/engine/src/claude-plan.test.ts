import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudePlanStatus } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { CLAUDE_CODE_CLIENT_ID, resetIn } from './claude-plan.ts';

class MemoryStore {
  label = 'test keychain';
  m = new Map<string, string>();
  names = () => [...this.m.keys()];
  get = (n: string) => this.m.get(n);
  set = (n: string, v: string) => void this.m.set(n, v);
  delete = (n: string) => void this.m.delete(n);
}

const AUTH = 'https://login.test';
const API = 'https://api.test';
const SETTINGS = {
  ATLAS_CLAUDE_CLIENT_ID: 'atlas-client-123',
  ATLAS_CLAUDE_CLIENT_SECRET: 'atlas-secret',
  ATLAS_CLAUDE_AUTHORIZE_URL: AUTH + '/oauth/authorize',
  ATLAS_CLAUDE_TOKEN_URL: AUTH + '/oauth/token',
  ATLAS_CLAUDE_REVOKE_URL: AUTH + '/oauth/revoke',
  ATLAS_CLAUDE_SCOPES: 'user:inference user:profile',
  ATLAS_CLAUDE_API_BASE: API,
  ATLAS_CLAUDE_HEADERS: '{"anthropic-beta":"atlas-approved-2026-11"}',
};

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
const answer = (text: string) =>
  sse([
    { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);

/** A fake Anthropic: token grants, revocation, models, and scripted /v1/messages answers. */
function fakeAnthropic() {
  const seen: { url: string; form?: URLSearchParams; headers: Headers; body?: Record<string, unknown> }[] = [];
  let n = 0;
  const o = {
    seen,
    messages: [] as (() => Response)[],
    refreshFails: null as string | null,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      if (url === 'https://platform.claude.com/v1/oauth/token' || url === SETTINGS.ATLAS_CLAUDE_TOKEN_URL || url === SETTINGS.ATLAS_CLAUDE_REVOKE_URL) {
        const form = headers.get('content-type') === 'application/json' ? new URLSearchParams(JSON.parse(String(init?.body))) : new URLSearchParams(String(init?.body));
        seen.push({ url, form, headers });
        if (url.endsWith('/revoke')) return new Response('', { status: 200 });
        if (form.get('client_id') !== CLAUDE_CODE_CLIENT_ID && (form.get('client_id') !== SETTINGS.ATLAS_CLAUDE_CLIENT_ID || form.get('client_secret') !== SETTINGS.ATLAS_CLAUDE_CLIENT_SECRET))
          return Response.json({ error: 'invalid_client' }, { status: 401 });
        if (form.get('grant_type') === 'refresh_token' && o.refreshFails) return Response.json({ error: o.refreshFails }, { status: 400 });
        n++;
        return Response.json({ access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: 3600, scope: SETTINGS.ATLAS_CLAUDE_SCOPES, account: { email_address: 'can@datinel.com' } });
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      seen.push({ url, headers, body });
      if (url.startsWith('https://api.anthropic.com/v1/models') || url.startsWith(API + '/v1/models')) return Response.json({ data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }] });
      if (url.startsWith('https://api.anthropic.com/v1/messages') || url.startsWith(API + '/v1/messages')) return (o.messages.length > 1 ? o.messages.shift()! : o.messages[0]!)();
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

async function setup(env: Record<string, string> = SETTINGS) {
  const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  const an = fakeAnthropic();
  an.messages = [() => answer('Hello from the plan.')];
  const secrets = new MemoryStore();
  engine = await startEngine({
    dbFile: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    secrets,
    dispatch: false,
    env: { ...env },
    claude: { fetch: an.fetch, now: () => clock.t },
  });
  const u = engine.url + '/api';
  const status = async () => (await (await fetch(u + '/claude')).json()) as ClaudePlanStatus;
  const signIn = async (back: (q: URLSearchParams) => Record<string, string> = (q) => ({ code: 'c1', state: q.get('state')! })) => {
    const res0 = await fetch(u + '/claude/login', { method: 'POST' });
    const { url } = (await res0.json()) as { url: string };
    const q = new URL(url).searchParams;
    const cb = new URL(q.get('redirect_uri')!);
    for (const [k, v] of Object.entries(back(q))) cb.searchParams.set(k, v);
    const res = await fetch(cb);
    return { url, q, res, page: await res.text() };
  };
  const call = async () => {
    const { model, provider } = engine!.models.provider('opus');
    return provider.complete(
      { model: model.name, maxTokens: 50, system: 'You are atlas, the lead agent.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [{ name: 'card_list', description: 'List cards', input_schema: { type: 'object', properties: {} } }] },
      () => {},
      AbortSignal.timeout(5000),
    );
  };
  return { clock, an, secrets, u, status, signIn, call };
}

describe('Claude plan (Atlas’s own approved OAuth client)', () => {
  it('has subscription defaults without any configuration and validates pasted state', async () => {
    const { u, status } = await setup({});
    expect(await status()).toMatchObject({ configured: true, signedIn: false, configProblems: [] });
    const res = await fetch(u + '/claude/login', { method: 'POST' });
    expect(res.status).toBe(200);
    const { url } = await res.json() as { url: string };
    const q = new URL(url).searchParams;
    expect(q.get('client_id')).toBe(CLAUDE_CODE_CLIENT_ID);
    expect(q.get('redirect_uri')).toBe('https://console.anthropic.com/oauth/code/callback');
    const bad = await fetch(u + '/claude/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'bad#wrong-state' }) });
    expect(bad.status).toBe(409);
    expect((await status()).pending).toBe(true);
  });

  it('completes built-in subscription OAuth, calls with client identity and refreshes JSON tokens', async () => {
    const { u, an, status, secrets, clock, call } = await setup({});
    const login = await (await fetch(u + '/claude/login', { method: 'POST' })).json() as { url: string };
    const q = new URL(login.url).searchParams;
    const result = await fetch(u + '/claude/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'code1#' + q.get('state') }) });
    expect(result.status).toBe(200);
    expect(await status()).toMatchObject({ signedIn: true, pending: false });
    expect(secrets.m.size).toBe(1);
    const grant = an.seen[0]!;
    expect(grant.headers.get('content-type')).toBe('application/json');
    expect(grant.form!.get('state')).toBe(q.get('state'));
    expect(createHash('sha256').update(grant.form!.get('code_verifier')!).digest('base64url')).toBe(q.get('code_challenge'));
    engine!.models.create({ id: 'opus', provider: 'claude_plan', name: 'claude-opus-5-5' });
    await call();
    const req = an.seen.find((r) => r.url.includes('/v1/messages'))!;
    expect(req.headers.get('authorization')).toBe('Bearer at1');
    expect(req.headers.get('x-api-key')).toBeNull();
    expect(req.headers.get('user-agent')).toContain('claude-code/2.1.322');
    expect(req.headers.get('x-app')).toBe('cli');
    expect(req.headers.get('anthropic-beta')).toContain('claude-code-20250219');
    expect(JSON.stringify(req.body!.system)).toContain("You are Claude Code, Anthropic's official CLI for Claude.");
    clock.t += 56 * 60_000;
    await call();
    expect(an.seen.filter((r) => r.form?.get('grant_type') === 'refresh_token')).toHaveLength(1);
    await fetch(u + '/claude/logout', { method: 'POST' });
    expect((await status()).signedIn).toBe(false);
    expect(secrets.m.size).toBe(0);
  });

  it('rejects overrides of authentication headers', async () => {
    const { status } = await setup({ ...SETTINGS, ATLAS_CLAUDE_HEADERS: '{"Authorization":"bad"}' });
    expect((await status()).configured).toBe(false);
  });

  it('signs in with PKCE, keeps tokens in the keychain only, and calls the API as Atlas with a bearer token', async () => {
    const { an, secrets, u, status, signIn, call } = await setup();
    const { q, res, page } = await signIn();
    expect(q.get('client_id')).toBe('atlas-client-123');
    expect(q.get('scope')).toBe('user:inference user:profile');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(res.status).toBe(200);
    expect(page).toContain('Connected to Claude');
    const grant = an.seen.find((s) => s.form?.get('grant_type') === 'authorization_code')!;
    expect(createHash('sha256').update(grant.form!.get('code_verifier')!).digest('base64url')).toBe(q.get('code_challenge'));
    expect(grant.form!.get('redirect_uri')).toBe(q.get('redirect_uri'));

    expect(await status()).toMatchObject({ signedIn: true, email: 'can@datinel.com', showWelcome: true, pending: false });
    expect(JSON.parse(secrets.get('CLAUDE_TOKENS')!)).toEqual({ access: 'at1', refresh: 'rt1' });
    // Tokens never leave the keychain: not in the secrets list, not in the engine env.
    expect(((await (await fetch(u + '/secrets')).json()) as { names: string[] }).names).not.toContain('CLAUDE_TOKENS');
    expect((await fetch(u + '/secrets/CLAUDE_TOKENS', { method: 'DELETE' })).status).toBe(409);

    expect(await (await fetch(u + '/claude/models')).json()).toEqual([{ id: 'claude-opus-5', displayName: 'Claude Opus 5' }]);
    expect((await fetch(u + '/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'opus', provider: 'claude_plan', name: 'claude-opus-5' }) })).status).toBe(201);
    expect(engine!.models.get('opus').credentialPresent).toBe(true);

    const out = await call();
    expect(out.content).toEqual([{ type: 'text', text: 'Hello from the plan.' }]);
    const req = an.seen.find((s) => s.url.startsWith(API + '/v1/messages'))!;
    expect(req.headers.get('authorization')).toBe('Bearer at1');
    expect(req.headers.get('x-api-key')).toBeNull();
    expect(req.headers.get('anthropic-beta')).toBe('atlas-approved-2026-11');
    expect(req.headers.get('user-agent') ?? '').not.toMatch(/claude-code|claude-cli/i);
    expect(req.headers.get('x-app')).toBeNull();
    // Atlas's own prompt and tool names, untouched.
    expect(JSON.stringify(req.body!.system)).not.toContain('Claude Code');
    expect(JSON.stringify(req.body!.system)).toContain('You are atlas');
    expect((req.body!.tools as { name: string }[]).map((t) => t.name)).toEqual(['card_list']);
  });

  it('refreshes near expiry, pauses on 429 until the reset, and signs out on 401', async () => {
    const { clock, an, secrets, status, signIn, call, u } = await setup();
    await signIn();
    await fetch(u + '/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'opus', provider: 'claude_plan', name: 'claude-opus-5' }) });

    clock.t += 58 * 60_000; // 2 min left: refresh first
    await call();
    expect(an.seen.filter((s) => s.form?.get('grant_type') === 'refresh_token')).toHaveLength(1);
    expect(an.seen.at(-1)!.headers.get('authorization')).toBe('Bearer at2');
    expect(JSON.parse(secrets.get('CLAUDE_TOKENS')!)).toEqual({ access: 'at2', refresh: 'rt2' });

    an.messages = [() => Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }, { status: 429, headers: { 'retry-after': '120' } })];
    await expect(call()).rejects.toThrow(/limit reached/);
    const paused = await status();
    expect(Date.parse(paused.pausedUntil!)).toBe(clock.t + 120_000);
    expect(() => engine!.models.provider('opus')).toThrow(/paused until/);
    clock.t += 121_000; // the pause ends by itself
    expect((await status()).pausedUntil).toBeNull();

    an.messages = [() => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }, { status: 401 })];
    await expect(call()).rejects.toThrow(/sign in again/);
    expect(secrets.get('CLAUDE_TOKENS')).toBeUndefined();
    expect((await status()).signedIn).toBe(false);
  });

  it('a dead refresh token signs out; sign-out revokes at the configured URL', async () => {
    const { clock, an, secrets, status, signIn, call, u } = await setup();
    await signIn();
    await fetch(u + '/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'opus', provider: 'claude_plan', name: 'claude-opus-5' }) });
    await fetch(u + '/claude/logout', { method: 'POST' });
    expect(an.seen.find((s) => s.url === SETTINGS.ATLAS_CLAUDE_REVOKE_URL)!.form!.get('token')).toBe('rt1');
    expect(secrets.get('CLAUDE_TOKENS')).toBeUndefined();

    await signIn();
    an.refreshFails = 'invalid_grant';
    clock.t += 59 * 60_000;
    await expect(call()).rejects.toThrow(/invalid_grant/);
    expect(await status()).toMatchObject({ signedIn: false });
  });

  it('a wrong state leaves the sign-in open; a declined one records why', async () => {
    const { status, signIn } = await setup();
    const bad = await signIn(() => ({ code: 'c', state: 'forged' }));
    expect(bad.res.status).toBe(400);
    expect((await status()).signedIn).toBe(false);
    const declined = await signIn((q) => ({ error: 'access_denied', state: q.get('state')! }));
    expect(declined.page).toContain('declined');
    expect(await status()).toMatchObject({ signedIn: false, pending: false, lastError: 'Claude sign-in was declined.' });
  });

  it('pause length: retry-after, else the latest reset header, else a minute', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    expect(resetIn(new Headers({ 'retry-after': '30' }), now)).toBe(30_000);
    expect(resetIn(new Headers({ 'anthropic-ratelimit-tokens-reset': '2026-11-10T12:05:00Z', 'anthropic-ratelimit-requests-reset': '2026-11-10T12:01:00Z' }), now)).toBe(300_000);
    expect(resetIn(null, now)).toBe(60_000);
  });
});
