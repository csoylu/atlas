import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudePlanStatus } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { CLAUDE_CODE_CLIENT_ID, DEFAULT_TOKEN_URLS, resetIn } from './claude-plan.ts';
import { CLAUDE_CODE_SYSTEM_PREFIX } from './providers/anthropic.ts';

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
  ATLAS_CLAUDE_AUTHORIZE_URL: AUTH + '/oauth/authorize',
  ATLAS_CLAUDE_TOKEN_URL: AUTH + '/oauth/token',
  ATLAS_CLAUDE_REVOKE_URL: AUTH + '/oauth/revoke',
  ATLAS_CLAUDE_API_BASE: API,
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
  const seen: { url: string; form?: URLSearchParams; json?: Record<string, unknown>; headers: Headers; body?: Record<string, unknown> }[] = [];
  let n = 0;
  const o = {
    seen,
    messages: [] as (() => Response)[],
    refreshFails: null as string | null,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      if (url === SETTINGS.ATLAS_CLAUDE_TOKEN_URL || url === SETTINGS.ATLAS_CLAUDE_REVOKE_URL || DEFAULT_TOKEN_URLS.includes(url)) {
        let jsonPayload: Record<string, unknown> | undefined;
        let formPayload: URLSearchParams | undefined;
        try {
          jsonPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        } catch {
          formPayload = new URLSearchParams(String(init?.body));
        }
        seen.push({ url, form: formPayload, json: jsonPayload, headers });
        if (url.endsWith('/revoke')) return new Response('', { status: 200 });

        const grantType = jsonPayload?.grant_type ?? formPayload?.get('grant_type');
        if (grantType === 'refresh_token' && o.refreshFails) return Response.json({ error: o.refreshFails }, { status: 400 });
        n++;
        return Response.json({ access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: 3600, scope: 'user:inference', account: { email_address: 'user@claude.ai' } });
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      seen.push({ url, headers, body });
      if (url.startsWith(API + '/v1/models')) return Response.json({ data: [{ id: 'claude-3-7-sonnet-20250219', display_name: 'Claude 3.7 Sonnet' }] });
      if (url.startsWith(API + '/v1/messages')) return (o.messages.length > 1 ? o.messages.shift()! : o.messages[0]!)();
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
  an.messages = [() => answer('Hello from Claude subscription.')];
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
  const login = async () => (await (await fetch(u + '/claude/login', { method: 'POST' })).json()) as { url: string };
  const exchange = async (code: string) => (await (await fetch(u + '/claude/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).json()) as ClaudePlanStatus;
  const setToken = async (token: string, refreshToken?: string) => (await (await fetch(u + '/claude/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, refreshToken }) })).json()) as ClaudePlanStatus;
  const call = async () => {
    const { model, provider } = engine!.models.provider('opus');
    return provider.complete(
      { model: model.name, maxTokens: 50, system: 'You are atlas, the lead agent.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [{ name: 'card_list', description: 'List cards', input_schema: { type: 'object', properties: {} } }] },
      () => {},
      AbortSignal.timeout(5000),
    );
  };
  return { clock, an, secrets, u, status, login, exchange, setToken, call };
}

describe('Claude subscription provider (Hermes agent style direct OAuth)', () => {
  it('is configured and ready to connect out of the box with Hermes defaults', async () => {
    const { status, login } = await setup({});
    const s = await status();
    expect(s.available).toBe(true);
    expect(s.configured).toBe(true);
    expect(s.signedIn).toBe(false);

    const { url } = await login();
    const q = new URL(url).searchParams;
    expect(q.get('client_id')).toBe(CLAUDE_CODE_CLIENT_ID);
    expect(q.get('redirect_uri')).toBe('https://console.anthropic.com/oauth/code/callback');
    expect(q.get('scope')).toBe('org:create_api_key user:profile user:inference');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBeTruthy();
  });

  it('exchanges authorization code via /api/claude/exchange and stores tokens in keychain', async () => {
    const { an, secrets, login, exchange, status, call, u } = await setup();
    const { url } = await login();
    const q = new URL(url).searchParams;
    const state = q.get('state')!;

    const s = await exchange(`test_code_123#${state}`);
    expect(s.signedIn).toBe(true);
    expect(s.email).toBe('user@claude.ai');

    const tokenCall = an.seen.find((x) => x.json?.grant_type === 'authorization_code');
    expect(tokenCall).toBeDefined();
    expect(tokenCall!.headers.get('user-agent')).toBe('axios/1.7.9');
    expect(tokenCall!.json?.code).toBe('test_code_123');

    // Tokens kept in keychain
    expect(JSON.parse(secrets.get('CLAUDE_TOKENS')!)).toEqual({ access: 'at1', refresh: 'rt1' });

    // Models can now be created and called
    await fetch(u + '/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'opus', provider: 'claude_plan', name: 'claude-3-7-sonnet-20250219' }),
    });

    const out = await call();
    expect(out.content).toEqual([{ type: 'text', text: 'Hello from Claude subscription.' }]);

    // Inspect request made to Anthropic
    const req = an.seen.find((x) => x.url.startsWith(API + '/v1/messages'))!;
    expect(req.headers.get('authorization')).toBe('Bearer at1');
    expect(req.headers.get('x-api-key')).toBeNull();
    expect(req.headers.get('user-agent')).toContain('claude-code');
    expect(req.headers.get('x-app')).toBe('cli');
    expect(req.headers.get('anthropic-beta')).toContain('claude-code-20250219');
    expect(req.headers.get('anthropic-beta')).toContain('oauth-2025-04-20');

    // System prompt includes Claude Code system prefix (matching Hermes)
    expect(JSON.stringify(req.body!.system)).toContain(CLAUDE_CODE_SYSTEM_PREFIX);
  });

  it('supports direct token setting (e.g. sk-ant-oat01...)', async () => {
    const { setToken, status, secrets } = await setup();
    const s = await setToken('sk-ant-oat01-manual-token', 'rt-manual');
    expect(s.signedIn).toBe(true);
    expect(JSON.parse(secrets.get('CLAUDE_TOKENS')!)).toEqual({ access: 'sk-ant-oat01-manual-token', refresh: 'rt-manual' });
  });

  it('refreshes near expiry, pauses on 429 until reset, and signs out on 401', async () => {
    const { clock, an, secrets, status, login, exchange, call, u } = await setup();
    const { url } = await login();
    const q = new URL(url).searchParams;
    await exchange(`c1#${q.get('state')!}`);

    await fetch(u + '/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'opus', provider: 'claude_plan', name: 'claude-3-7-sonnet-20250219' }),
    });

    clock.t += 58 * 60_000; // 2 min left: refresh
    await call();
    expect(an.seen.filter((x) => x.json?.grant_type === 'refresh_token')).toHaveLength(1);
    expect(an.seen.at(-1)!.headers.get('authorization')).toBe('Bearer at2');
    expect(JSON.parse(secrets.get('CLAUDE_TOKENS')!)).toEqual({ access: 'at2', refresh: 'rt2' });

    // 429 rate limit
    an.messages = [() => Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }, { status: 429, headers: { 'retry-after': '120' } })];
    await expect(call()).rejects.toThrow(/limit reached/);
    const paused = await status();
    expect(Date.parse(paused.pausedUntil!)).toBe(clock.t + 120_000);
    clock.t += 121_000; // the pause ends by itself
    expect((await status()).pausedUntil).toBeNull();

    // 401 auth error
    an.messages = [() => Response.json({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }, { status: 401 })];
    await expect(call()).rejects.toThrow(/sign in again/);
    expect(secrets.get('CLAUDE_TOKENS')).toBeUndefined();
    expect((await status()).signedIn).toBe(false);
  });

  it('a dead refresh token signs out; sign-out revokes at configured URL', async () => {
    const { clock, an, secrets, status, login, exchange, call, u } = await setup();
    const { url } = await login();
    const q = new URL(url).searchParams;
    await exchange(`c1#${q.get('state')!}`);

    await fetch(u + '/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'opus', provider: 'claude_plan', name: 'claude-3-7-sonnet-20250219' }),
    });

    await fetch(u + '/claude/logout', { method: 'POST' });
    expect(an.seen.find((x) => x.url === SETTINGS.ATLAS_CLAUDE_REVOKE_URL)).toBeDefined();
    expect(secrets.get('CLAUDE_TOKENS')).toBeUndefined();

    // Re-login then test dead refresh token
    const l2 = await login();
    await exchange(`c2#${new URL(l2.url).searchParams.get('state')!}`);
    an.refreshFails = 'invalid_grant';
    clock.t += 59 * 60_000;
    await expect(call()).rejects.toThrow(/invalid_grant/);
    expect(await status()).toMatchObject({ signedIn: false });
  });

  it('pause length: retry-after, else the latest reset header, else a minute', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    expect(resetIn(new Headers({ 'retry-after': '30' }), now)).toBe(30_000);
    expect(resetIn(new Headers({ 'anthropic-ratelimit-tokens-reset': '2026-11-10T12:05:00Z', 'anthropic-ratelimit-requests-reset': '2026-11-10T12:01:00Z' }), now)).toBe(300_000);
    expect(resetIn(null, now)).toBe(60_000);
  });
});
