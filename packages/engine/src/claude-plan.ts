import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_PLAN_SETTINGS,
  UpdateClaudePlan,
  type ClaudePlanModel,
  type ClaudePlanSetting,
  type ClaudePlanStatus,
} from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { CLAUDE_TOKENS as TOKENS, type SecretStore } from './secrets.ts';
import { ConflictError } from './kanban.ts';
import { ModelError, type Provider } from './providers/types.ts';
import { AnthropicError, AnthropicProvider, isOAuthToken } from './providers/anthropic.ts';

export interface ClaudePlanOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

interface Row {
  client_id: string | null;
  email: string | null;
  scopes: string | null;
  expires_at: string | null;
  signed_in_at: string | null;
  welcomed: number;
  paused_until: string | null;
  last_error: string | null;
}
interface Tokens {
  access: string;
  refresh: string | null;
}
interface Pending {
  state: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  server?: Server;
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

/** Official Claude Code client ID for direct Claude subscription OAuth (matches Hermes agent). */
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const DEFAULT_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const DEFAULT_TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
];
export const DEFAULT_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
export const DEFAULT_SCOPES = 'org:create_api_key user:profile user:inference';
export const TOKEN_USER_AGENT = 'axios/1.7.9';

const RESERVED_HEADERS = new Set(['authorization', 'x-api-key', 'anthropic-version', 'host', 'content-type', 'content-length']);
const REFRESH_MARGIN_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_LIMIT_PAUSE_MS = 60_000;
const DEAD_REFRESH = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_token', 'refresh_token_reused']);

const b64url = (b: Buffer) => b.toString('base64url');

/**
 * Detect existing Claude Code credentials from local environment, ~/.claude/.credentials.json, or keychain.
 */
export function detectClaudeCodeCredentials(env: NodeJS.ProcessEnv = process.env): {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  source: string;
} | null {
  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_TOKEN;
  if (envToken && isOAuthToken(envToken)) {
    return { accessToken: envToken, source: 'environment' };
  }

  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  const filePath = join(configDir, '.credentials.json');
  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8')) as {
        claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number; scopes?: string[] };
      };
      const oauth = data?.claudeAiOauth;
      if (oauth?.accessToken) {
        return {
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt,
          scopes: oauth.scopes,
          source: '~/.claude/.credentials.json',
        };
      }
    } catch {}
  }
  return null;
}

export class ClaudePlan {
  private pending: Pending | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(
    private db: Db,
    private bus: Bus,
    private secrets: SecretStore | undefined,
    /** The engine env (process env + keychain entries), read at every use so new settings apply without restart. */
    private env: NodeJS.ProcessEnv,
    o: ClaudePlanOptions = {},
  ) {
    this.fetchFn = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  private row(): Row {
    this.db.prepare('INSERT OR IGNORE INTO claude_account (id) VALUES (1)').run();
    return this.db.prepare('SELECT * FROM claude_account WHERE id = 1').get() as Row;
  }
  private set(cols: Partial<Row>): void {
    const keys = Object.keys(cols);
    if (keys.length) this.db.prepare(`UPDATE claude_account SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = 1`).run(cols);
  }
  private tokens(): Tokens | null {
    const raw = this.secrets?.get(TOKENS);
    return raw ? (JSON.parse(raw) as Tokens) : null;
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
    return v ? v : null;
  }

  /** The settings, checked. Defaults match Hermes Claude subscription OAuth. */
  private config(): { config: Config; problems: string[] } {
    const problems: string[] = [];
    const clientId = this.setting('ATLAS_CLAUDE_CLIENT_ID') ?? CLAUDE_CODE_CLIENT_ID;

    const url = (n: ClaudePlanSetting, defaultVal: string): string => {
      const v = this.setting(n);
      if (!v) return defaultVal;
      try {
        const u = new URL(v);
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
          problems.push(`${n} must be an https URL.`);
        return v;
      } catch {
        problems.push(`${n} is not a URL.`);
        return defaultVal;
      }
    };

    const authorizeUrl = url('ATLAS_CLAUDE_AUTHORIZE_URL', DEFAULT_AUTHORIZE_URL);
    const tokenUrl = url('ATLAS_CLAUDE_TOKEN_URL', DEFAULT_TOKEN_URLS[0]!);
    const revokeUrl = this.setting('ATLAS_CLAUDE_REVOKE_URL') ? url('ATLAS_CLAUDE_REVOKE_URL', '') : null;
    const apiBase = (this.setting('ATLAS_CLAUDE_API_BASE') ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    const scopes = this.setting('ATLAS_CLAUDE_SCOPES') ?? DEFAULT_SCOPES;
    const portRaw = this.setting('ATLAS_CLAUDE_REDIRECT_PORT');
    const port = portRaw ? Number(portRaw) : 0;
    if (portRaw && (!Number.isInteger(port) || port < 0 || port > 65535)) problems.push('ATLAS_CLAUDE_REDIRECT_PORT must be a port number.');

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
      for (const [k] of Object.entries(headers)) {
        if (RESERVED_HEADERS.has(k.toLowerCase())) problems.push(`Header ${k} is set by Atlas itself and can't be overridden.`);
      }
    }

    return {
      config: {
        clientId,
        clientSecret: this.setting('ATLAS_CLAUDE_CLIENT_SECRET'),
        authorizeUrl,
        tokenUrl,
        revokeUrl,
        scopes,
        port,
        apiBase,
        headers,
      },
      problems,
    };
  }

  status(): ClaudePlanStatus {
    const r = this.row();
    const { config, problems } = this.config();
    const settings = Object.fromEntries(
      CLAUDE_PLAN_SETTINGS.map((s) => [s.name, s.secret ? (this.setting(s.name) ? 'set' : null) : this.setting(s.name)]),
    ) as Record<ClaudePlanSetting, string | null>;

    const signedIn = !!this.tokens() && !!r.client_id;
    const paused = r.paused_until && Date.parse(r.paused_until) > this.now() ? r.paused_until : null;

    let detected: { source: string; email?: string } | null = null;
    if (!signedIn) {
      const found = detectClaudeCodeCredentials(this.env);
      if (found) {
        detected = { source: found.source };
      }
    }

    return {
      available: !!this.secrets,
      unavailableReason: this.secrets ? null : 'Claude sign-in works in the desktop app: a server engine has no keychain to keep the tokens in.',
      configured: problems.length === 0,
      configProblems: problems,
      settings,
      redirectUri: config.port ? `http://127.0.0.1:${config.port}/callback` : DEFAULT_REDIRECT_URI,
      signedIn,
      pending: !!this.pending,
      email: r.email,
      showWelcome: signedIn && !r.welcomed,
      pausedUntil: paused,
      lastError: r.last_error,
      detectedCredentials: detected,
    };
  }

  update(patch: UpdateClaudePlan): ClaudePlanStatus {
    const p = UpdateClaudePlan.parse(patch);
    if (p.welcomed) this.set({ welcomed: 1 });
    if (p.resume) this.set({ paused_until: null, last_error: null });
    this.emit();
    return this.status();
  }

  /**
   * Start a sign-in with PKCE.
   * If a loopback port is configured, spins up a local server.
   * Otherwise uses Anthropic's console callback URI where user copies the authorization code.
   */
  async login(): Promise<{ url: string }> {
    if (!this.secrets) throw new ConflictError(this.status().unavailableReason!);
    const { config: c, problems } = this.config();
    if (problems.length) throw new ConflictError(`Claude plan is not set up: ${problems.join(' ')}`);
    this.cancel();

    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const state = b64url(randomBytes(24));

    let redirectUri = DEFAULT_REDIRECT_URI;
    let server: Server | undefined;

    if (c.port > 0 || this.setting('ATLAS_CLAUDE_REDIRECT_PORT')) {
      server = createServer();
      await new Promise<void>((resolve, reject) => {
        server!.once('error', (e: NodeJS.ErrnoException) =>
          reject(e.code === 'EADDRINUSE' ? new ConflictError(`callback port ${c.port} is in use; free it or change ATLAS_CLAUDE_REDIRECT_PORT`) : e),
        );
        server!.listen(c.port, '127.0.0.1', () => resolve());
      });
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    }

    const p: Pending = {
      state,
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

    if (server) {
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
    }

    const q = new URLSearchParams({
      code: 'true',
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: redirectUri,
      scope: c.scopes,
      state: p.state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    this.emit();
    const url = new URL(c.authorizeUrl);
    for (const [k, v] of q) url.searchParams.set(k, v);
    return { url: url.toString() };
  }

  /**
   * Exchange an authorization code (pasted from Anthropic browser flow or code#state).
   */
  async exchange(authCode: string): Promise<ClaudePlanStatus> {
    if (!this.secrets) throw new ConflictError(this.status().unavailableReason!);
    const raw = authCode.trim();
    if (!raw) throw new ConflictError('No authorization code entered.');
    const { config: c } = this.config();
    const p = this.pending;

    const splits = raw.split('#');
    const code = splits[0]!;
    const state = splits.length > 1 ? splits[1] : undefined;

    if (p && state && p.state && state !== p.state) {
      this.set({ last_error: 'OAuth state mismatch — please start sign-in again.' });
      this.emit();
      throw new ConflictError('OAuth state mismatch');
    }

    const verifier = p?.verifier ?? '';
    const redirectUri = p?.redirectUri ?? DEFAULT_REDIRECT_URI;

    try {
      const tok = await this.tokenCall(c, {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        ...(state ? { state } : p ? { state: p.state } : {}),
      });

      if (!tok.ok) {
        const err = `Claude sign-in: token exchange failed (${tok.code ?? 'HTTP ' + tok.status}).`;
        this.set({ last_error: err });
        this.emit();
        throw new ModelError(err);
      }

      const t = tok.body;
      if (!t.access_token) {
        const err = 'Claude sign-in: the answer had no access token.';
        this.set({ last_error: err });
        this.emit();
        throw new ModelError(err);
      }

      this.secrets.set(TOKENS, JSON.stringify({ access: t.access_token, refresh: t.refresh_token ?? null } satisfies Tokens));
      const r = this.row();
      this.set({
        client_id: c.clientId,
        email: t.account?.email_address ?? t.email ?? r.email ?? 'Claude Subscription User',
        scopes: t.scope ?? c.scopes,
        expires_at: t.expires_in ? new Date(this.now() + t.expires_in * 1000).toISOString() : null,
        signed_in_at: new Date(this.now()).toISOString(),
        paused_until: null,
        last_error: null,
      });

      if (p) this.close(p);
      this.emit();
      return this.status();
    } catch (e) {
      if (p && !p.server) this.close(p);
      throw e;
    }
  }

  /**
   * Set a subscription OAuth token directly (e.g. sk-ant-oat* or from setup-token).
   */
  async setToken(token: string, refreshToken?: string): Promise<ClaudePlanStatus> {
    if (!this.secrets) throw new ConflictError(this.status().unavailableReason!);
    const raw = token.trim();
    if (!raw) throw new ConflictError('No token provided.');
    const { config: c } = this.config();
    this.secrets.set(TOKENS, JSON.stringify({ access: raw, refresh: refreshToken?.trim() || null } satisfies Tokens));
    const r = this.row();
    this.set({
      client_id: c.clientId,
      email: r.email ?? 'Claude Subscription User',
      scopes: c.scopes,
      expires_at: null,
      signed_in_at: new Date(this.now()).toISOString(),
      paused_until: null,
      last_error: null,
    });
    this.emit();
    return this.status();
  }

  /**
   * Import detected local Claude Code credentials if present on this machine.
   */
  async importDetected(): Promise<ClaudePlanStatus> {
    const creds = detectClaudeCodeCredentials(this.env);
    if (!creds?.accessToken) throw new ConflictError('No Claude Code credentials detected on this machine.');
    return this.setToken(creds.accessToken, creds.refreshToken);
  }

  private async callback(p: Pending, c: Config, q: URLSearchParams): Promise<{ ok: boolean; message: string; retry?: boolean }> {
    if (q.get('state') !== p.state) return { ok: false, message: 'This sign-in link is not the one Atlas opened. Start again from Atlas.', retry: true };
    const fail = (message: string) => {
      this.set({ last_error: message });
      this.emit();
      return { ok: false, message };
    };
    const err = q.get('error');
    if (err) return fail(err === 'access_denied' ? 'Claude sign-in was declined.' : `Claude sign-in failed: ${err} ${q.get('error_description') ?? ''}`.trim());
    const code = q.get('code');
    if (!code) return fail('Claude sign-in returned no code. Try again.');
    try {
      const tok = await this.tokenCall(c, { grant_type: 'authorization_code', code, code_verifier: p.verifier, redirect_uri: p.redirectUri });
      if (!tok.ok) return fail(`Claude sign-in: token exchange failed (${tok.code ?? 'HTTP ' + tok.status}). Try again.`);
      const t = tok.body;
      if (!t.access_token) return fail('Claude sign-in: the answer had no access token.');
      this.secrets!.set(TOKENS, JSON.stringify({ access: t.access_token, refresh: t.refresh_token ?? null } satisfies Tokens));
      const r = this.row();
      this.set({
        client_id: p.clientId,
        email: t.account?.email_address ?? t.email ?? r.email,
        scopes: t.scope ?? c.scopes,
        expires_at: t.expires_in ? new Date(this.now() + t.expires_in * 1000).toISOString() : null,
        signed_in_at: new Date(this.now()).toISOString(),
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
    const urls = [c.tokenUrl, ...DEFAULT_TOKEN_URLS.filter((u) => u !== c.tokenUrl)];
    let lastError: { ok: false; status: number; code?: string } = { ok: false, status: 500 };

    for (const tokenUrl of urls) {
      try {
        const payload: Record<string, string> = { ...form, client_id: c.clientId };
        if (c.clientSecret) payload.client_secret = c.clientSecret;

        // Try JSON body first (as Hermes does with axios)
        let res = await this.fetchFn(tokenUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': TOKEN_USER_AGENT,
          },
          body: JSON.stringify(payload),
        });

        // If endpoint expects form-urlencoded (HTTP 415), retry with urlencoded
        if (res.status === 415) {
          const body = new URLSearchParams(payload);
          res = await this.fetchFn(tokenUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              accept: 'application/json',
              'user-agent': TOKEN_USER_AGENT,
            },
            body,
          });
        }

        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.ok) return { ok: true, body: j as never };

        lastError = { ok: false, status: res.status, code: typeof j.error === 'string' ? j.error : undefined };
        if (typeof j.error === 'string' && DEAD_REFRESH.has(j.error)) break;
      } catch (e) {
        lastError = { ok: false, status: 500, code: e instanceof Error ? e.message : String(e) };
      }
    }
    return lastError;
  }

  /** A valid access token, refreshed near expiry (one refresh at a time: refresh tokens may rotate). */
  private async accessToken(c: Config): Promise<string> {
    const t = this.tokens();
    const r = this.row();
    if (!t || !r.client_id) throw new ModelError('Claude plan: not signed in. Use Sign in with Claude on the Models page.');
    if (!r.expires_at || Date.parse(r.expires_at) - this.now() > REFRESH_MARGIN_MS) return t.access;
    if (!t.refresh) {
      this.signedOut('Claude sign-in expired (no refresh token)');
      throw new ModelError('Claude sign-in expired: sign in again on the Models page');
    }
    return (this.refreshing ??= this.refresh(c, t).finally(() => (this.refreshing = null)));
  }

  private async refresh(c: Config, t: Tokens): Promise<string> {
    let out;
    try {
      out = await this.tokenCall(c, { grant_type: 'refresh_token', refresh_token: t.refresh! });
    } catch (e) {
      throw new ModelError(`Claude plan: could not renew the sign-in (${e instanceof Error ? e.message : String(e)}); will retry`, true);
    }
    if (!out.ok) {
      if (out.code && DEAD_REFRESH.has(out.code)) {
        this.signedOut(`Claude sign-in expired (${out.code})`);
        throw new ModelError(`Claude sign-in expired (${out.code}): sign in again on the Models page`);
      }
      throw new ModelError(`Claude plan: renewing the sign-in failed (${out.code ?? 'HTTP ' + out.status})`, out.status >= 500);
    }
    const b = out.body;
    this.secrets!.set(TOKENS, JSON.stringify({ access: b.access_token, refresh: b.refresh_token ?? t.refresh } satisfies Tokens));
    this.set({ expires_at: b.expires_in ? new Date(this.now() + b.expires_in * 1000).toISOString() : null, ...(b.scope ? { scopes: b.scope } : {}) });
    return b.access_token;
  }

  private signedOut(reason: string): void {
    this.secrets?.delete(TOKENS);
    this.set({ expires_at: null, last_error: reason + ': sign in again.' });
    this.emit();
  }

  /** Sign out: revoke at Anthropic when a revocation URL is set, then forget the tokens. */
  async logout(): Promise<ClaudePlanStatus> {
    this.cancel();
    const t = this.tokens();
    const { config: c } = this.config();
    let note: string | null = null;
    if (t && c.revokeUrl) {
      try {
        const body = new URLSearchParams({ token: t.refresh ?? t.access, token_type_hint: t.refresh ? 'refresh_token' : 'access_token', client_id: c.clientId });
        if (c.clientSecret) body.set('client_secret', c.clientSecret);
        const res = await this.fetchFn(c.revokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': TOKEN_USER_AGENT }, body });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        note = `Signed out here, but Anthropic did not confirm the session was revoked (${e instanceof Error ? e.message : String(e)}).`;
      }
    }
    this.secrets?.delete(TOKENS);
    this.set({ client_id: null, scopes: null, expires_at: null, paused_until: null, last_error: note });
    this.emit();
    return this.status();
  }

  private ready(): Config {
    const s = this.status();
    if (!s.available) throw new ModelError(s.unavailableReason!);
    const { config, problems } = this.config();
    if (problems.length) throw new ModelError(`Claude plan is not set up: ${problems.join(' ')} (Models page → Claude plan)`);
    if (!s.signedIn) throw new ModelError('Claude plan: not signed in. Use Sign in with Claude on the Models page.');
    if (s.pausedUntil) throw new ModelError(`Claude plan limit reached: paused until ${new Date(s.pausedUntil).toLocaleString()} (or Resume on the Models page).`);
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

  /** Models this account can use (Anthropic's GET /v1/models with the plan's token). */
  async models(): Promise<ClaudePlanModel[]> {
    const c = this.ready();
    const token = await this.accessToken(c);
    const res = await this.fetchFn(c.apiBase + '/v1/models?limit=100', {
      headers: { ...c.headers, authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'user-agent': 'claude-code/2.1.0' },
    });
    if (res.status === 401) this.signedOut('Anthropic refused the access token (HTTP 401)');
    if (!res.ok) throw new ModelError(`Claude models: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as { data?: { id: string; display_name?: string }[] };
    return (j.data ?? []).map((m) => ({ id: m.id, displayName: m.display_name ?? m.id }));
  }

  provider(): Provider {
    this.ready();
    return {
      complete: async (req, onText, signal) => {
        const c = this.ready();
        const token = await this.accessToken(c);
        const p = new AnthropicProvider(null, { authToken: token, baseURL: c.apiBase, headers: c.headers, maxRetries: 0, fetch: this.fetchFn });
        try {
          return await p.complete(req, onText, signal);
        } catch (e) {
          if (e instanceof AnthropicError && e.status === 401) {
            this.signedOut('Anthropic refused the access token (HTTP 401)');
            throw new ModelError('Claude plan: Anthropic refused the sign-in (HTTP 401): sign in again on the Models page');
          }
          if (e instanceof AnthropicError && e.status === 429) {
            const until = new Date(this.now() + resetIn(e.headers, this.now()));
            this.set({ paused_until: until.toISOString(), last_error: `Claude plan limit reached (HTTP 429). Requests resume at ${until.toLocaleString()}.` });
            this.emit();
            throw new ModelError(`Claude plan limit reached: paused until ${until.toLocaleString()}`, true);
          }
          throw e;
        }
      },
    };
  }

  private close(p: Pending): void {
    clearTimeout(p.timer);
    if (p.server) {
      p.server.close();
      p.server.closeAllConnections();
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

/** How long a 429 pauses the plan: retry-after, else the latest *-reset header Anthropic sent, else a minute. */
export function resetIn(h: Headers | null, now: number): number {
  const retry = Number(h?.get('retry-after'));
  if (retry > 0) return retry * 1000;
  let latest = 0;
  h?.forEach((v, k) => {
    if (!k.startsWith('anthropic-ratelimit-') || !k.endsWith('-reset')) return;
    const t = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v);
    if (t > latest) latest = t;
  });
  return latest > now ? latest - now : DEFAULT_LIMIT_PAUSE_MS;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function page(ok: boolean, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Atlas · Claude</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f7f8;color:#1d1f21}
main{max-width:420px;padding:28px;border:1px solid #e3e6e8;border-radius:14px;background:#fff}h1{font-size:18px;margin:0 0 8px}</style>
<main><h1>${ok ? 'Connected to Claude' : 'Not connected'}</h1><p>${esc(message)}</p></main>`;
}
