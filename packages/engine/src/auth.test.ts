import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startEngine, type Engine } from './index.ts';
import { Auth, SESSION_COOKIE } from './auth.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});
const PASSWORD = 'correct horse battery staple';
const start = (password: string | null = PASSWORD) =>
  startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, password, dispatch: false });

/** A raw request, so Host and Origin can be set the way a browser (or an attacker's page) would. */
function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request(url, { method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}
const login = (url: string, password: string) =>
  raw(url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
const cookieOf = (r: { headers: Record<string, string | string[] | undefined> }) => String(r.headers['set-cookie']).split(';')[0]!;

describe('auth (design §12)', () => {
  it('server mode: nothing without a session, forged or tampered cookies refused, login works', async () => {
    engine = await start();
    const u = engine.url;
    expect((await raw(u + '/api/health')).status).toBe(200);
    expect((await raw(u + '/api/cards')).status).toBe(401);
    expect((await raw(u + '/api/settings')).status).toBe(401);
    // The old check accepted any value with a dot in it.
    expect((await raw(u + '/api/cards', { headers: { cookie: `${SESSION_COOKIE}=x.${'a'.repeat(40)}` } })).status).toBe(401);

    expect((await login(u, 'nope')).status).toBe(401);
    const ok = await login(u, PASSWORD);
    expect(ok.status).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly/);
    expect(String(ok.headers['set-cookie'])).toMatch(/SameSite=Strict/);
    const cookie = cookieOf(ok);
    expect((await raw(u + '/api/cards', { headers: { cookie } })).status).toBe(200);
    expect(JSON.parse((await raw(u + '/api/auth/check', { method: 'POST', headers: { cookie } })).body)).toEqual({ authenticated: true, enabled: true });

    const [name, token] = cookie.split('=') as [string, string];
    const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA');
    expect((await raw(u + '/api/cards', { headers: { cookie: `${name}=${tampered}` } })).status).toBe(401);
  });

  it('server mode: the WebSocket needs a session too', async () => {
    engine = await start();
    const ws = new WebSocket(engine.url.replace('http', 'ws') + '/api/events');
    const code = await new Promise<number>((r) => ws.once('unexpected-response', (_req, res) => r(res.statusCode!)));
    expect(code).toBe(401);
    const cookie = cookieOf(await login(engine.url, PASSWORD));
    const ok = new WebSocket(engine.url.replace('http', 'ws') + '/api/events', { headers: { cookie } });
    await new Promise((r, j) => (ok.once('open', r), ok.once('error', j)));
    ok.close();
  });

  it('locks out a guessing client after 5 wrong passwords', async () => {
    engine = await start();
    for (let i = 0; i < 5; i++) expect((await login(engine.url, 'guess' + i)).status).toBe(401);
    const locked = await login(engine.url, PASSWORD);
    expect(locked.status).toBe(429);
    expect(JSON.parse(locked.body).error).toMatch(/too many wrong passwords/);
  });

  it('sessions expire, survive a restart, and end when the password changes', () => {
    let now = 1_000_000;
    const a = new Auth(PASSWORD, () => now);
    const { token, maxAgeMs } = a.issue();
    expect(a.verify(token)).toBe(true);
    expect(new Auth(PASSWORD, () => now).verify(token)).toBe(true); // a restart: same password, same key
    expect(new Auth('another long password', () => now).verify(token)).toBe(false);
    now += maxAgeMs + 1;
    expect(a.verify(token)).toBe(false);
    expect(() => new Auth('short')).toThrow(/at least 12 characters/);
  });

  it('local mode: no login, but cross-site pages and rebinding hosts are refused', async () => {
    engine = await start(null);
    const u = engine.url;
    const port = new URL(u).port;
    expect((await raw(u + '/api/cards')).status).toBe(200);
    expect(JSON.parse((await raw(u + '/api/auth/check', { method: 'POST' })).body)).toEqual({ authenticated: true, enabled: false });
    // The Vite dev server (another localhost port) and the app's own origin are fine.
    expect((await raw(u + '/api/cards', { headers: { origin: 'http://localhost:5173' } })).status).toBe(200);
    expect((await raw(u + '/api/cards', { headers: { origin: u } })).status).toBe(200);
    // A web page Can opens can't drive his agents.
    const csrf = await raw(u + '/api/cards', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{}' });
    expect(csrf.status).toBe(403);
    expect((await raw(u + '/api/cards', { headers: { origin: 'null' } })).status).toBe(403);
    // DNS rebinding: evil.example resolving to 127.0.0.1.
    expect((await raw(u + '/api/cards', { headers: { host: `evil.example:${port}` } })).status).toBe(403);
    // Same for the WebSocket (browsers don't apply CORS to it).
    const ws = new WebSocket(u.replace('http', 'ws') + '/api/events', { headers: { origin: 'https://evil.example' } });
    expect(await new Promise<number>((r) => ws.once('unexpected-response', (_req, res) => r(res.statusCode!)))).toBe(401);
  });

  it('refuses to listen on a public address without a password', async () => {
    await expect(startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, host: '0.0.0.0' })).rejects.toThrow(
      /refusing to listen on 0.0.0.0 without a password/,
    );
  });

  it('settings never carry login data', async () => {
    engine = await start(null);
    const res = await raw(engine.url + '/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverPasswordHash: 'x' }) });
    expect(res.status).toBe(400);
    expect(Object.keys(JSON.parse((await raw(engine.url + '/api/settings')).body))).toEqual(['triageAgent']);
  });
});
