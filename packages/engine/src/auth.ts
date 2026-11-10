import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type express from 'express';

/**
 * Access control (design §12).
 *
 * Server mode (a VPS behind Caddy/Tailscale): the engine is started with a password (env ATLAS_PASSWORD). Logging in
 * sets a session cookie: a token with an expiry, signed with a key derived from the password, so changing the password
 * ends every session and a restart ends none. Nothing about sessions is stored.
 *
 * Every mode: a browser request coming from another site is refused. The engine listens on localhost, where any web
 * page the user opens could otherwise POST to it (no-cors requests need no preflight) or reach it by DNS rebinding.
 */

export const SESSION_COOKIE = 'atlas_session';
const SESSION_DAYS = 30;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const b64url = (b: Buffer) => b.toString('base64url');

export const isLoopbackHost = (host: string) => LOOPBACK.has(host.toLowerCase());

/** "localhost:4317" → "localhost", "[::1]:80" → "[::1]". */
function hostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const m = /^(\[[^\]]+\]|[^:]+)(:\d+)?$/.exec(hostHeader.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export class Auth {
  private readonly key: Buffer | null;
  /** Failed logins per client address: refuse further tries until `until`. */
  private failures = new Map<string, { count: number; until: number }>();

  /** `password` null: no login (desktop, local dev); requests are still checked for cross-site origin. */
  constructor(
    password: string | null,
    private now: () => number = Date.now,
  ) {
    if (password !== null && password.length < 12) throw new Error('ATLAS_PASSWORD must be at least 12 characters');
    this.key = password === null ? null : createHmac('sha256', 'atlas-session-v1').update(password).digest();
    this.passwordDigest = password === null ? null : sha256(password);
  }
  private readonly passwordDigest: Buffer | null;

  get enabled(): boolean {
    return this.key !== null;
  }

  /** A new session token: v1.<expiry ms>.<random>.<signature>. */
  issue(): { token: string; maxAgeMs: number } {
    const maxAgeMs = SESSION_DAYS * 86_400_000;
    const body = `v1.${this.now() + maxAgeMs}.${b64url(randomBytes(18))}`;
    return { token: `${body}.${this.sign(body)}`, maxAgeMs };
  }

  /** True if the token was issued by this engine with the current password and hasn't expired. */
  verify(token: string | undefined): boolean {
    if (!this.key || !token) return false;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return false;
    const body = parts.slice(0, 3).join('.');
    const given = Buffer.from(parts[3]!, 'base64url');
    const want = Buffer.from(this.sign(body), 'base64url');
    if (given.length !== want.length || !timingSafeEqual(given, want)) return false;
    return Number(parts[1]) > this.now();
  }

  /**
   * Check a login attempt. After 5 failures from one address, further attempts are refused for a minute, doubling
   * each time (a guessing bot gets a handful of tries per hour).
   */
  login(password: unknown, client: string): { ok: true } | { ok: false; status: number; error: string } {
    if (!this.passwordDigest) return { ok: false, status: 405, error: 'this engine has no login (no ATLAS_PASSWORD)' };
    const f = this.failures.get(client);
    if (f && f.until > this.now()) return { ok: false, status: 429, error: `too many wrong passwords; try again in ${Math.ceil((f.until - this.now()) / 1000)} s` };
    if (typeof password === 'string' && password && timingSafeEqual(sha256(password), this.passwordDigest)) {
      this.failures.delete(client);
      return { ok: true };
    }
    const count = (f?.count ?? 0) + 1;
    this.failures.set(client, { count, until: count >= 5 ? this.now() + 60_000 * 2 ** (count - 5) : 0 });
    return { ok: false, status: 401, error: 'wrong password' };
  }

  /** The session token in a request's cookies, if any. */
  tokenOf(req: IncomingMessage): string | undefined {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === SESSION_COOKIE) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return undefined;
  }

  authenticated(req: IncomingMessage): boolean {
    return !this.enabled || this.verify(this.tokenOf(req));
  }

  /**
   * Why a request must be refused as cross-site, or null if it may go on.
   * - Origin header (sent by browsers on cross-origin requests and WebSockets): must be this host, or loopback when
   *   the engine itself is reached on loopback (the Vite dev server proxies from another port).
   * - Without login, the Host must be loopback: a public DNS name pointing at 127.0.0.1 (rebinding) is refused.
   */
  crossSite(req: IncomingMessage): string | null {
    const host = hostname(req.headers.host);
    if (!host) return 'missing Host header';
    if (!this.enabled && !isLoopbackHost(host)) return `host ${host} refused: without ATLAS_PASSWORD the engine only answers on localhost`;
    const origin = req.headers.origin;
    if (!origin || origin === 'null') return origin === 'null' ? 'opaque origin refused' : null;
    let o: URL;
    try {
      o = new URL(origin);
    } catch {
      return `bad origin ${origin}`;
    }
    const sameHost = o.host.toLowerCase() === (req.headers.host ?? '').toLowerCase();
    if (sameHost || (isLoopbackHost(host) && isLoopbackHost(o.hostname))) return null; // URL keeps IPv6 brackets: "[::1]"
    return `cross-site request from ${origin} refused`;
  }

  cookieOptions(req: express.Request, maxAgeMs: number): express.CookieOptions {
    return { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/', maxAge: maxAgeMs };
  }

  private sign(body: string): string {
    return b64url(createHmac('sha256', this.key!).update(body).digest());
  }
}
