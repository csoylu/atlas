import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';

type JsonWebKey = import('node:crypto').JsonWebKeyInput['key'];
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UpdateChatGpt, type ChatGptModel, type ChatGptStatus } from '@atlas/shared';
import type { Bus } from './events.ts';
import type { SecretStore } from './secrets.ts';
import { chatgptQuota, rawLimitHeaders, type PlanAccounts, type PlanRow } from './plan-accounts.ts';
import { ConflictError } from './kanban.ts';
import { ModelError, type Provider } from './providers/types.ts';
import { ChatGptProvider, type PlanAccess } from './providers/chatgpt.ts';

/**
 * The user's ChatGPT plan in Atlas, through OpenAI's « Sign in with ChatGPT » for open-source, locally hosted apps
 * (developers.openai.com/siwc, design §5). Atlas registers itself under its own name (dynamic registration, no
 * borrowed client id) and keeps the tokens in the keychain. Several ChatGPT subscriptions can be signed in; a usage
 * limit pauses one and the work moves to the next (plan-accounts.ts). The user chose this knowing OpenAI's terms ask for
 * one account without rotation around limits (11 Nov 2026, design §5).
 */
export interface ChatGptOptions {
  authBase?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  /** Loopback callback port: 1455 as in OpenAI's examples, any free port if taken (0 in tests). */
  port?: number;
  now?: () => number;
}

interface Tokens {
  access: string;
  refresh: string;
  idToken: string;
}
interface Pending {
  accountId: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  /** Issued client id for a returning account; null = first registration (dynamic_agent_client). */
  clientId: string | null;
  server: Server;
  timer: NodeJS.Timeout;
}
interface OidcConfig {
  issuer: string;
  jwks_uri: string;
  revocation_endpoint?: string;
}

export const APP_NAME = 'Atlas';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const RESOURCE = 'https://api.openai.com/v1';
/** Refresh when the access token (1 h) has less than this left. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
/** Refresh errors that mean the refresh token is dead: sign in again. */
const DEAD_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

const b64url = (b: Buffer) => b.toString('base64url');

export class ChatGpt {
  private pending: Pending | null = null;
  private refreshing = new Map<string, Promise<string>>();
  private oidc: OidcConfig | null = null;
  private readonly authBase: string;
  private readonly apiBase: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(
    private bus: Bus,
    private secrets: SecretStore | undefined,
    private plans: PlanAccounts,
    private o: ChatGptOptions = {},
  ) {
    this.authBase = o.authBase ?? 'https://auth.openai.com';
    this.apiBase = o.apiBase ?? RESOURCE;
    this.fetchFn = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    plans.onChange.chatgpt = () => this.emit();
  }

  /** This machine's opaque host id: made once, kept across sign-outs and for every account. */
  private hostId(): string {
    return this.plans.setting('chatgpt_host_id', () => 'urn:uuid:' + randomUUID());
  }
  private rows(): PlanRow[] {
    return this.plans.rows('chatgpt');
  }
  private tokens(r: PlanRow): Tokens | null {
    return this.plans.tokens<Tokens>(r);
  }
  private signedIn(r: PlanRow): boolean {
    return !!this.tokens(r) && !!r.client_id;
  }
  private planUsage(r: PlanRow): boolean {
    return this.signedIn(r) && (r.scopes ?? '').split(' ').includes(PLAN_SCOPE);
  }
  private emit(): void {
    this.bus.emit({ type: 'chatgpt.updated', status: this.status() });
  }

  status(): ChatGptStatus {
    const rows = this.rows();
    const accounts = rows.map((r) => this.plans.view(r, this.signedIn(r), this.planUsage(r)));
    const live = accounts.filter((a) => a.signedIn);
    const planUsage = live.some((a) => a.planUsage);
    const all = this.plans.allPausedUntil('chatgpt', (r) => this.planUsage(r));
    return {
      available: !!this.secrets,
      unavailableReason: this.secrets ? null : 'ChatGPT sign-in works in the desktop app: a server engine has no keychain to keep the tokens in.',
      signedIn: live.length > 0,
      pending: !!this.pending,
      pendingAccountId: this.pending?.accountId ?? null,
      email: live[0]?.email ?? accounts[0]?.email ?? null,
      planUsage,
      showWelcome: planUsage && !this.plans.welcomed('chatgpt'),
      pausedAt: all.paused ? all.since : null,
      lastError: (live.length ? live : accounts).find((a) => a.lastError)?.lastError ?? null,
      accounts,
    };
  }

  update(patch: UpdateChatGpt): ChatGptStatus {
    const p = UpdateChatGpt.parse(patch);
    if (p.welcomed) this.plans.setWelcomed('chatgpt');
    if (p.resume) for (const r of this.rows()) this.plans.set(r.id, { paused_at: null, paused_until: null, last_error: null });
    this.emit();
    return this.status();
  }

  private async config(): Promise<OidcConfig> {
    if (this.oidc) return this.oidc;
    const res = await this.fetchFn(this.authBase + '/.well-known/openid-configuration');
    if (!res.ok) throw new Error(`OpenAI sign-in configuration: HTTP ${res.status}`);
    return (this.oidc = (await res.json()) as OidcConfig);
  }

  /**
   * Start a sign-in: a loopback listener for the callback, then the URL to open in the system browser. A saved
   * registration (issued client id) is reused; the first one registers Atlas under its own name.

  /**
   * Start a sign-in for one subscription (default: the first, made when there is none): a loopback listener for the
   * callback, then the URL to open in the system browser. The account's registration (issued client id) is reused;
   * its first sign-in registers Atlas under its own name.
   */
  async login(accountId?: string | null): Promise<{ url: string }> {
    if (!this.secrets) throw new ConflictError(this.status().unavailableReason!);
    this.cancel();
    const r = this.plans.forLogin('chatgpt', accountId);
    const server = createServer();
    await listen(server, this.o.port ?? 1455);
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    const verifier = b64url(randomBytes(32));
    const p: Pending = {
      accountId: r.id,
      state: b64url(randomBytes(24)),
      nonce: b64url(randomBytes(24)),
      verifier,
      redirectUri,
      clientId: r.client_id,
      server,
      timer: setTimeout(() => {
        this.cancel();
        this.emit();
      }, LOGIN_TIMEOUT_MS),
    };
    this.pending = p;
    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      if (u.pathname !== '/auth/callback') {
        res.writeHead(404).end();
        return;
      }
      void this.callback(p, u.searchParams).then((out) => {
        res.writeHead(out.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' }).end(page(out.ok, out.message));
        // A stray request (wrong state) leaves the sign-in open; anything else ends it.
        if (!out.retry) this.close(p);
      });
    });

    const q = new URLSearchParams({
      response_type: 'code',
      client_id: r.client_id ?? 'dynamic_agent_client',
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state: p.state,
      nonce: p.nonce,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      ext_agent_host_id: this.hostId(),
    });
    if (!r.client_id) q.set('agent_name_hint', APP_NAME);
    else {
      if (r.email) q.set('login_hint', r.email);
      const t = this.tokens(r);
      if (t?.idToken) q.set('id_token_hint', t.idToken);
      // Signed in without plan usage and asking again: show the consent screen again.
      if (t && !(r.scopes ?? '').split(' ').includes(PLAN_SCOPE)) q.set('prompt', 'consent');
    }
    this.emit();
    return { url: `${this.authBase}/api/accounts/authorize?${q}` };
  }

  /** The browser came back. Every check passes before anything replaces the stored sign-in. */
  private async callback(p: Pending, q: URLSearchParams): Promise<{ ok: boolean; message: string; retry?: boolean }> {
    if (q.get('state') !== p.state) return { ok: false, message: 'This sign-in link is not the one Atlas opened. Start again from Atlas.', retry: true };
    const fail = (message: string) => {
      this.plans.set(p.accountId, { last_error: message });
      this.emit();
      return { ok: false, message };
    };
    const err = q.get('error');
    if (err) return fail(err === 'access_denied' ? 'ChatGPT sign-in was declined.' : `ChatGPT sign-in failed: ${err} ${q.get('error_description') ?? ''}`.trim());
    const code = q.get('code');
    const returned = q.get('client_id');
    // First registration: the callback carries the issued id. Returning: it must not change.
    const clientId = p.clientId ?? returned;
    if (!code || !clientId || clientId === 'dynamic_agent_client') return fail('ChatGPT sign-in did not finish the registration (no client id). Try again.');
    if (p.clientId && returned && returned !== p.clientId) return fail('ChatGPT answered for another registration of Atlas; nothing was changed.');
    try {
      const tok = await this.tokenCall({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri });
      if (!tok.ok) return fail(`ChatGPT sign-in: token exchange failed (${tok.code ?? tok.status}). Try again.`);
      const t = tok.body;
      if (!t.id_token || !t.refresh_token) return fail('ChatGPT sign-in: the answer had no ID token or refresh token.');
      const id = await this.verifyIdToken(t.id_token, clientId, p.nonce);
      const r = this.plans.row(p.accountId);
      if (r.subject && r.client_id === clientId && r.subject !== id.sub) return fail('That is another ChatGPT account than the one this subscription is registered with; nothing was changed. Add it as a new subscription.');
      const twin = this.rows().find((o) => o.id !== r.id && o.subject === id.sub && this.tokens(o));
      if (twin) return fail(`That ChatGPT account is already signed in as « ${twin.label} »; sign in with another one.`);
      this.plans.setTokens(r, { access: t.access_token, refresh: t.refresh_token, idToken: t.id_token } satisfies Tokens);
      const scopes = t.scope ?? '';
      this.plans.set(r.id, {
        client_id: clientId,
        subject: id.sub,
        email: id.email ?? r.email,
        scopes,
        expires_at: new Date(this.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
        signed_in_at: new Date(this.now()).toISOString(),
        last_error: null,
      });
      this.emit();
      return scopes.split(' ').includes(PLAN_SCOPE)
        ? { ok: true, message: 'Atlas can now use your ChatGPT plan. You can close this tab and go back to Atlas.' }
        : { ok: true, message: 'Signed in, but using your ChatGPT plan was not allowed. Atlas sends no requests until you allow it.' };
    } catch (e) {
      return fail(`ChatGPT sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** ID token per OIDC: OpenAI's signature (JWKS), issuer, audience = our issued client id, expiry, our nonce. */
  private async verifyIdToken(token: string, clientId: string, nonce: string): Promise<{ sub: string; email?: string }> {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) throw new Error('malformed ID token');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as { iss?: string; aud?: string | string[]; exp?: number; nonce?: string; sub?: string; email?: string };
    if (header.alg !== 'RS256') throw new Error(`ID token algorithm ${header.alg} not accepted`);
    const cfg = await this.config();
    const jwks = (await (await this.fetchFn(cfg.jwks_uri)).json()) as { keys: (JsonWebKey & { kid?: string })[] };
    const jwk = jwks.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error('ID token signed with an unknown key');
    if (!verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url')))
      throw new Error('ID token signature is invalid');
    if (claims.iss !== cfg.issuer) throw new Error('ID token issuer mismatch');
    if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(clientId)) throw new Error('ID token audience mismatch');
    if (!claims.exp || claims.exp * 1000 < this.now()) throw new Error('ID token expired');
    if (claims.nonce !== nonce) throw new Error('ID token nonce mismatch');
    if (!claims.sub) throw new Error('ID token has no subject');
    return { sub: claims.sub, email: claims.email };
  }

  private async tokenCall(form: Record<string, string>): Promise<
    | { ok: true; body: { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number; scope?: string } }
    | { ok: false; status: number; code?: string }
  > {
    const res = await this.fetchFn(this.authBase + '/api/accounts/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...form, resource: RESOURCE }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, code: typeof body.error === 'string' ? body.error : (body.error as { code?: string })?.code };
    return { ok: true, body: body as never };
  }

  /** A valid access token, refreshed near expiry (one refresh at a time: the refresh token rotates). */

  /** A valid access token for one account, refreshed near expiry (one refresh at a time: the refresh token rotates). */
  private async accessToken(id: string): Promise<string> {
    const r = this.plans.row(id);
    const t = this.tokens(r);
    if (!t || !r.client_id) throw new ModelError(`ChatGPT « ${r.label} »: not signed in. Use Continue with ChatGPT in Settings → Subscriptions.`);
    if (r.expires_at && Date.parse(r.expires_at) - this.now() > REFRESH_MARGIN_MS) return t.access;
    const running = this.refreshing.get(id);
    if (running) return running;
    const next = this.refresh(r, t, r.client_id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, next);
    return next;
  }

  private async refresh(r: PlanRow, t: Tokens, clientId: string): Promise<string> {
    let out;
    try {
      out = await this.tokenCall({ grant_type: 'refresh_token', client_id: clientId, refresh_token: t.refresh });
    } catch (e) {
      throw new ModelError(`ChatGPT: could not renew the sign-in (${e instanceof Error ? e.message : String(e)}); will retry`, true);
    }
    if (!out.ok) {
      if (out.code && DEAD_REFRESH.has(out.code)) {
        this.signedOut(r, `ChatGPT sign-in expired (${out.code})`);
        throw new ModelError(`ChatGPT sign-in « ${r.label} » expired (${out.code}): sign in again in Settings → Subscriptions`);
      }
      if (out.status >= 500) throw new ModelError(`ChatGPT: renewing the sign-in failed (HTTP ${out.status}); will retry`, true);
      throw new ModelError(`ChatGPT: renewing the sign-in failed (${out.code ?? 'HTTP ' + out.status})`);
    }
    const b = out.body;
    this.plans.setTokens(r, { access: b.access_token, refresh: b.refresh_token ?? t.refresh, idToken: b.id_token ?? t.idToken } satisfies Tokens);
    this.plans.set(r.id, {
      expires_at: new Date(this.now() + (b.expires_in ?? 3600) * 1000).toISOString(),
      ...(b.scope ? { scopes: b.scope } : {}),
    });
    return b.access_token;
  }

  /** Tokens are dead (refused or expired): forget them, keep the registration for the next sign-in. */
  private signedOut(r: PlanRow, reason: string): void {
    this.plans.dropTokens(r);
    this.plans.set(r.id, { scopes: null, expires_at: null, last_error: reason + ': sign in again.' });
    this.emit();
  }

  /** Sign one account out (default: the first): revoke the renewable session at OpenAI, then clear the tokens. */
  async logout(accountId?: string | null): Promise<ChatGptStatus> {
    const r = accountId ? this.plans.row(accountId) : this.rows()[0];
    if (!r) return this.status();
    if (this.pending?.accountId === r.id) this.cancel();
    const t = this.tokens(r);
    let note: string | null = null;
    if (t && r.client_id) {
      try {
        const end = (await this.config()).revocation_endpoint;
        if (!end) throw new Error('no revocation endpoint');
        const res = await this.fetchFn(end, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: t.refresh, token_type_hint: 'refresh_token', client_id: r.client_id }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        note = `Signed out here, but OpenAI did not confirm the session was revoked (${e instanceof Error ? e.message : String(e)}). You can disconnect Atlas in ChatGPT settings.`;
      }
    }
    this.plans.dropTokens(r);
    this.plans.set(r.id, { scopes: null, expires_at: null, paused_at: null, paused_until: null, last_error: note });
    this.emit();
    return this.status();
  }

  /** Sign out and forget a subscription. */
  async remove(accountId: string): Promise<ChatGptStatus> {
    await this.logout(accountId);
    this.plans.remove(accountId);
    return this.status();
  }

  /** Models the first usable account can use, for the model picker. */
  async models(): Promise<ChatGptModel[]> {
    const live = this.rows().filter((r) => this.planUsage(r));
    const r = live.find((x) => !this.plans.paused(x)) ?? live[0] ?? this.rows().find((x) => this.signedIn(x));
    if (!r) throw new ModelError('ChatGPT: not signed in. Use Continue with ChatGPT in Settings → Subscriptions.');
    const token = await this.accessToken(r.id);
    const res = await this.fetchFn(this.apiBase + '/models', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new ModelError(`ChatGPT models: HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = (await res.json()) as { models?: { slug: string; display_name?: string; visibility?: string }[] };
    return (j.models ?? []).filter((m) => m.visibility === 'list').map((m) => ({ slug: m.slug, displayName: m.display_name ?? m.slug }));
  }

  /** Why the plan can't be used, or null (same protections for every request). */
  problem(): string | null {
    const s = this.status();
    if (!s.available) return s.unavailableReason;
    if (!s.signedIn) return 'ChatGPT: not signed in. Use Continue with ChatGPT in Settings → Subscriptions.';
    if (!s.planUsage) return 'ChatGPT: using your plan was not allowed at sign-in. Allow it in Settings → Subscriptions.';
    if (s.pausedAt) return this.plans.exhausted('chatgpt', this.rows().filter((r) => this.planUsage(r))).message;
    return null;
  }

  /** Calls go to the subscriptions that allowed plan use, in order; a usage limit moves the call to the next one. */
  provider(): Provider {
    const bad = this.problem();
    if (bad) {
      const s = this.status();
      throw s.pausedAt ? this.plans.exhausted('chatgpt', this.rows().filter((r) => this.planUsage(r))) : new ModelError(bad);
    }
    return {
      complete: (req, onText, signal) =>
        this.plans.call(
          'chatgpt',
          (r) => this.planUsage(r),
          (r, onStream) => {
            const access: PlanAccess = {
              token: () => this.accessToken(r.id),
              signedOut: (reason) => this.signedOut(this.plans.row(r.id), reason),
              onHeaders: (h) => this.plans.recordQuota(r.id, chatgptQuota(h, this.now()), rawLimitHeaders(h)),
              now: this.now,
            };
            return new ChatGptProvider(access, this.apiBase, this.fetchFn).complete(req, (t, kind) => (onStream(), onText(t, kind)), signal);
          },
        ),
    };
  }

  private close(p: Pending): void {
    clearTimeout(p.timer);
    p.server.close();
    p.server.closeAllConnections();
    if (this.pending === p) {
      this.pending = null;
      this.emit();
    }
  }
  /** Drop an open sign-in (a new one replaces it; stop() on engine shutdown). */
  cancel(): void {
    if (this.pending) this.close(this.pending);
  }
  stop(): void {
    this.cancel();
  }
}

/** Listen on 127.0.0.1 (never localhost, per OpenAI): the preferred port, or any free one if it's taken. */
function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && p !== 0) tryPort(0);
        else reject(e);
      });
      server.listen(p, '127.0.0.1', () => resolve());
    };
    tryPort(port);
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function page(ok: boolean, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Atlas · ChatGPT</title>
<style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f6f7f8;color:#1d1f21}
main{max-width:420px;padding:28px;border:1px solid #e3e6e8;border-radius:14px;background:#fff}h1{font-size:18px;margin:0 0 8px}</style>
<main><h1>${ok ? 'Connected to ChatGPT' : 'Not connected'}</h1><p>${esc(message)}</p></main>`;
}
