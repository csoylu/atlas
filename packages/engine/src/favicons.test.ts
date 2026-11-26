import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launch } from '../test/kit/index.ts';
import { Favicons, MAX_HTML_BYTES, MAX_ICON_BYTES, iconHref, publicAddress, validHost, type FaviconOptions } from './favicons.ts';
import { openDb, type Db } from './store/db.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const ICO = Buffer.from('00000100010010100000', 'hex');

type Route = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/** A fake site on 127.0.0.1: every name the resolver maps there reaches it; routes by host and path. */
let server: http.Server;
let port: number;
let routes: Record<string, Route>;
let hits: string[];

beforeEach(async () => {
  routes = {};
  hits = [];
  server = http.createServer((req, res) => {
    const key = `${(req.headers.host ?? '').split(':')[0]}${req.url}`;
    hits.push(key);
    const r = routes[key];
    if (r) return r(req, res);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const html = (body: string): Route => (_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
const image = (bytes: Buffer, type = 'image/png'): Route => (_req, res) => res.writeHead(200, { 'content-type': type }).end(bytes);
const redirect = (to: string): Route => (_req, res) => res.writeHead(302, { location: to }).end();

/** Names → addresses: *.test is the fake site, private.test a private address. */
const resolve: FaviconOptions['resolve'] = async (h) => {
  if (h === 'private.test') return [{ address: '10.0.0.7', family: 4 }];
  if (h === 'linklocal.test') return [{ address: '169.254.169.254', family: 4 }];
  if (h === 'mixed.test') return [{ address: '127.0.0.1', family: 4 }, { address: '192.168.1.2', family: 4 }];
  return [{ address: '127.0.0.1', family: 4 }];
};

let db: Db;
let clock: number;
const make = (o: FaviconOptions = {}) => new Favicons(db, { resolve, loopbackOk: true, home: (d) => `http://${d}:${port}/`, now: () => clock, ...o });

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.parse('2026-11-26T10:00:00Z');
});

describe('favicons: discovery (#361)', () => {
  it('reads the page\'s <link rel="icon">, resolved against the final URL', async () => {
    routes['site.test/'] = redirect(`http://site.test:${port}/home/`);
    routes['site.test/home/'] = html('<html><head><link rel="stylesheet" href="a.css"><link rel="shortcut icon" href="img/fav.png?v=1&amp;x=2"></head></html>');
    routes['site.test/home/img/fav.png?v=1&x=2'] = image(PNG);
    const icon = await make().get('site.test');
    expect(icon).toEqual({ bytes: PNG, contentType: 'image/png' });
    expect(hits).not.toContain('site.test/favicon.ico');
  });

  it('takes an apple-touch-icon when there is no rel=icon', () => {
    expect(iconHref('<link rel="apple-touch-icon" href="/t.png"><link href="/x.css" rel=stylesheet>')).toBe('/t.png');
    expect(iconHref("<LINK REL='apple-touch-icon' href='/t.png'><link rel=icon href=/i.svg>")).toBe('/i.svg');
    expect(iconHref('<p>no links</p>')).toBeNull();
  });

  it('falls back to /favicon.ico when the page names none', async () => {
    routes['plain.test/'] = html('<html><head><title>x</title></head></html>');
    routes['plain.test/favicon.ico'] = image(ICO, 'image/x-icon');
    expect(await make().get('plain.test')).toEqual({ bytes: ICO, contentType: 'image/x-icon' });
  });

  it('falls back to /favicon.ico when the linked icon fails', async () => {
    routes['broken.test/'] = html('<link rel=icon href="/gone.png">');
    routes['broken.test/favicon.ico'] = image(ICO, 'image/vnd.microsoft.icon');
    expect((await make().get('broken.test'))?.contentType).toBe('image/vnd.microsoft.icon');
  });
});

describe('favicons: the cache', () => {
  it('a hit is served from SQLite without a second fetch, and fetched again after ~30 days', async () => {
    routes['site.test/'] = html('<link rel=icon href=/f.png>');
    routes['site.test/f.png'] = image(PNG);
    const f = make();
    await f.get('site.test');
    const n = hits.length;
    expect(await f.get('SITE.test.')).toEqual({ bytes: PNG, contentType: 'image/png' });
    // A new instance (an engine restart) reads the same row.
    expect(await make().get('site.test')).not.toBeNull();
    expect(hits.length).toBe(n);
    clock += 31 * 24 * 3600_000;
    await f.get('site.test');
    expect(hits.length).toBeGreaterThan(n);
  });

  it('a miss is cached (no fetch for a day), then tried again', async () => {
    const f = make();
    expect(await f.get('none.test')).toBeNull();
    const n = hits.length;
    expect(n).toBe(2); // the page and /favicon.ico
    expect(await f.get('none.test')).toBeNull();
    expect(hits.length).toBe(n);
    const row = db.prepare('SELECT bytes, error FROM favicons WHERE domain = ?').get('none.test') as { bytes: Buffer | null; error: string };
    expect(row.bytes).toBeNull();
    expect(row.error).toMatch(/HTTP 404/);
    clock += 25 * 3600_000;
    routes['none.test/favicon.ico'] = image(ICO, 'image/x-icon');
    expect(await f.get('none.test')).not.toBeNull();
  });

  it('concurrent asks for one domain share one fetch', async () => {
    routes['site.test/'] = html('<link rel=icon href=/f.png>');
    routes['site.test/f.png'] = image(PNG);
    const f = make();
    const all = await Promise.all([f.get('site.test'), f.get('site.test'), f.get('site.test')]);
    expect(all.every((i) => i?.bytes.equals(PNG))).toBe(true);
    expect(hits.filter((h) => h === 'site.test/f.png')).toHaveLength(1);
    expect(hits.filter((h) => h === 'site.test/')).toHaveLength(1);
  });
});

describe('favicons: limits', () => {
  it('refuses an answer that is not an image', async () => {
    routes['text.test/'] = html('<link rel=icon href=/f.png>');
    routes['text.test/f.png'] = html('<script>alert(1)</script>');
    routes['text.test/favicon.ico'] = (_q, r) => r.writeHead(200, { 'content-type': 'application/octet-stream' }).end(ICO);
    expect(await make().get('text.test')).toBeNull();
    expect((db.prepare('SELECT error FROM favicons').get() as { error: string }).error).toMatch(/not an image/);
  });

  it('refuses an icon over the size cap', async () => {
    routes['big.test/favicon.ico'] = image(Buffer.alloc(MAX_ICON_BYTES + 1, 1), 'image/x-icon');
    expect(await make().get('big.test')).toBeNull();
    expect((db.prepare('SELECT error FROM favicons').get() as { error: string }).error).toMatch(/over 102400 bytes/);
  });

  it('reads only the start of a huge page', async () => {
    let sent = 0;
    routes['huge.test/'] = (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const chunk = Buffer.alloc(64 * 1024, 'a');
      const push = () => {
        while (sent < 20 * MAX_HTML_BYTES && res.write(chunk)) sent += chunk.length;
        if (sent < 20 * MAX_HTML_BYTES) res.once('drain', push);
        else res.end();
      };
      push();
    };
    routes['huge.test/favicon.ico'] = image(ICO, 'image/x-icon');
    expect(await make().get('huge.test')).not.toBeNull();
    expect(sent).toBeLessThan(20 * MAX_HTML_BYTES);
  });

  it('gives up after the deadline', async () => {
    routes['slow.test/'] = () => {}; // never answers
    const t = Date.now();
    expect(await make({ timeoutMs: 200 }).get('slow.test')).toBeNull();
    expect(Date.now() - t).toBeLessThan(3000);
    expect((db.prepare('SELECT error FROM favicons').get() as { error: string }).error).toMatch(/timed out|abort/i);
  });

  it('follows at most 3 redirects', async () => {
    for (let i = 0; i < 5; i++) routes[`loop.test/r${i}`] = redirect(`/r${i + 1}`);
    routes['loop.test/'] = redirect('/r0');
    routes['loop.test/favicon.ico'] = redirect('/r0');
    expect(await make().get('loop.test')).toBeNull();
    expect((db.prepare('SELECT error FROM favicons').get() as { error: string }).error).toMatch(/more than 3 redirects/);
  });
});

describe('favicons: only public hosts (SSRF)', () => {
  it('refuses names and addresses that are not public', async () => {
    for (const d of ['localhost', 'a.localhost', '127.0.0.1', '[::1]', '10.0.0.1', 'printer.local', 'nodot', '', 'a..b', 'x.123']) expect(validHost(d), d).toBeNull();
    expect(validHost('Docs.Example.com.')).toBe('docs.example.com');
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.9.9', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1'])
      expect(publicAddress(ip), ip).toBe(false);
    for (const ip of ['93.184.216.34', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(publicAddress(ip), ip).toBe(true);
    await expect(make().get('localhost')).rejects.toThrow(/not a public host name/);
    await expect(make().get('10.0.0.1')).rejects.toThrow(/not a public host name/);
  });

  it('refuses a name that resolves to a private address, without connecting', async () => {
    for (const d of ['private.test', 'linklocal.test', 'mixed.test']) {
      expect(await make().get(d)).toBeNull();
      const row = db.prepare('SELECT error FROM favicons WHERE domain = ?').get(d) as { error: string };
      expect(row.error).toMatch(/resolves to a private address/);
    }
    expect(hits).toEqual([]);
    // Without the test's loopback exception, the fake site itself (127.0.0.1) is refused too.
    expect(await make({ loopbackOk: false }).get('site.test')).toBeNull();
    expect(hits).toEqual([]);
  });

  it('refuses redirects to private hosts and IP literals', async () => {
    routes['hop.test/'] = redirect(`http://private.test:${port}/`);
    routes['hop.test/favicon.ico'] = redirect(`http://127.0.0.1:${port}/x.png`);
    expect(await make().get('hop.test')).toBeNull();
    routes['hop2.test/'] = html('<link rel=icon href="http://10.0.0.1/i.png">');
    routes['hop2.test/favicon.ico'] = redirect(`http://localhost:${port}/i.png`);
    expect(await make().get('hop2.test')).toBeNull();
    expect(hits.sort()).toEqual(['hop.test/', 'hop2.test/']);
    // A link href or redirect elsewhere than http(s) is refused as well.
    routes['ftp.test/'] = html('<link rel=icon href="file:///etc/passwd">');
    routes['ftp.test/favicon.ico'] = redirect('file:///etc/passwd');
    expect(await make().get('ftp.test')).toBeNull();
  });
});

describe('GET /api/favicon', () => {
  it('serves the icon with safe headers, 404 on a miss, 400 on a bad host', async () => {
    routes['site.test/'] = html('<link rel=icon href=/f.svg>');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    routes['site.test/f.svg'] = image(svg, 'image/svg+xml');
    const l = await launch({ dispatch: false, env: {}, favicons: { resolve, loopbackOk: true, home: (d) => `http://${d}:${port}/` } });
    const r = await fetch(`${l.api}/favicon?domain=site.test`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/svg+xml');
    expect(r.headers.get('cache-control')).toBe('max-age=86400');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(Buffer.from(await r.arrayBuffer()).equals(svg)).toBe(true);
    expect((await fetch(`${l.api}/favicon?domain=none.test`)).status).toBe(404);
    expect((await fetch(`${l.api}/favicon?domain=localhost`)).status).toBe(400);
    expect((await fetch(`${l.api}/favicon`)).status).toBe(400);
  });
});
