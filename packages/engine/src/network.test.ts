import { describe, expect, it, onTestFinished } from 'vitest';
import http from 'node:http';
import { connect } from 'node:net';
import type { ContentBlock, NetworkRefusal, Project } from '@atlas/shared';
import { launch } from '../test/kit/index.ts';
import type { ModelRequest } from './providers/types.ts';
import { effectiveNetwork, hostAllowed, Network } from './network.ts';
import { openDb } from './store/db.ts';
import { fetchPage } from './web.ts';

/** #298 S3: internet levels per workspace, the allow-list proxy, web_fetch per level, the API. */

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const tool = (id: string, name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id, name, input }];
const results = (req: ModelRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));

function dbWithProject() {
  const db = openDb(':memory:');
  db.pragma('foreign_keys = OFF'); // members without agent rows: only the network columns matter here
  db.prepare("INSERT INTO projects (id, name, colour, created_at) VALUES ('p', 'P', 212, 'now')").run();
  db.prepare("INSERT INTO project_members (project_id, agent_id, joined_at) VALUES ('p', 'a', 'now'), ('p', 'b', 'now')").run();
  return db;
}

/** A local upstream answering every request with its Host header. */
async function upstream(): Promise<number> {
  const s = http.createServer((req, res) => res.end(`hello from ${req.headers.host}`));
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
  onTestFinished(() => new Promise<void>((ok) => s.close(() => ok())));
  return (s.address() as { port: number }).port;
}

/** One raw request through the proxy: CONNECT host:port (then GET over the tunnel), or a plain absolute-form GET. */
function viaProxy(port: number, o: { token?: string; connect?: string; get?: string }): Promise<string> {
  return new Promise((ok, ko) => {
    const s = connect(port, '127.0.0.1');
    const auth = o.token ? `Proxy-Authorization: Basic ${Buffer.from(`ws:${o.token}`).toString('base64')}\r\n` : '';
    let out = '';
    let tunnelled = false;
    s.on('data', (d) => {
      out += d.toString();
      if (o.connect && !tunnelled && out.startsWith('HTTP/1.1 200')) {
        tunnelled = true;
        s.write(`GET / HTTP/1.1\r\nHost: ${o.connect}\r\nConnection: close\r\n\r\n`);
      }
    });
    s.on('end', () => ok(out));
    s.on('error', ko);
    if (o.connect) s.write(`CONNECT ${o.connect} HTTP/1.1\r\nHost: ${o.connect}\r\n${auth}\r\n`);
    else s.write(`GET ${o.get} HTTP/1.1\r\nHost: x\r\n${auth}Connection: close\r\n\r\n`);
  });
}

describe('internet levels (#298 S3)', () => {
  it('host rules: exact names, *.suffix for the domain and its subdomains, nothing else', () => {
    const rules = ['github.com', '*.npmjs.org'];
    expect(hostAllowed('github.com', rules)).toBe(true);
    expect(hostAllowed('GitHub.com.', rules)).toBe(true);
    expect(hostAllowed('api.github.com', rules)).toBe(false);
    expect(hostAllowed('npmjs.org', rules)).toBe(true);
    expect(hostAllowed('registry.npmjs.org', rules)).toBe(true);
    expect(hostAllowed('evilnpmjs.org', rules)).toBe(false);
    expect(hostAllowed('github.com.evil.io', rules)).toBe(false);
  });

  it('a workspace gets its project default (On), its own level over it, its own hosts replacing the project list', () => {
    const db = dbWithProject();
    expect(effectiveNetwork(db, 'p', 'a')).toEqual({ level: 'on', hosts: [] });
    db.prepare(`UPDATE projects SET network = 'hosts', allowed_hosts = '["github.com"]' WHERE id = 'p'`).run();
    expect(effectiveNetwork(db, 'p', 'a')).toEqual({ level: 'hosts', hosts: ['github.com'] });
    db.prepare(`UPDATE project_members SET network = 'off' WHERE agent_id = 'b'`).run();
    expect(effectiveNetwork(db, 'p', 'b').level).toBe('off');
    db.prepare(`UPDATE project_members SET allowed_hosts = '["*.npmjs.org"]' WHERE agent_id = 'a'`).run();
    expect(effectiveNetwork(db, 'p', 'a')).toEqual({ level: 'hosts', hosts: ['*.npmjs.org'] });
    // Not a member (workflow command steps): the project's setting.
    expect(effectiveNetwork(db, 'p', 'workflow')).toEqual({ level: 'hosts', hosts: ['github.com'] });
  });

  it('the proxy: 407 without its token, 403 for a refused host (recorded, counted), a tunnel and a plain GET to an allowed one, local addresses never', async () => {
    const db = dbWithProject();
    const port = await upstream();
    const resolve = async (h: string) => (h === 'local.test' ? ['127.0.0.1'] : ['127.0.0.1']);
    const strict = new Network(db, { resolve, unixSocket: false });
    const open = new Network(db, { resolve, localOk: true, unixSocket: false });
    await strict.start();
    await open.start();
    onTestFinished(async () => void (await Promise.all([strict.stop(), open.stop()])));
    db.prepare(`UPDATE projects SET network = 'hosts', allowed_hosts = '["*.ok.test"]' WHERE id = 'p'`).run();
    const tok = open.token('p', 'a');
    expect(open.forCommand('p', 'a')).toMatchObject({ level: 'hosts', proxyUrl: `http://ws:${tok}@127.0.0.1:${open.port}` });

    expect(await viaProxy(open.port!, { connect: `api.ok.test:${port}` })).toMatch(/^HTTP\/1.1 407/);
    expect(await viaProxy(open.port!, { connect: `api.ok.test:${port}`, token: 'wrong' })).toMatch(/^HTTP\/1.1 407/);
    const refused = await viaProxy(open.port!, { connect: 'evil.test:443', token: tok });
    expect(refused).toMatch(/^HTTP\/1.1 403/);
    expect(refused).toContain("evil.test is not in this workspace's allowed hosts");
    await viaProxy(open.port!, { get: 'http://evil.test/x', token: tok });
    expect(open.refusals('p')).toEqual([expect.objectContaining({ agentId: 'a', host: 'evil.test', count: 2 })]);

    expect(await viaProxy(open.port!, { connect: `api.ok.test:${port}`, token: tok })).toContain(`hello from api.ok.test:${port}`);
    expect(await viaProxy(open.port!, { get: `http://api.ok.test:${port}/`, token: tok })).toContain(`hello from api.ok.test:${port}`);
    // The real proxy never reaches a local address, whatever the name resolves to (the engine API, other servers).
    const t2 = strict.token('p', 'a');
    expect(await viaProxy(strict.port!, { connect: `api.ok.test:${port}`, token: t2 })).toMatch(/^HTTP\/1.1 403[^]*local address/);

    // The setting is read at each request: Off refuses with the offline reason, and a token of another workspace is
    // that workspace's setting, not the caller's.
    db.prepare(`UPDATE project_members SET network = 'off' WHERE agent_id = 'a'`).run();
    expect(await viaProxy(open.port!, { connect: `api.ok.test:${port}`, token: tok })).toContain('This workspace is offline');
    expect(await viaProxy(open.port!, { connect: `api.ok.test:${port}`, token: open.token('p', 'b') })).toContain('hello from');
  });

  it('web_fetch checks every redirect hop: a redirect to a refused host stops with why, an allowed chain is followed', async () => {
    const pages: Record<string, Response> = {};
    const fake = (async (u: URL | string) => {
      const href = String(u);
      if (href === 'https://ok.test/a') return new Response(null, { status: 302, headers: { location: '/b' } });
      if (href === 'https://ok.test/b') return new Response(null, { status: 301, headers: { location: 'https://evil.test/c' } });
      if (href === 'https://ok.test/d') return new Response(null, { status: 307, headers: { location: 'https://ok.test/e' } });
      if (href === 'https://ok.test/e') return new Response('fine', { headers: { 'content-type': 'text/plain' } });
      return pages[href] ?? new Response('nope', { status: 404 });
    }) as typeof fetch;
    const seen: string[] = [];
    const allow = (u: URL) => (seen.push(u.href), u.hostname === 'ok.test' ? null : `${u.hostname} is not in this workspace's allowed hosts`);
    const signal = new AbortController().signal;
    await expect(fetchPage('https://ok.test/a', signal, fake, allow)).rejects.toThrow("https://ok.test/a redirects to https://evil.test/c: evil.test is not in this workspace's allowed hosts");
    expect(seen).toEqual(['https://ok.test/a', 'https://ok.test/b', 'https://evil.test/c']);
    expect(await fetchPage('https://ok.test/d', signal, fake, allow)).toMatchObject({ url: 'https://ok.test/e', text: 'fine' });
    await expect(fetchPage('https://evil.test/', signal, fake, allow)).rejects.toThrow(/^evil.test is not/);
  });

  it('web_fetch follows real redirects by hand (Node fetch, redirect: manual)', async () => {
    const s = http.createServer((req, res) => {
      if (req.url === '/r') return void res.writeHead(302, { location: '/end' }).end();
      res.writeHead(200, { 'content-type': 'text/plain' }).end('landed');
    });
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
    onTestFinished(() => new Promise<void>((ok) => s.close(() => ok())));
    const base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    const seen: string[] = [];
    const page = await fetchPage(`${base}/r`, new AbortController().signal, fetch, (u) => (seen.push(u.pathname), null));
    expect(page).toMatchObject({ url: `${base}/end`, text: 'landed' });
    expect(seen).toEqual(['/r', '/end']);
  });

  it('API: PATCH the project and a member (bad hosts refused), GET refusals; levels survive a restart', async () => {
    const l = await launch({ dispatch: false });
    const pid = l.engine.projects.list()[0]!.id;
    const bad = await l.call('PATCH', `/projects/${pid}`, { allowedHosts: ['https://github.com/x'] });
    expect(bad.status).toBe(400);
    const p = await l.call<Project>('PATCH', `/projects/${pid}`, { network: 'hosts', allowedHosts: ['GitHub.com', '*.npmjs.org', 'github.com'] });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ network: 'hosts', allowedHosts: ['github.com', '*.npmjs.org'] });
    expect(p.body.members[0]).toMatchObject({ network: null, allowedHosts: null });
    const m = await l.call<Project>('PATCH', `/projects/${pid}/members/atlas`, { network: 'off', allowedHosts: ['example.com'] });
    expect(m.body.members.find((x) => x.agentId === 'atlas')).toMatchObject({ network: 'off', allowedHosts: ['example.com'] });
    expect(l.engine.network.setting(pid, 'atlas')).toEqual({ level: 'off', hosts: ['example.com'] });
    // An empty list is the project's list again; null level is the project's level.
    await l.call('PATCH', `/projects/${pid}/members/atlas`, { network: null, allowedHosts: [] });
    expect(l.engine.network.setting(pid, 'atlas')).toEqual({ level: 'hosts', hosts: ['github.com', '*.npmjs.org'] });
    expect((await l.call('PATCH', `/projects/${pid}/members/nobody`, { network: 'off' })).status).toBe(404);
    expect((await l.call('PATCH', `/projects/${pid}/members/atlas`, { network: 'sometimes' })).status).toBe(400);

    expect(l.engine.network.check(pid, 'atlas', new URL('https://evil.test/'))).toContain('evil.test is not');
    const r = await l.call<NetworkRefusal[]>('GET', `/projects/${pid}/refusals`);
    expect(r.body).toEqual([expect.objectContaining({ agentId: 'atlas', host: 'evil.test', count: 1 })]);
  });

  it('a run: web_fetch refused at Off with the offline reason, web_search not offered at Off; both as before with the sandbox off', async () => {
    for (const sandbox of [true, false]) {
      const l = await launch({
        dispatch: false,
        env: {},
        sandbox: { enabled: sandbox, platform: 'darwin', sandboxExec: '/usr/bin/true' },
        script: [tool('u1', 'web_fetch', { url: 'https://example.invalid/' }), text('done')],
      });
      const pid = l.engine.projects.list()[0]!.id;
      l.engine.projects.update(pid, { network: 'off' });
      const card = l.engine.kanban.create({ title: 'fetch', assignee: 'atlas' }, 'user');
      l.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
      l.engine.runner.wake(card.id);
      await l.engine.runner.settled(card.id);
      expect(l.fake.calls[0]!.webSearch).toBe(!sandbox);
      const out = results(l.fake.calls[1]!)[0]!;
      if (sandbox) expect(out).toContain('This workspace is offline (Settings → Workspaces)');
      else expect(out).not.toContain('offline');
    }
  });

  it('change pending (#308): a background command running on a level that is no longer its workspace\'s; Allowed hosts follows every change (proxy), never pending', () => {
    const db = dbWithProject();
    const bg = (id: string, agent: string, level: string | null, status = 'running') =>
      db
        .prepare(
          `INSERT INTO background_processes (id, agent_id, card_id, command, log_path, status, owner, started_at, project_id, network) VALUES (?, ?, 'c', 'sleep 9', '/x', ?, 'me', 'now', ?, ?)`,
        )
        .run(id, agent, status, level ? 'p' : null, level);
    bg('1', 'a', 'on');
    bg('2', 'a', 'on');
    bg('3', 'b', 'hosts');
    bg('4', 'b', 'off', 'exited');
    bg('5', 'b', null); // unsandboxed: no project, no level
    const net = new Network(db);
    expect(net.pending('p')).toEqual([]); // every one still on its level
    db.prepare("UPDATE projects SET network = 'off' WHERE id = 'p'").run();
    expect(net.pending('p')).toEqual([{ agentId: 'a', level: 'on', count: 2 }]);
    db.prepare("UPDATE project_members SET network = 'on' WHERE agent_id = 'a'").run();
    expect(net.pending('p')).toEqual([]);
    db.prepare("UPDATE background_processes SET status = 'exited'").run();
    db.prepare("UPDATE project_members SET network = 'off' WHERE agent_id = 'a'").run();
    expect(net.pending('p')).toEqual([]);
  });

  it('API (#308): GET pending, clear a workspace\'s browser data (404 for a non-member, 400 without the desktop browser)', async () => {
    const cleared: string[] = [];
    const host = {
      open() {},
      history() {},
      close() {},
      show() {},
      setOwner() {},
      send: async () => null,
      capture: async () => ({ image: '', width: 0, height: 0 }),
      signal() {},
      clearData: async (partition: string) => void cleared.push(partition),
      on: () => () => {},
    };
    const l = await launch({ dispatch: false, browser: host });
    const pid = l.engine.projects.list()[0]!.id;
    expect((await l.call('GET', `/projects/${pid}/pending`)).body).toEqual([]);
    expect((await l.call('POST', `/projects/${pid}/members/atlas/browser-data/clear`)).status).toBe(204);
    expect(cleared).toEqual([`persist:ws-${pid}-atlas`]);
    expect((await l.call('POST', `/projects/${pid}/members/nobody/browser-data/clear`)).status).toBe(404);
    const plain = await launch({ dispatch: false });
    const pid2 = plain.engine.projects.list()[0]!.id;
    expect((await plain.call('POST', `/projects/${pid2}/members/atlas/browser-data/clear`)).status).toBe(400);
  });
});
