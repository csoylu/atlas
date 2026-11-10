import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card, ChatGptStatus } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { responsesBody, toResponsesInput } from './providers/chatgpt.ts';

class MemoryStore {
  label = 'test keychain';
  m = new Map<string, string>();
  names = () => [...this.m.keys()];
  get = (n: string) => this.m.get(n);
  set = (n: string, v: string) => void this.m.set(n, v);
  delete = (n: string) => void this.m.delete(n);
}

const AUTH = 'https://auth.test';
const API = 'https://api.test/v1';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
function idToken(claims: Record<string, unknown>, forged = false): string {
  const head = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' }) + '.' + b64(claims);
  return head + '.' + sign('RSA-SHA256', Buffer.from(head), forged ? other : privateKey).toString('base64url');
}
const sse = (events: unknown[]) =>
  new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

/** A fake OpenAI: sign-in endpoints, JWKS, token grants, revocation, models and a scripted /responses. */
function fakeOpenAi(clock: { t: number }) {
  const seen: { url: string; form?: URLSearchParams; body?: Record<string, unknown>; auth?: string | null }[] = [];
  const authorize = new Map<string, URLSearchParams>(); // by state
  let access = 0;
  let refresh = 0;
  const o = {
    seen,
    authorize,
    nonce: '' as string,
    /** What the next /responses calls answer, in order (last one repeats). */
    responses: [] as (() => Response)[],
    refreshFails: null as string | null,
    /** Sign the ID token with another key (a forgery). */
    forge: false,
    idClaims: {} as Record<string, unknown>,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('authorization');
      if (url === AUTH + '/.well-known/openid-configuration')
        return Response.json({ issuer: AUTH, jwks_uri: AUTH + '/jwks', revocation_endpoint: AUTH + '/revoke' });
      if (url === AUTH + '/jwks') return Response.json({ keys: [jwk] });
      if (url === AUTH + '/api/accounts/oauth/token' || url === AUTH + '/revoke') {
        const form = new URLSearchParams(String(init?.body));
        seen.push({ url, form });
        if (url.endsWith('/revoke')) return new Response('', { status: 200 });
        if (form.get('resource') !== 'https://api.openai.com/v1') return Response.json({ error: 'invalid_target' }, { status: 400 });
        if (form.get('grant_type') === 'refresh_token') {
          if (o.refreshFails) return Response.json({ error: o.refreshFails }, { status: 400 });
          return Response.json({ access_token: `at${++access}`, refresh_token: `rt${++refresh}`, expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
        }
        // authorization_code: the PKCE verifier must match the challenge the browser was sent.
        const a = [...authorize.values()].at(-1)!;
        const challenge = createHash('sha256').update(form.get('code_verifier')!).digest('base64url');
        if (challenge !== a.get('code_challenge') || form.get('redirect_uri') !== a.get('redirect_uri')) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const clientId = form.get('client_id')!;
        return Response.json({
          access_token: `at${++access}`,
          refresh_token: `rt${++refresh}`,
          id_token: idToken({ iss: AUTH, aud: clientId, sub: 'user-1', email: 'can@example.com', exp: Math.floor(clock.t / 1000) + 3600, nonce: a.get('nonce'), ...o.idClaims }, o.forge),
          expires_in: 3600,
          scope: String(o.idClaims.scope ?? 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke'),
        });
      }
      if (url === API + '/models')
        return Response.json({ models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' }, { slug: 'internal', visibility: 'hide' }] });
      if (url === API + '/responses') {
        seen.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth });
        const next = o.responses.length > 1 ? o.responses.shift()! : o.responses[0]!;
        return next();
      }
      throw new Error('unexpected fetch ' + url);
    }) as typeof fetch,
  };
  return o;
}

const text = (t: string) => () =>
  sse([
    { type: 'response.output_text.delta', delta: t },
    { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 3 } } },
  ]);

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});
const json = { 'content-type': 'application/json' };

async function setup() {
  const clock = { t: Date.parse('2026-11-10T12:00:00Z') };
  const oa = fakeOpenAi(clock);
  oa.responses = [text('Hello from the plan.')];
  const secrets = new MemoryStore();
  engine = await startEngine({
    dbFile: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    secrets,
    chatgpt: { authBase: AUTH, apiBase: API, fetch: oa.fetch, port: 0, now: () => clock.t },
  });
  const u = engine.url + '/api';
  const status = async () => (await (await fetch(u + '/chatgpt')).json()) as ChatGptStatus;
  /** Start a sign-in and play the browser: OpenAI redirects to Atlas's loopback with these params. */
  const signIn = async (answer: (q: URLSearchParams) => Record<string, string>) => {
    const { url } = (await (await fetch(u + '/chatgpt/login', { method: 'POST' })).json()) as { url: string };
    const q = new URL(url).searchParams;
    oa.authorize.set(q.get('state')!, q);
    const back = new URL(q.get('redirect_uri')!);
    for (const [k, v] of Object.entries(answer(q))) back.searchParams.set(k, v);
    const res = await fetch(back);
    return { q, res, page: await res.text() };
  };
  return { clock, oa, secrets, u, status, signIn };
}

describe('ChatGPT plan (Sign in with ChatGPT)', () => {
  it('registers Atlas under its own name, verifies the ID token, keeps tokens in the keychain only, and reuses the registration', async () => {
    const { oa, secrets, u, status, signIn } = await setup();
    expect(await status()).toMatchObject({ available: true, signedIn: false, pending: false });

    const first = await signIn((q) => ({ code: 'c1', state: q.get('state')!, client_id: 'oaiapp_1' }));
    expect(first.q.get('client_id')).toBe('dynamic_agent_client');
    expect(first.q.get('agent_name_hint')).toBe('Atlas');
    expect(first.q.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(first.q.get('scope')!.split(' ')).toEqual(expect.arrayContaining(['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']));
    expect(first.q.get('resource')).toBe('https://api.openai.com/v1');
    expect(first.q.get('code_challenge_method')).toBe('S256');
    expect(first.q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
    expect(first.res.status).toBe(200);
    expect(first.page).toMatch(/can now use your ChatGPT plan/);
    // The exchange used the issued client id, not the registration entrypoint.
    expect(oa.seen.find((s) => s.form?.get('grant_type') === 'authorization_code')!.form!.get('client_id')).toBe('oaiapp_1');

    const s = await status();
    expect(s).toMatchObject({ signedIn: true, planUsage: true, email: 'can@example.com', showWelcome: true, pending: false });
    expect(JSON.stringify(s)).not.toMatch(/at1|rt1/);
    expect(JSON.parse(secrets.get('CHATGPT_TOKENS')!)).toMatchObject({ access: 'at1', refresh: 'rt1' });
    // Hidden from the key list and the engine environment; can't be overwritten from the keys UI.
    expect(((await (await fetch(u + '/secrets')).json()) as { names: string[] }).names).not.toContain('CHATGPT_TOKENS');
    expect((await fetch(u + '/secrets/CHATGPT_TOKENS', { method: 'PUT', headers: json, body: JSON.stringify({ value: 'x' }) })).status).toBe(409);

    // A later sign-in reuses the issued id and the host id, with hints instead of the name.
    const again = await signIn((q) => ({ code: 'c2', state: q.get('state')! }));
    expect(again.q.get('client_id')).toBe('oaiapp_1');
    expect(again.q.get('agent_name_hint')).toBeNull();
    expect(again.q.get('login_hint')).toBe('can@example.com');
    expect(again.q.get('ext_agent_host_id')).toBe(first.q.get('ext_agent_host_id'));
    expect(again.res.status).toBe(200);

    // Dismissing the one-time notice.
    await fetch(u + '/chatgpt', { method: 'PATCH', headers: json, body: JSON.stringify({ welcomed: true }) });
    expect((await status()).showWelcome).toBe(false);

    // Sign out revokes the refresh token at OpenAI and forgets the tokens.
    await fetch(u + '/chatgpt/logout', { method: 'POST' });
    const rev = oa.seen.find((x) => x.url.endsWith('/revoke'))!;
    expect(rev.form!.get('token')).toBe('rt2');
    expect(rev.form!.get('client_id')).toBe('oaiapp_1');
    expect(secrets.get('CHATGPT_TOKENS')).toBeUndefined();
    expect(await status()).toMatchObject({ signedIn: false, lastError: null });
  });

  it('refuses a callback with the wrong state, a bad nonce, a forged signature, or a declined consent', async () => {
    const { oa, secrets, status, signIn } = await setup();
    // Wrong state: rejected, and the sign-in stays open for the real callback.
    const stray = await signIn(() => ({ code: 'c', state: 'not-it', client_id: 'oaiapp_1' }));
    expect(stray.res.status).toBe(400);
    expect((await status()).pending).toBe(true);

    oa.idClaims = { nonce: 'someone-else' };
    const nonce = await signIn((q) => ({ code: 'c', state: q.get('state')!, client_id: 'oaiapp_1' }));
    expect(nonce.page).toMatch(/nonce mismatch/);
    expect(secrets.get('CHATGPT_TOKENS')).toBeUndefined();

    oa.idClaims = {};
    oa.forge = true;
    const forged = await signIn((q) => ({ code: 'c', state: q.get('state')!, client_id: 'oaiapp_1' }));
    expect(forged.page).toMatch(/signature is invalid/);
    oa.forge = false;

    oa.idClaims = { iss: 'https://evil.test' };
    const iss = await signIn((q) => ({ code: 'c', state: q.get('state')!, client_id: 'oaiapp_1' }));
    expect(iss.page).toMatch(/issuer mismatch/);

    oa.idClaims = {};
    const declined = await signIn((q) => ({ error: 'access_denied', state: q.get('state')! }));
    expect(declined.page).toMatch(/declined/);
    expect(await status()).toMatchObject({ signedIn: false, lastError: 'ChatGPT sign-in was declined.' });

    // Signed in without the plan scope: no requests, and asking again shows the consent screen.
    oa.idClaims = { scope: 'openid profile email offline_access' };
    await signIn((q) => ({ code: 'c', state: q.get('state')!, client_id: 'oaiapp_1' }));
    expect(await status()).toMatchObject({ signedIn: true, planUsage: false });
    expect(engine!.chatgpt.problem()).toMatch(/not allowed/);
    oa.idClaims = {};
    const consent = await signIn((q) => ({ code: 'c', state: q.get('state')! }));
    expect(consent.q.get('prompt')).toBe('consent');
    expect((await status()).planUsage).toBe(true);
  });

  it('dispatches board cards and schedule cards on the plan without an opt-in', async () => {
    const { oa, u, signIn } = await setup();
    await signIn((q) => ({ code: 'c1', state: q.get('state')!, client_id: 'oaiapp_1' }));
    await fetch(u + '/models', { method: 'POST', headers: json, body: JSON.stringify({ id: 'sol', provider: 'chatgpt', name: 'gpt-6.1-sol' }) });
    engine!.agents.update('atlas', { modelId: 'sol' });

    const board = engine!.kanban.create({ title: 'Board work', status: 'ready', assignee: 'atlas' }, 'can');
    await expect.poll(() => engine!.kanban.messages(board.id).find((m) => m.author === 'atlas')?.content, { timeout: 5000 }).toEqual([{ type: 'text', text: 'Hello from the plan.' }]);
    const schedule = engine!.schedules.create({ agentId: 'atlas', kind: 'cron', cron: '0 9 * * *', prompt: 'Scheduled work' }, 'can');
    const scheduled = engine!.schedules.runNow(schedule.id);
    await expect.poll(() => engine!.kanban.messages(scheduled.id).find((m) => m.author === 'atlas')?.content, { timeout: 5000 }).toEqual([{ type: 'text', text: 'Hello from the plan.' }]);
    expect(oa.seen.filter((s) => s.url.endsWith('/responses'))).toHaveLength(2);

    // Usage limits still stop all new work, regardless of how the card was created.
    engine!.db.prepare("UPDATE chatgpt_account SET paused_at = '2026-11-10T12:00:00Z'").run();
    expect(() => engine!.models.provider('sol')).toThrow(/usage limit/);
    expect(engine!.db.prepare('PRAGMA table_info(chatgpt_account)').all()).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'background' })]));
  });

  it('answers direct chats on the plan, allows board work without a separate opt-in, refreshes the token, pauses on the usage limit', async () => {
    const { clock, oa, u, status, signIn } = await setup();
    await signIn((q) => ({ code: 'c1', state: q.get('state')!, client_id: 'oaiapp_1' }));
    expect(((await (await fetch(u + '/chatgpt/models')).json()) as unknown[])).toEqual([{ slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' }]);
    expect((await fetch(u + '/models', { method: 'POST', headers: json, body: JSON.stringify({ id: 'sol', provider: 'chatgpt', name: 'gpt-6.1-sol' }) })).status).toBe(201);
    await fetch(u + '/agents/atlas', { method: 'PATCH', headers: json, body: JSON.stringify({ modelId: 'sol' }) });

    // A direct chat is Can's own activity: answered on the plan.
    const chat = (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as Card;
    await fetch(u + `/cards/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'hi' }) });
    await expect.poll(() => engine!.kanban.messages(chat.id).find((m) => m.author === 'atlas')?.content, { timeout: 5000 }).toEqual([{ type: 'text', text: 'Hello from the plan.' }]);
    const call = oa.seen.find((s) => s.url.endsWith('/responses'))!;
    expect(call.auth).toBe('Bearer at1');
    expect(call.body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] });
    expect(call.body!.instructions).toMatch(/direct chat with Can/);
    expect(call.body).not.toHaveProperty('max_output_tokens');
    expect((call.body!.tools as { type: string; name: string }[])[0]).toMatchObject({ type: 'namespace', name: 'atlas' });

    // No background setting in the API; board work uses exactly the same signed-in plan.
    expect(await status()).not.toHaveProperty('background');
    expect((await fetch(u + '/chatgpt', { method: 'PATCH', headers: json, body: JSON.stringify({ background: true }) })).status).toBe(400);
    expect(() => engine!.models.provider('sol')).not.toThrow();

    // Near expiry, the next call renews the token first (rotating refresh token) and uses the new one.
    clock.t += 58 * 60_000;
    oa.responses = [text('Still here.')];
    await fetch(u + `/cards/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'again' }) });
    await expect.poll(() => oa.seen.filter((s) => s.url.endsWith('/responses')).length, { timeout: 5000 }).toBe(2);
    expect(oa.seen.find((s) => s.form?.get('grant_type') === 'refresh_token')!.form!.get('refresh_token')).toBe('rt1');
    expect(oa.seen.filter((s) => s.url.endsWith('/responses'))[1]!.auth).toBe('Bearer at2');

    // The usage limit pauses requests (no reset time is given, no other billing is tried) until Can resumes.
    oa.responses = [() => sse([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } }])];
    await expect.poll(() => engine!.kanban.messages(chat.id).filter((m) => m.author === 'atlas').length, { timeout: 5000 }).toBe(2);
    await fetch(u + `/cards/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'one more' }) });
    await expect.poll(async () => (await status()).pausedAt, { timeout: 5000 }).not.toBeNull();
    expect(engine!.runner.runs(chat.id)[0]!.error).toMatch(/usage limit reached.*chatgpt\.com\/settings\/usage/);
    expect(engine!.chatgpt.problem()).toMatch(/usage limit/);
    await fetch(u + '/chatgpt', { method: 'PATCH', headers: json, body: JSON.stringify({ resume: true }) });
    expect(engine!.chatgpt.problem()).toBeNull();

    // A dead refresh token signs out (registration kept) instead of failing forever.
    clock.t += 2 * 3600_000;
    oa.refreshFails = 'refresh_token_expired';
    await expect(engine!.chatgpt.models()).rejects.toThrow(/sign-in expired/);
    expect(await status()).toMatchObject({ signedIn: false });
  });
});

describe('Responses API request format', () => {
  it('sends tool calls and results as function_call items in the atlas namespace', () => {
    const req = {
      model: 'm',
      system: 'sys',
      maxTokens: 100,
      tools: [{ name: 'bash', description: 'run', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'list files' }] },
        {
          role: 'assistant' as const,
          content: [
            { type: 'thinking' as const, thinking: 'hm', signature: 's' },
            { type: 'text' as const, text: 'Looking.' },
            { type: 'tool_use' as const, id: 'call_1', name: 'bash', input: { command: 'ls' } },
          ],
        },
        { role: 'user' as const, content: [{ type: 'tool_result' as const, tool_use_id: 'call_1', content: 'a.txt' }] },
      ],
    };
    expect(toResponsesInput(req)).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'bash', namespace: 'atlas', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
    ]);
    const body = responsesBody(req);
    expect(body).toMatchObject({ instructions: 'sys', store: false, stream: true });
    expect(body).not.toHaveProperty('reasoning');
    expect(responsesBody({ ...req, effort: 'xhigh' })).toMatchObject({ reasoning: { effort: 'xhigh' } });
    expect(body.tools).toEqual([
      expect.objectContaining({ type: 'namespace', name: 'atlas', tools: [{ type: 'function', name: 'bash', description: 'run', parameters: { type: 'object' } }] }),
    ]);
  });
});
