import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { Db } from './store/db.ts';
import { decodeEntities } from './web.ts';

/**
 * Site icons for web search and fetch results in the chat (#361). `GET /api/favicon?domain=<host>` asks here: the icon
 * comes from the site itself (its page's `<link rel="icon">`, else `/favicon.ico`), never from a third-party service,
 * and is kept in SQLite (table `favicons`), misses too, so each domain is fetched once (again after HIT_TTL / MISS_TTL).
 *
 * The engine fetches on behalf of a page, so it only reaches public hosts (SSRF): a valid host name (no IP literal, no
 * localhost), every address it resolves to public (checked in the socket's own lookup, so the address connected to is
 * the one checked), redirects included (at most MAX_REDIRECTS). One deadline for the whole discovery, capped reads,
 * and only `image/*` answers count as an icon.
 */

export const HIT_TTL_MS = 30 * 24 * 3600_000;
export const MISS_TTL_MS = 24 * 3600_000;
export const TIMEOUT_MS = 5_000;
export const MAX_REDIRECTS = 3;
export const MAX_HTML_BYTES = 256 * 1024;
export const MAX_ICON_BYTES = 100 * 1024;

export interface Favicon {
  bytes: Buffer;
  contentType: string;
}

export interface FaviconOptions {
  /** Tests: another resolver (name → addresses). */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Tests: the site's home page URL for a domain (default `https://<domain>/`), e.g. a local server's port. */
  home?: (domain: string) => string;
  /** Tests: treat 127.0.0.1 as public (a local fake site). Every other private address stays refused. */
  loopbackOk?: boolean;
  now?: () => number;
  timeoutMs?: number;
}

/** Why a host or address may not be reached: refused, not retried. */
export class FaviconRefused extends Error {}

/** A host name the engine may look up: lower-case labels, at least one dot, no IP literal, not localhost. */
export function validHost(domain: string): string | null {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!d || d.length > 253 || isIP(d) || isIP(d.replace(/^\[|\]$/g, ''))) return null;
  const labels = d.split('.');
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  if (/^\d+$/.test(labels.at(-1)!)) return null;
  if (d === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(d)) return null;
  return d;
}

const v4 = (a: string) => a.split('.').map(Number) as [number, number, number, number];

/** A public unicast address: not loopback, private, link-local, CGNAT, multicast, reserved or unspecified. */
export function publicAddress(ip: string): boolean {
  let a = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1]!;
  if (isIP(a) === 4) {
    const [x, y] = v4(a);
    if (x === 0 || x === 10 || x === 127 || x >= 224) return false;
    if (x === 169 && y === 254) return false;
    if (x === 172 && y >= 16 && y <= 31) return false;
    if (x === 192 && y === 168) return false;
    if (x === 100 && y >= 64 && y <= 127) return false;
    if (x === 192 && y === 0 && v4(a)[2] === 0) return false;
    if (x === 198 && (y === 18 || y === 19)) return false;
    return true;
  }
  if (isIP(a) === 6) {
    if (a === '::' || a === '::1') return false;
    if (/^f[cd]/.test(a)) return false; // unique local fc00::/7
    if (/^fe[89ab]/.test(a)) return false; // link-local fe80::/10
    if (/^ff/.test(a)) return false; // multicast
    if (/^::ffff:/.test(a) || /^64:ff9b:/.test(a) || /^::(\d|[0-9a-f]{1,4}:)/.test(a)) return false; // mapped, NAT64, compat
    return true;
  }
  return false;
}

interface Got {
  status: number;
  url: URL;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

export class Favicons {
  private inflight = new Map<string, Promise<Favicon | null>>();
  private now: () => number;

  constructor(
    private db: Db,
    private opts: FaviconOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** The icon of `domain` (cached, else fetched once, concurrent asks share it); null: none. Throws on an invalid host. */
  async get(domain: string): Promise<Favicon | null> {
    const host = validHost(domain);
    if (!host) throw new FaviconRefused(`not a public host name: ${domain}`);
    const row = this.db.prepare('SELECT bytes, content_type, fetched_at FROM favicons WHERE domain = ?').get(host) as
      | { bytes: Buffer | null; content_type: string | null; fetched_at: string }
      | undefined;
    if (row) {
      const age = this.now() - Date.parse(row.fetched_at);
      if (row.bytes && row.content_type && age < HIT_TTL_MS) return { bytes: row.bytes, contentType: row.content_type };
      if (!row.bytes && age < MISS_TTL_MS) return null;
    }
    let p = this.inflight.get(host);
    if (!p) {
      p = this.fetchAndStore(host).finally(() => this.inflight.delete(host));
      this.inflight.set(host, p);
    }
    return p;
  }

  private async fetchAndStore(host: string): Promise<Favicon | null> {
    let icon: Favicon | null = null;
    let error: string | null = null;
    try {
      icon = await this.discover(host);
      if (!icon) error = 'no icon';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    this.db
      .prepare(
        `INSERT INTO favicons (domain, bytes, content_type, error, fetched_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET bytes = excluded.bytes, content_type = excluded.content_type, error = excluded.error, fetched_at = excluded.fetched_at`,
      )
      .run(host, icon?.bytes ?? null, icon?.contentType ?? null, error, new Date(this.now()).toISOString());
    return icon;
  }

  /** The page's `<link rel=icon>` (else apple-touch-icon), then `/favicon.ico`: the first image answer wins. */
  private async discover(host: string): Promise<Favicon | null> {
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS);
    const home = new URL(this.opts.home?.(host) ?? `https://${host}/`);
    const candidates: URL[] = [];
    try {
      const page = await this.get1(home, signal, MAX_HTML_BYTES, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5');
      if (page.status >= 200 && page.status < 300 && /html/i.test(page.contentType)) {
        const href = iconHref(page.body.toString('utf8'));
        if (href) {
          try {
            const u = new URL(href, page.url);
            if (u.protocol === 'http:' || u.protocol === 'https:') candidates.push(u);
          } catch {
            // A broken href: the /favicon.ico fallback below.
          }
        }
      }
    } catch (e) {
      // A refused host or the deadline stops everything; any other failure of the page leaves the fallback to try.
      if (e instanceof FaviconRefused || signal.aborted) throw e;
    }
    const ico = new URL('/favicon.ico', home);
    if (!candidates.some((c) => c.href === ico.href)) candidates.push(ico);
    let last: string | null = null;
    for (const u of candidates) {
      try {
        const got = await this.get1(u, signal, MAX_ICON_BYTES, 'image/*');
        const type = got.contentType.split(';')[0]!.trim().toLowerCase();
        if (got.status < 200 || got.status >= 300) last = `HTTP ${got.status} from ${got.url.href}`;
        else if (!type.startsWith('image/')) last = `${got.url.href} is not an image (${type || 'no content type'})`;
        else if (got.truncated) last = `${got.url.href} is over ${MAX_ICON_BYTES} bytes`;
        else if (!got.body.length) last = `${got.url.href} is empty`;
        else return { bytes: got.body, contentType: type };
      } catch (e) {
        if (e instanceof FaviconRefused || signal.aborted) throw e;
        last = e instanceof Error ? e.message : String(e);
      }
    }
    if (last) throw new Error(last);
    return null;
  }

  /** GET `url`, following at most MAX_REDIRECTS redirects, each hop to a public host only; the body capped at `max`. */
  private async get1(url: URL, signal: AbortSignal, max: number, accept: string): Promise<Got> {
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FaviconRefused(`only http(s), not ${url.protocol}`);
      if (!validHost(url.hostname)) throw new FaviconRefused(`not a public host name: ${url.hostname}`);
      const got = await this.request(url, signal, max, accept);
      if (got.status >= 300 && got.status < 400 && got.location !== null) {
        if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${url.href}`);
        url = new URL(got.location, url);
        continue;
      }
      return got;
    }
  }

  /** One request, connected only to the public addresses the name resolves to (the check is in the socket's lookup). */
  private request(url: URL, signal: AbortSignal, max: number, accept: string): Promise<Got & { location: string | null }> {
    const resolve = this.opts.resolve ?? ((h: string) => dnsLookup(h, { all: true }));
    const loopbackOk = !!this.opts.loopbackOk;
    const lookup: LookupFunction = (hostname, options, cb) => {
      resolve(hostname).then(
        (addrs) => {
          if (!addrs.length) return cb(new Error(`${hostname} does not resolve`), '', 4);
          const bad = addrs.find((a) => !(publicAddress(a.address) || (loopbackOk && a.address === '127.0.0.1')));
          if (bad) return cb(new FaviconRefused(`${hostname} resolves to a private address (${bad.address})`), '', 4);
          if (options.all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addrs);
          else cb(null, addrs[0]!.address, addrs[0]!.family);
        },
        (e: unknown) => cb(e instanceof Error ? e : new Error(String(e)), '', 4),
      );
    };
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise((ok, fail) => {
      const req = mod.request(url, { method: 'GET', signal, lookup, agent: false, headers: { 'user-agent': 'Mozilla/5.0 (compatible; Atlas)', accept } }, (res) => {
        const status = res.statusCode ?? 0;
        const location = status >= 300 && status < 400 ? (res.headers.location ?? null) : null;
        const contentType = String(res.headers['content-type'] ?? '');
        if (location !== null) {
          res.destroy();
          return ok({ status, url, contentType, body: Buffer.alloc(0), truncated: false, location });
        }
        const chunks: Buffer[] = [];
        let n = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          n += c.length;
          if (n > max) {
            truncated = true;
            chunks.push(c.subarray(0, c.length - (n - max)));
            res.destroy();
            ok({ status, url, contentType, body: Buffer.concat(chunks), truncated, location: null });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => ok({ status, url, contentType, body: Buffer.concat(chunks), truncated, location: null }));
        res.on('error', (e) => (truncated ? undefined : fail(e)));
        res.on('aborted', () => (truncated ? undefined : fail(new Error(`${url.href}: the answer was cut`))));
      });
      req.on('error', (e) => {
        if (e instanceof FaviconRefused) return fail(e);
        const cause = (e as { cause?: unknown }).cause;
        if (cause instanceof FaviconRefused) return fail(cause);
        fail(signal.aborted ? new Error(`timed out after ${this.opts.timeoutMs ?? TIMEOUT_MS} ms`) : e);
      });
      req.end();
    });
  }
}

/** The icon href of a page: the first `<link rel="icon">` (or "shortcut icon"), else the first apple-touch-icon. */
export function iconHref(html: string): string | null {
  let apple: string | null = null;
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of m[1]!.matchAll(/([a-z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) attrs.set(a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/);
    const href = decodeEntities(attrs.get('href') ?? '').trim();
    if (!href) continue;
    if (rel.includes('icon')) return href;
    if (!apple && (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed'))) apple = href;
  }
  return apple;
}
