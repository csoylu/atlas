import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UpdateGeminiPlan, type GeminiPlanModel, type GeminiPlanStatus } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { GEMINI_TOKENS as TOKENS, type SecretStore } from './secrets.ts';
import { ConflictError } from './kanban.ts';
import { ModelError, type Provider } from './providers/types.ts';
import { ANTIGRAVITY_VERSION, DEFAULT_GEMINI_ENDPOINT, GeminiError, GeminiProvider, antigravityUserAgent } from './providers/gemini.ts';

/**
 * Can's Google subscription (Gemini) in Atlas, through the Antigravity quota (design §5).
 * Sign in with Google (PKCE), keep the tokens in the keychain, resolve the Cloud Code project, then stream turns
 * through Antigravity's v1internal endpoint. One account; a usage limit pauses requests, never switches billing.
 */
export interface GeminiPlanOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Loopback callback port (the OAuth client registers exactly 51121). */
  port?: number;
  endpoint?: string;
}

interface Row {
  client_id: string | null;
  email: string | null;
  project: string | null;
  expires_at: string | null;
  signed_in_at: string | null;
  paused_until: string | null;
  last_error: string | null;
}
interface Tokens {
  access: string;
  refresh: string;
}
interface Pending {
  state: string;
  verifier: string;
  redirectUri: string;
  servers: Server[];
  timer: NodeJS.Timeout;
}

/** The OAuth client comes from the engine env (keychain entries included); the Antigravity app's values are not
 * shipped in the repo (GitHub push protection blocks them, and rule 5 keeps secrets out of source). */
export const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];
export const ANTIGRAVITY_REDIRECT_PORT = 51121;
export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
export const GEMINI_PROJECT_ENV = 'ATLAS_GEMINI_PROJECT';

const REFRESH_MARGIN_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_LIMIT_PAUSE_MS = 60_000;
const DEAD_REFRESH = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_token', 'refresh_token_reused']);

const b64url = (b: Buffer) => b.toString('base64url');

export class GeminiPlan {
  private pending: Pending | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly port: number;
  private readonly defaultEndpoint: string;

  constructor(
    private db: Db,
    private bus: Bus,
    private secrets: SecretStore | undefined,
    /** The engine env (process env + keychain entries), read at every use so new settings apply without restart. */
    private env: NodeJS.ProcessEnv,
    o: GeminiPlanOptions = {},
  ) {
    this.fetchFn = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    this.port = o.port ?? ANTIGRAVITY_REDIRECT_PORT;
    this.defaultEndpoint = o.endpoint ?? DEFAULT_GEMINI_ENDPOINT;
  }

  private row(): Row {
    this.db.prepare('INSERT OR IGNORE INTO gemini_account (id) VALUES (1)').run();
    return this.db.prepare('SELECT * FROM gemini_account WHERE id = 1').get() as Row;
  }
  private set(cols: Partial<Row>): void {
    const keys = Object.keys(cols);
    if (keys.length) this.db.prepare(`UPDATE gemini_account SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = 1`).run(cols);
  }
  private tokens(): Tokens | null {
    const raw = this.secrets?.get(TOKENS);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  }
  private emit(): void {
    this.bus.emit({ type: 'gemini.updated', status: this.status() });
  }
  private clientId(): string {
    return this.env.ATLAS_GEMINI_CLIENT_ID?.trim() ?? '';
  }
  private clientSecret(): string {
    return this.env.ATLAS_GEMINI_CLIENT_SECRET?.trim() ?? '';
  }
  private endpoint(): string {
    return (this.env.ATLAS_GEMINI_ENDPOINT?.trim() || this.defaultEndpoint).replace(/\/+$/, '');
  }

  /** What stops a sign-in: the OAuth client (entered on the Models page) and the keychain. */
  private configProblems(): string[] {
    const out: string[] = [];
    if (!this.clientId()) out.push('Set the OAuth client ID (from the Antigravity app): Atlas ships none.');
    if (!this.clientSecret()) out.push('Set the OAuth client secret (from the Antigravity app).');
    return out;
  }

  status(): GeminiPlanStatus {
    const r = this.row();
    const paused = r.paused_until && Date.parse(r.paused_until) > this.now() ? r.paused_until : null;
    const problems = this.configProblems();
    return {
      available: !!this.secrets,
      unavailableReason: this.secrets ? null : 'Gemini sign-in works in the desktop app: a server engine has no keychain to keep the tokens in.',
      configured: problems.length === 0,
      configProblems: problems,
      settings: {
        ATLAS_GEMINI_CLIENT_ID: this.clientId() || null,
        ATLAS_GEMINI_CLIENT_SECRET: this.clientSecret() ? 'set' : null,
      },
      signedIn: !!this.tokens() && !!r.client_id,
      pending: !!this.pending,
      email: r.email,
      project: this.env[GEMINI_PROJECT_ENV]?.trim() || r.project,
      pausedUntil: paused,
      lastError: r.last_error,
    };
  }

  update(patch: UpdateGeminiPlan): GeminiPlanStatus {
    const p = UpdateGeminiPlan.parse(patch);
    if (p.resume) this.set({ paused_until: null, last_error: null });
    this.emit();
    return this.status();
  }

  /** Start a sign-in: PKCE against Google, callback on the Antigravity client's registered loopback URI. */
  async login(): Promise<{ url: string }> {
    if (!this.secrets) throw new ConflictError(this.status().unavailableReason!);
    const problems = this.configProblems();
    if (problems.length) throw new ConflictError(problems.join(' '));
    this.cancel();
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(24));

    const redirectPort = this.port;
    const servers = await listenLoopback(redirectPort).catch((e: NodeJS.ErrnoException) => {
      throw e.code === 'EADDRINUSE'
        ? new ConflictError(`Gemini sign-in needs port ${redirectPort} (the OAuth client's registered callback); it is in use. Free it and try again.`)
        : e;
    });
    const port = (servers[0]!.address() as AddressInfo).port;
    const redirectUri = `http://localhost:${port}/oauth-callback`;

    const p: Pending = {
      state,
      verifier,
      redirectUri,
      servers,
      timer: setTimeout(() => {
        this.cancel();
        this.emit();
      }, LOGIN_TIMEOUT_MS),
    };
    this.pending = p;

    for (const server of servers) {
      server.on('request', (req, res) => {
        const u = new URL(req.url ?? '/', redirectUri);
        if (u.pathname !== '/oauth-callback') {
          res.writeHead(404).end();
          return;
        }
        void this.callback(p, u.searchParams).then((out) => {
          res.writeHead(out.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' }).end(page(out.ok, out.message));
          if (!out.retry) this.close(p);
        });
      });
    }

    const q = new URLSearchParams({
      client_id: this.clientId(),
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: ANTIGRAVITY_SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
    this.emit();
    return { url: `${GOOGLE_AUTHORIZE_URL}?${q}` };
  }

  /** The browser came back: exchange the code, keep the tokens, resolve the project. */
  private async callback(p: Pending, q: URLSearchParams): Promise<{ ok: boolean; message: string; retry?: boolean }> {
    if (q.get('state') !== p.state) return { ok: false, message: 'This sign-in link is not the one Atlas opened. Start again from Atlas.', retry: true };
    const fail = (message: string) => {
      this.set({ last_error: message });
      this.emit();
      return { ok: false, message };
    };
    const err = q.get('error');
    if (err) return fail(err === 'access_denied' ? 'Gemini sign-in was declined.' : `Gemini sign-in failed: ${err} ${q.get('error_description') ?? ''}`.trim());
    const code = q.get('code');
    if (!code) return fail('Gemini sign-in returned no code. Try again.');
    try {
      const tok = await this.tokenCall({ grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: p.redirectUri });
      if (!tok.ok) return fail(`Gemini sign-in: Google refused the code (${tok.code ?? 'HTTP ' + tok.status}). Try again.`);
      const t = tok.body;
      if (!t.access_token || !t.refresh_token) return fail('Gemini sign-in: Google sent no refresh token. Try again (consent is required to keep the sign-in).');
      const email = await this.userInfo(t.access_token);
      this.secrets!.set(TOKENS, JSON.stringify({ access: t.access_token, refresh: t.refresh_token } satisfies Tokens));
      this.set({
        client_id: this.clientId(),
        email,
        expires_at: t.expires_in ? new Date(this.now() + t.expires_in * 1000).toISOString() : null,
        signed_in_at: new Date(this.now()).toISOString(),
        paused_until: null,
        last_error: null,
      });
      this.emit();
      // The project is needed for every call; resolve it now so a failure is visible on the Models page.
      await this.ensureProject(true).catch((e: unknown) => {
        this.set({ last_error: `Signed in, but Google returned no Cloud Code project: ${e instanceof Error ? e.message : String(e)}` });
        this.emit();
      });
      return { ok: true, message: 'Atlas can now use your Gemini plan. You can close this tab and go back to Atlas.' };
    } catch (e) {
      return fail(`Gemini sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async userInfo(token: string): Promise<string | null> {
    try {
      const res = await this.fetchFn(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${token}`, 'user-agent': antigravityUserAgent() } });
      if (!res.ok) return null;
      const j = (await res.json()) as { email?: string };
      return j.email ?? null;
    } catch {
      return null;
    }
  }

  private async tokenCall(form: Record<string, string>): Promise<
    | { ok: true; body: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string } }
    | { ok: false; status: number; code?: string }
  > {
    let res: Response;
    try {
      res = await this.fetchFn(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', accept: 'application/json' },
        body: new URLSearchParams({ ...form, client_id: this.clientId(), client_secret: this.clientSecret() }),
      });
    } catch (e) {
      return { ok: false, status: 500, code: e instanceof Error ? e.message : String(e) };
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, code: typeof body.error === 'string' ? body.error : undefined };
    return { ok: true, body: body as never };
  }

  /** A valid access token, refreshed near expiry (one refresh at a time). */
  private async accessToken(): Promise<string> {
    const t = this.tokens();
    const r = this.row();
    if (!t || !r.client_id) throw new ModelError('Gemini plan: not signed in. Use Sign in with Google on the Models page.');
    if (!r.expires_at || Date.parse(r.expires_at) - this.now() > REFRESH_MARGIN_MS) return t.access;
    return (this.refreshing ??= this.refresh(t).finally(() => (this.refreshing = null)));
  }

  private async refresh(t: Tokens): Promise<string> {
    const out = await this.tokenCall({ grant_type: 'refresh_token', refresh_token: t.refresh });
    if (!out.ok) {
      if (out.code && DEAD_REFRESH.has(out.code)) {
        this.signedOut(`Gemini sign-in expired (${out.code})`);
        throw new ModelError(`Gemini sign-in expired (${out.code}): sign in again on the Models page`);
      }
      throw new ModelError(`Gemini plan: renewing the sign-in failed (${out.code ?? 'HTTP ' + out.status})`, out.status >= 500);
    }
    const b = out.body;
    this.secrets!.set(TOKENS, JSON.stringify({ access: b.access_token, refresh: b.refresh_token ?? t.refresh } satisfies Tokens));
    this.set({ expires_at: b.expires_in ? new Date(this.now() + b.expires_in * 1000).toISOString() : null });
    return b.access_token;
  }

  private signedOut(reason: string): void {
    this.secrets?.delete(TOKENS);
    this.set({ expires_at: null, last_error: reason + ': sign in again.' });
    this.emit();
  }

  /** Sign out: revoke the refresh token at Google, then forget it. The project stays for the next sign-in. */
  async logout(): Promise<GeminiPlanStatus> {
    this.cancel();
    const t = this.tokens();
    let note: string | null = null;
    if (t) {
      try {
        const res = await this.fetchFn(GOOGLE_REVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: t.refresh }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        note = `Signed out here, but Google did not confirm the revocation (${e instanceof Error ? e.message : String(e)}).`;
      }
    }
    this.secrets?.delete(TOKENS);
    this.set({ client_id: null, expires_at: null, paused_until: null, last_error: note });
    this.emit();
    return this.status();
  }

  /** The Cloud Code project the quota belongs to: the setting, the saved one, or one provisioned now. */
  async ensureProject(force = false): Promise<string> {
    const override = this.env[GEMINI_PROJECT_ENV]?.trim();
    if (override) return override;
    const r = this.row();
    if (r.project && !force) return r.project;
    const token = await this.accessToken();
    const found = await this.loadProject(token);
    if (found) {
      this.set({ project: found, ...(r.last_error?.startsWith('Signed in, but Google returned no Cloud Code project') ? { last_error: null } : {}) });
      // The sign-in emitted before the project was known; the Models page shows it from this status.
      if (r.project !== found) this.emit();
      return found;
    }
    throw new ModelError(`Gemini plan: Google returned no Cloud Code project for this account. Set ${GEMINI_PROJECT_ENV} on the Models page.`);
  }

  private async loadProject(token: string): Promise<string | null> {
    const call = async (path: string, body: unknown, userAgent: string): Promise<Response> =>
      this.fetchFn(this.endpoint() + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': userAgent },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    const projectId = (v: unknown): string | null => {
      const id = typeof v === 'string' ? v : v && typeof v === 'object' ? (v as { id?: unknown }).id : undefined;
      return typeof id === 'string' && id.trim() ? id.trim() : null;
    };

    const res = await call('/v1internal:loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, antigravityUserAgent());
    if (!res.ok) throw new ModelError(`loadCodeAssist answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as {
      cloudaicompanionProject?: string | { id?: string };
      currentTier?: { id?: string };
      allowedTiers?: { id?: string; isDefault?: boolean }[];
    };
    const existing = projectId(j.cloudaicompanionProject);
    if (existing) return existing;

    const tier = j.allowedTiers?.find((t) => t.isDefault)?.id ?? j.allowedTiers?.[0]?.id ?? j.currentTier?.id ?? 'free-tier';
    for (let i = 0; i < 10; i++) {
      const on = await call(
        '/v1internal:onboardUser',
        { tier_id: tier, metadata: { ide_type: 'ANTIGRAVITY', ide_version: ANTIGRAVITY_VERSION, ide_name: 'antigravity' } },
        `${antigravityUserAgent()} google-api-nodejs-client/10.3.0`,
      );
      if (!on.ok) throw new ModelError(`onboardUser answered HTTP ${on.status}: ${(await on.text()).slice(0, 200)}`);
      const o = (await on.json()) as { done?: boolean; response?: { cloudaicompanionProject?: string | { id?: string } } };
      if (o.done) return projectId(o.response?.cloudaicompanionProject);
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  /** Models this account can use (Antigravity catalog). Only Gemini-shaped ids: Atlas speaks their request schema. */
  async models(): Promise<GeminiPlanModel[]> {
    this.ready();
    const token = await this.accessToken();
    const project = await this.ensureProject();
    const res = await this.fetchFn(this.endpoint() + '/v1internal:fetchAvailableModels', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': antigravityUserAgent() },
      body: JSON.stringify({ project }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new ModelError(`Gemini models: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as {
      models?: Record<string, { displayName?: string; disabled?: boolean; selectable?: boolean; maxTokens?: number }>;
    };
    return Object.entries(j.models ?? {})
      .filter(([id, m]) => !m.disabled && m.selectable !== false && /^gemini/i.test(id) && !/image|tts|audio|embedding/i.test(id))
      .map(([id, m]) => ({ id, displayName: m.displayName ?? id, contextWindow: m.maxTokens ?? 1_000_000 }))
      .sort((a, b) => a.id.localeCompare(b.id));
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

  private ready(): void {
    const s = this.status();
    if (!s.available) throw new ModelError(s.unavailableReason!);
    if (!s.configured) throw new ModelError(`Gemini plan: ${s.configProblems.join(' ')}`);
    if (!s.signedIn) throw new ModelError('Gemini plan: not signed in. Use Sign in with Google on the Models page.');
    if (s.pausedUntil) throw new ModelError(`Gemini plan limit reached: paused until ${new Date(s.pausedUntil).toLocaleString()} (or Resume on the Models page).`);
  }

  provider(): Provider {
    this.ready();
    return {
      complete: async (req, onText, signal) => {
        this.ready();
        const token = await this.accessToken();
        const project = await this.ensureProject();
        const p = new GeminiProvider(project, token, this.endpoint(), this.fetchFn);
        try {
          return await p.complete(req, onText, signal);
        } catch (e) {
          if (e instanceof GeminiError && e.status === 401) {
            this.signedOut('Google refused the access token (HTTP 401)');
            throw new ModelError('Gemini plan: Google refused the sign-in (HTTP 401): sign in again on the Models page');
          }
          if (e instanceof GeminiError && e.status === 429) {
            const until = new Date(this.now() + resetIn(e.headers, this.now(), e.body));
            this.set({ paused_until: until.toISOString(), last_error: `Gemini plan limit reached (HTTP 429). Requests resume at ${until.toLocaleString()}.` });
            this.emit();
            throw new ModelError(`Gemini plan limit reached: paused until ${until.toLocaleString()}`, true);
          }
          if (e instanceof GeminiError && e.status === 403 && /TOS_VIOLATION|terms of service/i.test(e.body)) {
            // Google can refuse third-party clients outright; retrying only wastes the account's requests.
            throw new ModelError('Gemini plan: Google refused this account for third-party use (TOS_VIOLATION). Atlas will not retry.');
          }
          throw e;
        }
      },
    };
  }

  private close(p: Pending): void {
    clearTimeout(p.timer);
    for (const s of p.servers) {
      s.close();
      s.closeAllConnections();
    }
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

/** How long a 429 pauses the plan: retry-after, Google's RetryInfo delay, else a minute. */
export function resetIn(h: Headers | null, now: number, body?: string): number {
  const retry = Number(h?.get('retry-after'));
  if (retry > 0) return retry * 1000;
  if (body) {
    try {
      const j = JSON.parse(body) as { error?: { details?: { retryDelay?: string }[] } };
      for (const d of j.error?.details ?? []) {
        const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay ?? '');
        if (m) return Math.max(1000, Number(m[1]) * 1000);
      }
    } catch {}
  }
  return DEFAULT_LIMIT_PAUSE_MS;
}

/**
 * Listen on the callback port on both loopback families: the browser resolves `localhost` to ::1 or 127.0.0.1 and
 * either must answer. Nothing is exposed beyond this machine.
 */
async function listenLoopback(port: number): Promise<Server[]> {
  const servers: Server[] = [];
  const hosts = port === 0 ? ['127.0.0.1'] : ['127.0.0.1', '::1'];
  try {
    for (const host of hosts) {
      const s = createServer();
      await new Promise<void>((resolve, reject) => {
        s.once('error', (e: NodeJS.ErrnoException) => {
          s.close();
          // No IPv6 on this machine: the IPv4 listener still serves the callback.
          if (host === '::1' && (e.code === 'EAFNOSUPPORT' || e.code === 'EADDRNOTAVAIL')) return resolve();
          reject(e);
        });
        s.listen(port, host, () => resolve());
      });
      if (s.listening) servers.push(s);
    }
  } catch (e) {
    for (const s of servers) s.close();
    throw e;
  }
  if (!servers.length) throw Object.assign(new Error('could not listen for the sign-in callback'), { code: 'EADDRINUSE' });
  return servers;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function page(ok: boolean, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Atlas · Gemini</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f7f8;color:#1d1f21}
main{max-width:420px;padding:28px;border:1px solid #e3e6e8;border-radius:14px;background:#fff}h1{font-size:18px;margin:0 0 8px}</style>
<main><h1>${ok ? 'Connected to Gemini' : 'Not connected'}</h1><p>${esc(message)}</p></main>`;
}
