import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CLAUDE_PLAN_SETTINGS, UpdateClaudePlan, type ClaudePlanModel, type ClaudePlanSetting, type ClaudePlanStatus } from '@atlas/shared';
import type { Bus } from './events.ts';
import type { SecretStore } from './secrets.ts';
import { ConflictError } from './kanban.ts';
import { ModelError, type Provider } from './providers/types.ts';
import { AnthropicError, AnthropicProvider } from './providers/anthropic.ts';
import { claudeLimitUntil, claudeQuota, PlanLimitError, rawLimitHeaders, type PlanAccounts, type PlanRow } from './plan-accounts.ts';

/**
 * Claude subscription OAuth: PKCE, keychain token storage, refresh and usage-limit handling, for every Claude
 * subscription (plan-accounts.ts: several sign-ins, failover in list order, quotas from each response).
 */
export interface ClaudePlanOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

interface Tokens {
  access: string;
  refresh: string | null;
}
interface Pending {
  accountId: string;
  state: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  server: Server | null;
  timer: NodeJS.Timeout;
}
interface Config {
  clientId: string;
  clientSecret: string | null;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string | null;
  scopes: string;
  port: number;
  apiBase: string;
  headers: Record<string, string>;
}

/** Public subscription OAuth client used by the Claude Code-compatible flow. */
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Headers Atlas sets itself or that identify the calling app: the approval can't override them. */
const RESERVED_HEADERS = new Set(['authorization', 'x-api-key', 'anthropic-version', 'host', 'content-type', 'content-length', 'user-agent', 'x-app']);
export const CLAUDE_SUBSCRIPTION_HEADERS = {
  'user-agent': 'claude-code/2.1.322 (external, cli)',
  'x-app': 'cli',
  'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
};
const SUBSCRIPTION_REDIRECT = 'https://console.anthropic.com/oauth/code/callback';
const DEFAULTS: Partial<Record<ClaudePlanSetting, string>> = {
  ATLAS_CLAUDE_CLIENT_ID: CLAUDE_CODE_CLIENT_ID,
  ATLAS_CLAUDE_AUTHORIZE_URL: 'https://claude.ai/oauth/authorize',
  ATLAS_CLAUDE_TOKEN_URL: 'https://platform.claude.com/v1/oauth/token',
  ATLAS_CLAUDE_SCOPES: 'org:create_api_key user:profile user:inference',
};
const REFRESH_MARGIN_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEAD_REFRESH = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_token', 'refresh_token_reused']);

const b64url = (b: Buffer) => b.toString('base64url');

export class ClaudePlan {
  private pending: Pending | null = null;
  private refreshing = new Map<string, Promise<string>>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(
    private bus: Bus,
    private secrets: SecretStore | undefined,
    /** The engine env (process env + keychain entries), read at every use so new settings apply without restart. */
    private env: NodeJS.ProcessEnv,
    private plans: PlanAccounts,
    o: ClaudePlanOptions = {},
  ) {
    this.fetchFn = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    plans.onChange.claude_plan = () => this.emit();
  }

  private rows(): PlanRow[] {
    return this.plans.rows('claude_plan');
  }
  private tokens(r: PlanRow): Tokens | null {
    return this.plans.tokens<Tokens>(r);
  }
  /** Tokens issued to another client id don't count: changing the client id means signing in again. */
  private signedIn(r: PlanRow, config = this.config().config): boolean {
    return !!this.tokens(r) && !!r.client_id && (!config || config.clientId === r.client_id);
  }
  private emit(): void {
    this.bus.emit({ type: 'claude.updated', status: this.status() });
  }
  /** A setting changed (keychain entry set or removed): tell the UI. */
  notify(): void {
    this.emit();
  }
  private setting(n: ClaudePlanSetting): string | null {
    const v = this.env[n]?.trim();
    return v || DEFAULTS[n] || null;
  }

  /** The settings, checked. Problems are listed for Settings → Subscriptions; config is null until there are none. */
  private config(): { config: Config | null; problems: string[] } {
    const problems: string[] = [];
    for (const s of CLAUDE_PLAN_SETTINGS) if (s.required && !this.setting(s.name)) problems.push(`${s.label} is not set (${s.name}).`);
    const clientId = this.setting('ATLAS_CLAUDE_CLIENT_ID');
    const url = (n: ClaudePlanSetting): string | null => {
      const v = this.setting(n);
      if (!v) return null;
      try {
        const u = new URL(v);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
          problems.push(`${n} must be an https URL.`);
      } catch {
        problems.push(`${n} is not a URL.`);
      }
      return v;
    };
    const authorizeUrl = url('ATLAS_CLAUDE_AUTHORIZE_URL');
    const tokenUrl = url('ATLAS_CLAUDE_TOKEN_URL');
    const revokeUrl = url('ATLAS_CLAUDE_REVOKE_URL');
    const apiBase = url('ATLAS_CLAUDE_API_BASE') ?? 'https://api.anthropic.com';
    const portRaw = this.setting('ATLAS_CLAUDE_REDIRECT_PORT');
    const port = portRaw ? Number(portRaw) : 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push('ATLAS_CLAUDE_REDIRECT_PORT must be a port number.');
    let headers: Record<string, string> = {};
    const rawHeaders = this.setting('ATLAS_CLAUDE_HEADERS');
    if (rawHeaders) {
      try {
        const h = JSON.parse(rawHeaders) as unknown;
        if (!h || typeof h !== 'object' || Array.isArray(h) || Object.values(h).some((v) => typeof v !== 'string')) throw new Error();
        headers = h as Record<string, string>;
      } catch {
        problems.push('ATLAS_CLAUDE_HEADERS must be a JSON object of header names to string values.');
      }
      for (const k of Object.keys(headers)) {
        if (RESERVED_HEADERS.has(k.toLowerCase())) problems.push(`Header ${k} is set by Atlas itself and can't be overridden.`);
      }
    }
    if (problems.length || !clientId || !authorizeUrl || !tokenUrl) return { config: null, problems };
    return {
      config: {
        clientId,
        clientSecret: this.setting('ATLAS_CLAUDE_CLIENT_SECRET'),
        authorizeUrl,
        tokenUrl,
        revokeUrl,
        scopes: this.setting('ATLAS_CLAUDE_SCOPES')!,
        port,
        apiBase: apiBase.replace(/\/+$/, ''),
        headers: clientId === CLAUDE_CODE_CLIENT_ID ? { ...headers, ...CLAUDE_SUBSCRIPTION_HEADERS } : headers,
      },
      problems,
    };
  }


  status(): ClaudePlanStatus {
    const { config, problems } = this.config();
    const settings = Object.fromEntries(
      CLAUDE_PLAN_SETTINGS.map((s) => [s.name, s.secret ? (this.setting(s.name) ? 'set' : null) : this.setting(s.name)]),
    ) as Record<ClaudePlanSetting, string | null>;
    const rows = this.rows();
    const accounts = rows.map((r) => this.plans.view(r, this.signedIn(r, config)));
    const live = accounts.filter((a) => a.signedIn);
    const signedIn = live.length > 0;
    const all = this.plans.allPausedUntil('claude_plan', (r) => this.signedIn(r, config));
    return {
      available: !!this.secrets,
      unavailableReason: this.secrets ? null : 'Claude sign-in works in the desktop app: a server engine has no keychain to keep the tokens in.',
      configured: !!config,
      configProblems: problems,
      settings,
      redirectUri: config?.port ? `http://127.0.0.1:${config.port}/callback` : null,
      signedIn,
      pending: !!this.pending,
      pendingAccountId: this.pending?.accountId ?? null,
      email: live[0]?.email ?? accounts[0]?.email ?? null,
      showWelcome: signedIn && !this.plans.welcomed('claude_plan'),
      pausedUntil: all.until,
      lastError: (live.length ? live : accounts).find((a) => a.lastError)?.lastError ?? null,
      accounts,
    };
  }

  update(patch: UpdateClaudePlan): ClaudePlanStatus {
    const p = UpdateClaudePlan.parse(patch);
    if (p.welcomed) this.plans.setWelcomed('claude_plan');
    if (p.resume) for (const r of this.rows()) this.plans.set(r.id, { paused_at: null, paused_until: null, last_error: null });
    this.emit();
    return this.status();
  }

  /**
   * Start a sign-in for one subscription (default: the first, made when there is none) — authorization code + PKCE;
   * returns the URL to open in the system browser.
   */
  async login(accountId?: string | null): Promise<{ url: string }> {
    if (!this.secrets) throw new ConflictError(this.status().unavailableReason!);
    const { config: c, problems } = this.config();
    if (!c) throw new ConflictError(`Claude plan is not set up: ${problems.join(' ')}`);
    this.cancel();
    const account = this.plans.forLogin('claude_plan', accountId);
    if (c.clientId === CLAUDE_CODE_CLIENT_ID) {
      const verifier = b64url(randomBytes(32));
      const p: Pending = {
        accountId: account.id,
        state: b64url(randomBytes(24)), verifier, redirectUri: SUBSCRIPTION_REDIRECT,
        clientId: c.clientId, server: null,
        timer: setTimeout(() => { this.cancel(); this.emit(); }, LOGIN_TIMEOUT_MS),
      };
      this.pending = p;
      const url = new URL(c.authorizeUrl);
      for (const [k, v] of Object.entries({ code: 'true', response_type: 'code', client_id: c.clientId,
        redirect_uri: p.redirectUri, scope: c.scopes, state: p.state,
        code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' })) url.searchParams.set(k, v);
      this.emit();
      return { url: url.toString() };
    }
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', (e: NodeJS.ErrnoException) =>
        reject(e.code === 'EADDRINUSE' ? new ConflictError(`callback port ${c.port} is in use; free it or change ATLAS_CLAUDE_REDIRECT_PORT`) : e),
      );
      server.listen(c.port, '127.0.0.1', () => resolve());
    });
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    const verifier = b64url(randomBytes(32));
    const p: Pending = {
      accountId: account.id,
      state: b64url(randomBytes(24)),
      verifier,
      redirectUri,
      clientId: c.clientId,
      server,
      timer: setTimeout(() => {
        this.cancel();
        this.emit();
      }, LOGIN_TIMEOUT_MS),
    };
    this.pending = p;
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      if (u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      void this.callback(p, c, u.searchParams).then((out) => {
        res.writeHead(out.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' }).end(page(out.ok, out.message));
        if (!out.retry) this.close(p);
      });
    });
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: redirectUri,
      scope: c.scopes,
      state: p.state,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
    });
    this.emit();
    const url = new URL(c.authorizeUrl);
    for (const [k, v] of q) url.searchParams.set(k, v);
    return { url: url.toString() };
  }

  /** Complete the browser's code#state response without exposing tokens to the UI. */
  async completeLogin(value: string): Promise<ClaudePlanStatus> {
    const p = this.pending;
    if (!p || p.server) throw new ConflictError('No Claude subscription sign-in is pending. Start sign-in again.');
    if (typeof value !== 'string' || value.length > 8192) throw new ConflictError('Paste the authorization code from Claude.');
    const [code, state] = value.trim().split('#');
    if (!code || state !== p.state) throw new ConflictError('Invalid authorization code or state. Paste the complete code#state from this sign-in.');
    const { config: c } = this.config();
    if (!c || c.clientId !== p.clientId) throw new ConflictError('Claude connection changed. Start sign-in again.');
    const out = await this.callback(p, c, new URLSearchParams({ code, state }));
    if (!out.retry) this.close(p);
    if (!out.ok) throw new ConflictError(out.message);
    return this.status();
  }

  private async callback(p: Pending, c: Config, q: URLSearchParams): Promise<{ ok: boolean; message: string; retry?: boolean }> {
    if (q.get('state') !== p.state) return { ok: false, message: 'This sign-in link is not the one Atlas opened. Start again from Atlas.', retry: true };
    const fail = (message: string) => {
      this.plans.set(p.accountId, { last_error: message });
      this.emit();
      return { ok: false, message };
    };
    const err = q.get('error');
    if (err) return fail(err === 'access_denied' ? 'Claude sign-in was declined.' : `Claude sign-in failed: ${err} ${q.get('error_description') ?? ''}`.trim());
    const code = q.get('code');
    if (!code) return fail('Claude sign-in returned no code. Try again.');
    try {
      const tok = await this.tokenCall(c, { grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: p.redirectUri, state: p.state });
      if (!tok.ok) return fail(`Claude sign-in: token exchange failed (${tok.code ?? 'HTTP ' + tok.status}). Try again.`);
      const t = tok.body;
      if (!t.access_token) return fail('Claude sign-in: the answer had no access token.');
      const r = this.plans.row(p.accountId);
      const email = t.account?.email_address ?? t.email ?? null;
      const twin = email && this.rows().find((o) => o.id !== r.id && o.email === email && this.tokens(o));
      if (twin) return fail(`${email} is already signed in as « ${twin.label} »; sign in with another Claude account.`);
      this.plans.setTokens(r, { access: t.access_token, refresh: t.refresh_token ?? null } satisfies Tokens);
      this.plans.set(r.id, {
        client_id: p.clientId,
        email: email ?? r.email,
        scopes: t.scope ?? c.scopes,
        expires_at: t.expires_in ? new Date(this.now() + t.expires_in * 1000).toISOString() : null,
        signed_in_at: new Date(this.now()).toISOString(),
        paused_at: null,
        paused_until: null,
        last_error: null,
      });
      this.emit();
      return { ok: true, message: 'Atlas can now use your Claude plan. You can close this tab and go back to Atlas.' };
    } catch (e) {
      return fail(`Claude sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async tokenCall(
    c: Config,
    form: Record<string, string>,
  ): Promise<
    | { ok: true; body: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; email?: string; account?: { email_address?: string } } }
    | { ok: false; status: number; code?: string }
  > {
    const body = new URLSearchParams({ ...form, client_id: c.clientId });
    if (c.clientSecret) body.set('client_secret', c.clientSecret);
    const subscription = c.clientId === CLAUDE_CODE_CLIENT_ID;
    const res = await this.fetchFn(c.tokenUrl, { method: 'POST', headers: {
      'content-type': subscription ? 'application/json' : 'application/x-www-form-urlencoded',
      accept: 'application/json', 'user-agent': 'axios/1.7.9',
    }, body: subscription ? JSON.stringify(Object.fromEntries(body)) : body, signal: AbortSignal.timeout(30_000) });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, code: typeof j.error === 'string' ? j.error : undefined };
    return { ok: true, body: j as never };
  }

  /** A valid access token for one account, refreshed near expiry (one refresh at a time: refresh tokens may rotate). */
  private async accessToken(c: Config, id: string): Promise<string> {
    const r = this.plans.row(id);
    const t = this.tokens(r);
    if (!t || !r.client_id) throw new ModelError(`Claude plan « ${r.label} »: not signed in. Use Sign in with Claude in Settings → Subscriptions.`);
    if (!r.expires_at || Date.parse(r.expires_at) - this.now() > REFRESH_MARGIN_MS) return t.access;
    if (!t.refresh) {
      this.signedOut(r, 'Claude sign-in expired (no refresh token)');
      throw new ModelError(`Claude sign-in « ${r.label} » expired: sign in again in Settings → Subscriptions`);
    }
    const running = this.refreshing.get(id);
    if (running) return running;
    const next = this.refresh(c, r, t).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, next);
    return next;
  }

  private async refresh(c: Config, r: PlanRow, t: Tokens): Promise<string> {
    let out;
    try {
      out = await this.tokenCall(c, { grant_type: 'refresh_token', refresh_token: t.refresh! });
    } catch (e) {
      throw new ModelError(`Claude plan: could not renew the sign-in (${e instanceof Error ? e.message : String(e)}); will retry`, true);
    }
    if (!out.ok) {
      if (out.code && DEAD_REFRESH.has(out.code)) {
        this.signedOut(r, `Claude sign-in expired (${out.code})`);
        throw new ModelError(`Claude sign-in « ${r.label} » expired (${out.code}): sign in again in Settings → Subscriptions`);
      }
      throw new ModelError(`Claude plan: renewing the sign-in failed (${out.code ?? 'HTTP ' + out.status})`, out.status >= 500);
    }
    const b = out.body;
    if (!b.access_token) throw new ModelError('Claude refresh response had no access token');
    this.plans.setTokens(r, { access: b.access_token, refresh: b.refresh_token ?? t.refresh } satisfies Tokens);
    this.plans.set(r.id, { expires_at: b.expires_in ? new Date(this.now() + b.expires_in * 1000).toISOString() : null, ...(b.scope ? { scopes: b.scope } : {}) });
    return b.access_token;
  }

  private signedOut(r: PlanRow, reason: string): void {
    this.plans.dropTokens(r);
    this.plans.set(r.id, { expires_at: null, last_error: reason + ': sign in again.' });
    this.emit();
  }

  /** Sign one account out (default: the first): revoke at Anthropic when a revocation URL is set, then forget the tokens. */
  async logout(accountId?: string | null): Promise<ClaudePlanStatus> {
    const r = accountId ? this.plans.row(accountId) : this.rows()[0];
    if (!r) return this.status();
    if (this.pending?.accountId === r.id) this.cancel();
    const t = this.tokens(r);
    const { config: c } = this.config();
    let note: string | null = null;
    if (t && c?.revokeUrl) {
      try {
        const body = new URLSearchParams({ token: t.refresh ?? t.access, token_type_hint: t.refresh ? 'refresh_token' : 'access_token', client_id: c.clientId });
        if (c.clientSecret) body.set('client_secret', c.clientSecret);
        const res = await this.fetchFn(c.revokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        note = `Signed out here, but Anthropic did not confirm the session was revoked (${e instanceof Error ? e.message : String(e)}).`;
      }
    }
    this.plans.dropTokens(r);
    this.plans.set(r.id, { client_id: null, scopes: null, expires_at: null, paused_at: null, paused_until: null, last_error: note });
    this.emit();
    return this.status();
  }

  /** Sign out and forget a subscription. */
  async remove(accountId: string): Promise<ClaudePlanStatus> {
    await this.logout(accountId);
    this.plans.remove(accountId);
    return this.status();
  }

  private ready(): Config {
    const s = this.status();
    if (!s.available) throw new ModelError(s.unavailableReason!);
    const { config, problems } = this.config();
    if (!config) throw new ModelError(`Claude plan is not set up: ${problems.join(' ')} (Settings → Subscriptions)`);
    if (!s.signedIn) throw new ModelError('Claude plan: not signed in. Use Sign in with Claude in Settings → Subscriptions.');
    if (s.accounts.filter((a) => a.signedIn).every((a) => a.paused))
      throw this.plans.exhausted('claude_plan', this.rows().filter((r) => this.signedIn(r, config)));
    return config;
  }

  /** Why the plan can't be used right now, or null. */
  problem(): string | null {
    try {
      this.ready();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** Models the first usable account can use (Anthropic's GET /v1/models with its token). */
  async models(): Promise<ClaudePlanModel[]> {
    const c = this.ready();
    const live = this.rows().filter((r) => this.signedIn(r, c));
    const r = live.find((x) => !this.plans.paused(x)) ?? live[0]!;
    const token = await this.accessToken(c, r.id);
    const res = await this.fetchFn(c.apiBase + '/v1/models?limit=100', {
      headers: { ...c.headers, authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
    });
    if (res.status === 401) this.signedOut(r, 'Anthropic refused the access token (HTTP 401)');
    if (!res.ok) throw new ModelError(`Claude models: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as { data?: { id: string; display_name?: string }[] };
    return (j.data ?? []).map((m) => ({ id: m.id, displayName: m.display_name ?? m.id }));
  }

  /** Calls go to the signed-in subscriptions in order; a usage limit moves the call to the next one. */
  provider(): Provider {
    this.ready();
    return {
      complete: async (req, onText, signal) => {
        const c = this.ready();
        return this.plans.call(
          'claude_plan',
          (r) => this.signedIn(r, c),
          async (r, onStream) => {
            const token = await this.accessToken(c, r.id);
            const p = new AnthropicProvider(null, {
              authToken: token,
              baseURL: c.apiBase,
              headers: c.headers,
              systemPrefix: c.clientId === CLAUDE_CODE_CLIENT_ID ? "You are Claude Code, Anthropic's official CLI for Claude." : undefined,
              maxRetries: 0,
              fetch: this.fetchFn,
              onHeaders: (h) => this.plans.recordQuota(r.id, claudeQuota(h, this.now()), rawLimitHeaders(h)),
            });
            try {
              return await p.complete(req, (t, kind) => (onStream(), onText(t, kind)), signal);
            } catch (e) {
              if (e instanceof AnthropicError && e.status === 401) {
                this.signedOut(r, 'Anthropic refused the access token (HTTP 401)');
                throw new ModelError(`Claude plan « ${r.label} »: Anthropic refused the sign-in (HTTP 401): sign in again in Settings → Subscriptions`);
              }
              if (e instanceof AnthropicError && e.status === 429) {
                const until = claudeLimitUntil(e.headers, this.now());
                throw new PlanLimitError(`Claude plan limit reached (HTTP 429). Requests resume at ${new Date(until).toLocaleString()}.`, until);
              }
              throw e;
            }
          },
        );
      },
    };
  }

  private close(p: Pending): void {
    clearTimeout(p.timer);
    p.server?.close();
    p.server?.closeAllConnections();
    if (this.pending === p) {
      this.pending = null;
      this.emit();
    }
  }
  cancel(): void {
    if (this.pending) this.close(this.pending);
  }
  stop(): void {
    this.cancel();
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function page(ok: boolean, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Atlas · Claude</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f7f8;color:#1d1f21}
main{max-width:420px;padding:28px;border:1px solid #e3e6e8;border-radius:14px;background:#fff}h1{font-size:18px;margin:0 0 8px}</style>
<main><h1>${ok ? 'Connected to Claude' : 'Not connected'}</h1><p>${esc(message)}</p></main>`;
}
