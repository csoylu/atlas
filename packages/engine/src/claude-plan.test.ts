import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudePlanStatus } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { CLAUDE_CODE_CLIENT_ID } from './claude-plan.ts';
import { claudeLimitUntil, claudeQuota } from './plan-accounts.ts';

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

const sseWith = (extra: Record<string, string>, events: unknown[]) =>
  new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream', ...extra },
  });
const answer = (text: string, extra: Record<string, string> = {}) =>
  sseWith(extra, [
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
    messages: [] as ((h: Headers) => Response)[],
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
        const email = form.get('grant_type') === 'authorization_code' && n > 1 ? `user${n}@example.com` : 'user@example.com';
        return Response.json({ access_token: `at${n}`, refresh_token: `rt${n}`, expires_in: 3600, scope: SETTINGS.ATLAS_CLAUDE_SCOPES, account: { email_address: email } });
      }
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      seen.push({ url, headers, body });
      if (url.startsWith('https://api.anthropic.com/v1/models') || url.startsWith(API + '/v1/models')) return Response.json({ data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }] });
      if (url.startsWith('https://api.anthropic.com/v1/messages') || url.startsWith(API + '/v1/messages')) return (o.messages.length > 1 ? o.messages.shift()! : o.messages[0]!)(headers);
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

async function setup(env: Record<string, string> = SETTINGS, o: { dispatch?: boolean; t?: number } = {}) {
  const clock = { t: o.t ?? Date.parse('2026-11-10T12:00:00Z') };
  const an = fakeAnthropic();
  an.messages = [() => answer('Hello from the plan.')];
  const secrets = new MemoryStore();
  engine = await startEngine({
    dbFile: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    secrets,
    dispatch: o.dispatch ?? false,
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
      { model: model.name, maxTokens: 50, system: 'You are atlas, the lead agent.', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [{ name: 'task_list', description: 'List cards', input_schema: { type: 'object', properties: {} } }] },
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

    expect(await status()).toMatchObject({ signedIn: true, email: 'user@example.com', showWelcome: true, pending: false });
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
    expect((req.body!.tools as { name: string }[]).map((t) => t.name)).toEqual(['task_list']);
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
    const err = (await call().then(() => null, (e: unknown) => e)) as { message: string; transient: boolean; retryAt?: string };
    expect(err.message).toMatch(/every Claude subscription reached its usage limit/);
    expect(err).toMatchObject({ transient: true, retryAt: new Date(clock.t + 120_000).toISOString() });
    const paused = await status();
    expect(Date.parse(paused.pausedUntil!)).toBe(clock.t + 120_000);
    expect(() => engine!.models.provider('opus')).toThrow(/work waits until/);
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

  it('pause length: retry-after, else the rejected unified window, else the latest reset header, else a minute', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    const s = (iso: string) => String(Date.parse(iso) / 1000);
    expect(claudeLimitUntil(new Headers({ 'retry-after': '30' }), now) - now).toBe(30_000);
    expect(claudeLimitUntil(new Headers({ 'anthropic-ratelimit-tokens-reset': '2026-11-10T12:05:00Z', 'anthropic-ratelimit-requests-reset': '2026-11-10T12:01:00Z' }), now) - now).toBe(300_000);
    // 5 h window rejected, the weekly one not: pause until the 5 h reset, not the week's.
    const h = new Headers({
      'anthropic-ratelimit-unified-5h-status': 'rejected',
      'anthropic-ratelimit-unified-5h-reset': s('2026-11-10T14:00:00Z'),
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-reset': s('2026-11-16T09:00:00Z'),
    });
    expect(new Date(claudeLimitUntil(h, now)).toISOString()).toBe('2026-11-10T14:00:00.000Z');
    expect(claudeLimitUntil(null, now) - now).toBe(60_000);
  });

  it('reads the 5-hour and weekly windows from the unified headers', () => {
    const now = Date.parse('2026-11-10T12:00:00Z');
    const q = claudeQuota(
      new Headers({
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-5h-utilization': '0.62',
        'anthropic-ratelimit-unified-5h-reset': String(Date.parse('2026-11-10T16:40:00Z') / 1000),
        'anthropic-ratelimit-unified-7d-utilization': '0.81',
        'anthropic-ratelimit-unified-7d-reset': String(Date.parse('2026-11-16T09:00:00Z') / 1000),
      }),
      now,
    );
    expect(q).toEqual({
      fiveHour: { usedPct: 62, resetsAt: '2026-11-10T16:40:00.000Z' },
      week: { usedPct: 81, resetsAt: '2026-11-16T09:00:00.000Z' },
      status: 'allowed',
      at: '2026-11-10T12:00:00.000Z',
    });
    expect(claudeQuota(new Headers({ 'content-type': 'text/event-stream' }), now)).toBeNull();
  });

  it('fails over to the next subscription on a usage limit, notifies the user, and waits for the earliest reset when all are out', async () => {
    const t0 = Math.floor(Date.now() / 1000) * 1000;
    const { an, u, status, clock } = await setup({}, { dispatch: true, t: t0 });
    const j = { 'content-type': 'application/json' };
    const complete = async (accountId?: string) => {
      const { url } = (await (await fetch(u + '/claude/login', { method: 'POST', headers: j, body: JSON.stringify({ accountId }) })).json()) as { url: string };
      const state = new URL(url).searchParams.get('state');
      const res = await fetch(u + '/claude/complete', { method: 'POST', headers: j, body: JSON.stringify({ code: 'c#' + state }) });
      expect(res.status).toBe(200);
    };
    await complete(); // the first sign-in makes « Main »
    const created = (await (await fetch(u + '/plan-accounts', { method: 'POST', headers: j, body: JSON.stringify({ provider: 'claude_plan', label: 'Work' }) })).json()) as ClaudePlanStatus;
    const work = created.accounts.find((a) => a.label === 'Work')!;
    await complete(work.id);
    const s0 = await status();
    expect(s0.accounts.map((a) => [a.label, a.signedIn, a.email])).toEqual([
      ['Main', true, 'user@example.com'],
      ['Work', true, 'user2@example.com'],
    ]);
    const main = s0.accounts[0]!;
    engine!.models.create({ id: 'opus', provider: 'claude_plan', name: 'claude-opus-5' });
    engine!.agents.update('atlas', { modelId: 'opus' });

    const secs = (ms: number) => String(Math.floor(ms / 1000));
    const mainReset = clock.t + 2 * 3600_000;
    const limited = (reset: number) => () =>
      Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } }, {
        status: 429,
        headers: {
          'anthropic-ratelimit-unified-status': 'rejected',
          'anthropic-ratelimit-unified-5h-status': 'rejected',
          'anthropic-ratelimit-unified-5h-utilization': '1.0',
          'anthropic-ratelimit-unified-5h-reset': secs(reset),
          'anthropic-ratelimit-unified-7d-utilization': '0.4',
          'anthropic-ratelimit-unified-7d-reset': secs(clock.t + 5 * 86_400_000),
        },
      });
    // Main (token at1) is out; Work (at2) answers and reports its windows.
    an.messages = [
      (h) =>
        h.get('authorization') === 'Bearer at1'
          ? limited(mainReset)()
          : answer('From Work.', {
              'anthropic-ratelimit-unified-status': 'allowed',
              'anthropic-ratelimit-unified-5h-utilization': '0.62',
              'anthropic-ratelimit-unified-5h-reset': secs(clock.t + 3600_000),
              'anthropic-ratelimit-unified-7d-utilization': '0.81',
              'anthropic-ratelimit-unified-7d-reset': secs(clock.t + 4 * 86_400_000),
            }),
    ];
    const chat = (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as { id: string };
    await fetch(u + `/cards/${chat.id}/messages`, { method: 'POST', headers: j, body: JSON.stringify({ text: 'hi' }) });
    await expect.poll(() => engine!.kanban.messages(chat.id).find((m) => m.author === 'atlas')?.content, { timeout: 5000 }).toEqual([{ type: 'text', text: 'From Work.' }]);
    const auths = an.seen.filter((r) => r.url.includes('/v1/messages')).map((r) => r.headers.get('authorization'));
    expect(auths).toEqual(['Bearer at1', 'Bearer at2']);

    expect(engine!.notifications.list()).toMatchObject([{ kind: 'plan.switched', title: 'Claude · Main reached its usage limit', body: expect.stringContaining('Work moved to Work') }]);
    const s1 = await status();
    expect(s1.accounts[0]).toMatchObject({ id: main.id, paused: true, pausedUntil: new Date(mainReset).toISOString(), quota: { fiveHour: { usedPct: 100 }, status: 'rejected' } });
    expect(s1.accounts[1]).toMatchObject({ paused: false, quota: { fiveHour: { usedPct: 62 }, week: { usedPct: 81 }, status: 'allowed' } });
    expect(s1.pausedUntil).toBeNull();
    // The composer's gauge: the subscription that answered this chat, with its windows.
    const usage = (await (await fetch(u + `/cards/${chat.id}/usage`)).json()) as { plan: { label: string; quota: { fiveHour: { usedPct: number } } } };
    expect(usage.plan).toMatchObject({ label: 'Work', quota: { fiveHour: { usedPct: 62 } } });

    // Work runs out too: the card waits until the earliest reset (Work's, before Main's) and shows the time.
    const workReset = clock.t + 3600_000;
    an.messages = [limited(workReset)];
    const card = engine!.kanban.create({ title: 'Board work', status: 'ready', assignee: 'atlas' }, 'user');
    // Not the user's problem (#131): it waits in todo with the retry time, not blocked.
    await expect.poll(() => engine!.kanban.get(card.id).retry, { timeout: 5000 }).not.toBeNull();
    const blocked = engine!.kanban.get(card.id);
    expect(blocked).toMatchObject({ status: 'todo', block: null, retry: { at: new Date(workReset).toISOString() } });
    expect(blocked.retry!.reason).toMatch(/every Claude subscription reached its usage limit \(Main, Work\); work waits until/);
    expect(blocked.waiting).toMatch(/^retrying at /);
    expect(engine!.notifications.list()[0]).toMatchObject({ kind: 'plan.exhausted' });
    expect((await status()).pausedUntil).toBe(new Date(workReset).toISOString());
    // Only Work was tried: Main is still paused.
    expect(an.seen.filter((r) => r.url.includes('/v1/messages')).map((r) => r.headers.get('authorization')).slice(2)).toEqual(['Bearer at2']);
  });

  it('a web search replays only through the subscription that ran it: after a failover it goes as text (#173)', async () => {
    const { an, u } = await setup({}, { dispatch: true });
    const j = { 'content-type': 'application/json' };
    const complete = async (accountId?: string) => {
      const { url } = (await (await fetch(u + '/claude/login', { method: 'POST', headers: j, body: JSON.stringify({ accountId }) })).json()) as { url: string };
      const state = new URL(url).searchParams.get('state');
      expect((await fetch(u + '/claude/complete', { method: 'POST', headers: j, body: JSON.stringify({ code: 'c#' + state }) })).status).toBe(200);
    };
    await complete();
    const created = (await (await fetch(u + '/plan-accounts', { method: 'POST', headers: j, body: JSON.stringify({ provider: 'claude_plan', label: 'Work' }) })).json()) as ClaudePlanStatus;
    const [main, work] = [created.accounts[0]!, created.accounts.find((a) => a.label === 'Work')!];
    await complete(work.id);
    engine!.models.create({ id: 'opus', provider: 'claude_plan', name: 'claude-opus-5' });
    engine!.agents.update('atlas', { modelId: 'opus' });
    const results = [{ type: 'web_search_result', url: 'https://ex.com/a', title: 'A', encrypted_content: 'EncByMain', page_age: null }];
    const searched = () =>
      sseWith({}, [
        { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"atlas"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: results } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Found A.' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]);
    an.messages = [() => searched()];
    const chat = (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as { id: string };
    const say = (text: string) => fetch(u + `/cards/${chat.id}/messages`, { method: 'POST', headers: j, body: JSON.stringify({ text }) });
    await say('look it up');
    await expect.poll(() => engine!.kanban.messages(chat.id).filter((m) => m.author === 'atlas').length, { timeout: 5000 }).toBe(1);
    expect(engine!.kanban.messages(chat.id).find((m) => m.author === 'atlas')!.content[1]).toEqual({ type: 'web_search_tool_result', tool_use_id: 'srv_1', content: results, origin: `plan:${main.id}` });

    // Main answers again: the search goes exactly as Anthropic sent it. Then Main is out and Work answers: as text.
    an.messages = [() => answer('Again from Main.')];
    await say('more');
    await expect.poll(() => engine!.kanban.messages(chat.id).filter((m) => m.author === 'atlas').length, { timeout: 5000 }).toBe(2);
    an.messages = [
      (h) =>
        h.get('authorization') === 'Bearer at1'
          ? Response.json({ type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } }, { status: 429, headers: { 'retry-after': '3600' } })
          : answer('From Work.'),
    ];
    await say('and now?');
    await expect.poll(() => engine!.kanban.messages(chat.id).filter((m) => m.author === 'atlas').length, { timeout: 5000 }).toBe(3);
    const sent = an.seen.filter((r) => r.url.includes('/v1/messages')).map((r) => ({ auth: r.headers.get('authorization'), msgs: r.body!.messages as { content: unknown[] }[] }));
    // (The chat's naming call may come in between: the turns are found by what they send.)
    const turn = (auth: string, last: string) => sent.find((r) => r.auth === auth && r.msgs.length > 1 && JSON.stringify(r.msgs.at(-1)).includes(last))!.msgs;
    expect(turn('Bearer at1', 'more')[1]!.content.slice(0, 2)).toEqual([
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'atlas' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: results },
    ]);
    const fromWork = turn('Bearer at2', 'and now?');
    expect(JSON.stringify(fromWork)).not.toContain('EncByMain');
    expect(fromWork[1]!.content.slice(0, 2)).toEqual([
      { type: 'text', text: '(searched the web: {"query":"atlas"})' },
      { type: 'text', text: '(web search: 1 results: A <https://ex.com/a>; results omitted to fit the context)' },
    ]);
  });

  it('keeps several subscriptions apart: own keychain entry, order, rename, remove; one account cannot be signed in twice', async () => {
    const { u, status, secrets } = await setup({});
    const j = { 'content-type': 'application/json' };
    const signIn = async (accountId?: string) => {
      const { url } = (await (await fetch(u + '/claude/login', { method: 'POST', headers: j, body: JSON.stringify({ accountId }) })).json()) as { url: string };
      return fetch(u + '/claude/complete', { method: 'POST', headers: j, body: JSON.stringify({ code: 'c#' + new URL(url).searchParams.get('state') }) });
    };
    await signIn();
    const add = async (label: string) =>
      ((await (await fetch(u + '/plan-accounts', { method: 'POST', headers: j, body: JSON.stringify({ provider: 'claude_plan', label }) })).json()) as ClaudePlanStatus).accounts.find((a) => a.label === label)!;
    const work = await add('Work');
    expect((await fetch(u + '/plan-accounts', { method: 'POST', headers: j, body: JSON.stringify({ provider: 'claude_plan', label: 'work' }) })).status).toBe(409);
    expect((await signIn(work.id)).status).toBe(200);
    expect([...secrets.m.keys()].sort()).toEqual(['CLAUDE_TOKENS', 'CLAUDE_TOKENS_' + work.id.slice(3).toUpperCase()]);
    // Token entries stay hidden from the key list.
    expect(((await (await fetch(u + '/secrets')).json()) as { names: string[] }).names).toEqual([]);

    const [main] = (await status()).accounts;
    await fetch(u + '/plan-accounts/order', { method: 'PUT', headers: j, body: JSON.stringify({ provider: 'claude_plan', ids: [work.id, main!.id] }) });
    await fetch(u + `/plan-accounts/${main!.id}`, { method: 'PATCH', headers: j, body: JSON.stringify({ label: 'Personal' }) });
    expect((await status()).accounts.map((a) => a.label)).toEqual(['Work', 'Personal']);

    await fetch(u + `/plan-accounts/${work.id}`, { method: 'DELETE' });
    expect((await status()).accounts.map((a) => a.label)).toEqual(['Personal']);
    expect([...secrets.m.keys()]).toEqual(['CLAUDE_TOKENS']);
  });
});
