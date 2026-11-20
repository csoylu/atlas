import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { NetworkLevel, NetworkRefusal } from '@atlas/shared';
import type { Db } from './store/db.ts';

/**
 * Internet access per workspace (#298 §2, S3). A workspace (project × agent) is On, Allowed hosts or Off: its own
 * setting, else its project's. The sandbox enforces the level on agent commands (sandbox.ts: Seatbelt rules, bwrap's
 * network namespace); with Allowed hosts every request goes through the allow-list proxy below, an HTTP CONNECT proxy in
 * the engine. A workspace is known to the proxy by a token in its proxy URL (`http://ws:<token>@127.0.0.1:<port>`),
 * made at the first command and kept in memory only: an engine restart makes new ones (and a new port), and the next
 * command gets them. The proxy reads the setting at each request; the sandbox rules at each command (a change applies
 * from the next command on). Every refused host of a workspace at Allowed hosts is counted in `network_refusals`.
 *
 * The proxy never reaches a local address (loopback, unspecified, link-local), whatever the name resolves to: the
 * engine's own API and other workspaces' servers stay out of reach through it.
 */

export interface NetworkSetting {
  level: NetworkLevel;
  /** The allowed hosts in effect (the member's own list, else the project's). */
  hosts: string[];
}

/** `host` matches a rule `host` exactly, or `*.suffix` for the suffix itself and every subdomain of it. */
export function hostAllowed(host: string, rules: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');
  return rules.some((r) => (r.startsWith('*.') ? h === r.slice(2) || h.endsWith(r.slice(1)) : h === r));
}

const parseList = (s: string | null): string[] | null => {
  if (s === null) return null;
  const v = JSON.parse(s) as unknown;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`allowed_hosts is not a list of names: ${s}`);
  return v as string[];
};

/** The setting in effect for a workspace: the member's own level and list, each falling back to the project's. */
export function effectiveNetwork(db: Db, projectId: string, agentId: string): NetworkSetting {
  const p = db.prepare('SELECT network, allowed_hosts FROM projects WHERE id = ?').get(projectId) as { network: NetworkLevel; allowed_hosts: string } | undefined;
  if (!p) throw new Error(`project ${projectId} not found`);
  const m = db.prepare('SELECT network, allowed_hosts FROM project_members WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as
    | { network: NetworkLevel | null; allowed_hosts: string | null }
    | undefined;
  const own = parseList(m?.allowed_hosts ?? null);
  return { level: m?.network ?? p.network, hosts: own && own.length ? own : (parseList(p.allowed_hosts) ?? []) };
}

/** A loopback, unspecified or link-local address: never reached through the proxy. */
function localAddress(ip: string): boolean {
  const a = ip.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(a) === 4) return /^(127\.|0\.|169\.254\.)/.test(a);
  return a === '::1' || a === '::' || /^fe[89ab]/.test(a);
}

export const OFFLINE = 'This workspace is offline (Settings → Workspaces)';
export const notAllowed = (host: string) => `${host} is not in this workspace's allowed hosts (Settings → Workspaces)`;

export interface NetworkOptions {
  /** Also listen on a unix socket (Linux: bound into bwrap's network namespace, relayed by socat). Default: on Linux. */
  unixSocket?: boolean;
  /** Tests: another resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Tests: let the proxy reach local addresses (a local upstream server). */
  localOk?: boolean;
}

export class Network {
  private tokens = new Map<string, string>();
  private owners = new Map<string, { projectId: string; agentId: string }>();
  private servers: http.Server[] = [];
  private socketDir: string | null = null;
  private tcpPort: number | null = null;
  private sockets = new Set<Duplex>();

  constructor(
    private db: Db,
    private o: NetworkOptions = {},
  ) {}

  /** The setting in effect for a workspace. */
  setting(projectId: string, agentId: string): NetworkSetting {
    return effectiveNetwork(this.db, projectId, agentId);
  }

  /** The proxy's TCP port on 127.0.0.1, once started. */
  get port(): number | null {
    return this.tcpPort;
  }

  /** The proxy's unix socket (Linux), once started. */
  get socketPath(): string | null {
    return this.socketDir ? join(this.socketDir, 'proxy.sock') : null;
  }

  /** The workspace's proxy token (made on first use, in memory only). */
  token(projectId: string, agentId: string): string {
    const key = `${projectId}\u0000${agentId}`;
    let t = this.tokens.get(key);
    if (!t) {
      t = randomBytes(24).toString('hex');
      this.tokens.set(key, t);
      this.owners.set(t, { projectId, agentId });
    }
    return t;
  }

  /** What a command of this workspace gets: its level and, at Allowed hosts, its proxy URL on the TCP port. */
  forCommand(projectId: string, agentId: string): NetworkSetting & { token: string | null; proxyUrl: string | null } {
    const s = this.setting(projectId, agentId);
    if (s.level !== 'hosts') return { ...s, token: null, proxyUrl: null };
    if (this.tcpPort === null) throw new Error('the network proxy is not running');
    const token = this.token(projectId, agentId);
    return { ...s, token, proxyUrl: `http://ws:${token}@127.0.0.1:${this.tcpPort}` };
  }

  /**
   * web_fetch's check of one URL (every redirect hop): null = go, else why not. Off refuses everything; Allowed hosts
   * refuses (and counts) a host outside the list.
   */
  check(projectId: string, agentId: string, url: URL): string | null {
    const s = this.setting(projectId, agentId);
    if (s.level === 'off') return OFFLINE;
    if (s.level === 'hosts' && !hostAllowed(url.hostname, s.hosts)) {
      this.record(projectId, agentId, url.hostname);
      return notAllowed(url.hostname.replace(/^\[(.*)\]$/, '$1'));
    }
    return null;
  }

  /** Count a refused host for a workspace. */
  record(projectId: string, agentId: string, host: string): void {
    const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1').slice(0, 253);
    this.db
      .prepare(
        `INSERT INTO network_refusals (project_id, agent_id, host, count, last_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (project_id, agent_id, host) DO UPDATE SET count = count + 1, last_at = excluded.last_at`,
      )
      .run(projectId, agentId, h, new Date().toISOString());
  }

  /** The hosts refused in a project, newest first. */
  refusals(projectId: string): NetworkRefusal[] {
    return (
      this.db.prepare('SELECT agent_id, host, count, last_at FROM network_refusals WHERE project_id = ? ORDER BY last_at DESC, host').all(projectId) as {
        agent_id: string;
        host: string;
        count: number;
        last_at: string;
      }[]
    ).map((r) => ({ agentId: r.agent_id, host: r.host, count: r.count, lastAt: r.last_at }));
  }

  /** Start the proxy: 127.0.0.1 on a free port, plus a unix socket on Linux. */
  async start(): Promise<void> {
    if (this.servers.length) return;
    const make = () => {
      const s = http.createServer((req, res) => void this.onRequest(req, res));
      s.on('connect', (req: IncomingMessage, sock: Duplex, head: Buffer) => void this.onConnect(req, sock, head));
      s.on('connection', (sock: Socket) => {
        this.sockets.add(sock);
        sock.on('close', () => this.sockets.delete(sock));
      });
      // A client that drops mid-request (socat's readiness check) is nothing to report.
      s.on('clientError', (_e, sock: Duplex) => sock.destroy());
      this.servers.push(s);
      return s;
    };
    const tcp = make();
    await new Promise<void>((ok, ko) => {
      tcp.once('error', ko);
      tcp.listen(0, '127.0.0.1', () => ok());
    });
    this.tcpPort = (tcp.address() as { port: number }).port;
    if (this.o.unixSocket ?? process.platform === 'linux') {
      this.socketDir = mkdtempSync(join(tmpdir(), 'atlas-net-'));
      chmodSync(this.socketDir, 0o700);
      const unix = make();
      await new Promise<void>((ok, ko) => {
        unix.once('error', ko);
        unix.listen(this.socketPath!, () => ok());
      });
    }
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await Promise.all(this.servers.map((s) => new Promise<void>((ok) => s.close(() => ok()))));
    this.servers = [];
    this.tcpPort = null;
    if (this.socketDir) rmSync(this.socketDir, { recursive: true, force: true });
    this.socketDir = null;
  }

  /** The workspace of a request, from its Proxy-Authorization (Basic ws:<token>), or null. */
  private owner(req: IncomingMessage): { projectId: string; agentId: string } | null {
    const m = /^Basic\s+(\S+)$/i.exec(req.headers['proxy-authorization'] ?? '');
    if (!m) return null;
    const [user, token] = Buffer.from(m[1]!, 'base64').toString('utf8').split(':');
    if (user !== 'ws' || !token) return null;
    for (const [t, who] of this.owners) {
      const a = Buffer.from(t);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return who;
    }
    return null;
  }

  /** Where a request may go: the address to connect to, or the status and reason of the refusal. */
  private async decide(req: IncomingMessage, host: string): Promise<{ address: string } | { status: number; why: string }> {
    const who = this.owner(req);
    if (!who) return { status: 407, why: 'atlas: this proxy needs the workspace token of the proxy URL' };
    const h = host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
    let s: NetworkSetting;
    try {
      s = this.setting(who.projectId, who.agentId);
    } catch (e) {
      return { status: 403, why: `atlas: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (s.level === 'off') return { status: 403, why: `atlas: ${OFFLINE}` };
    if (s.level === 'hosts' && !hostAllowed(h, s.hosts)) {
      this.record(who.projectId, who.agentId, h);
      return { status: 403, why: `atlas: ${notAllowed(h)}` };
    }
    let addresses: string[];
    try {
      addresses = isIP(h) ? [h] : this.o.resolve ? await this.o.resolve(h) : (await lookup(h, { all: true })).map((a) => a.address);
    } catch (e) {
      return { status: 502, why: `atlas: ${h} could not be resolved (${e instanceof Error ? e.message : String(e)})` };
    }
    if (!addresses.length || (!this.o.localOk && addresses.some(localAddress))) return { status: 403, why: `atlas: ${h} is a local address: never reached through the proxy` };
    return { address: addresses[0]! };
  }

  private async onConnect(req: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    client.on('error', () => client.destroy());
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url ?? '');
    if (!m) return void refuse(client, 400, 'atlas: CONNECT needs host:port');
    const d = await this.decide(req, m[1]!);
    if ('status' in d) return void refuse(client, d.status, d.why);
    const up = connect(Number(m[2]), d.address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', (e) => {
      if (!client.writableEnded && up.connecting) refuse(client, 502, `atlas: ${m[1]}:${m[2]} unreachable (${e.message})`);
      else client.destroy();
    });
    client.on('close', () => up.destroy());
  }

  /** Plain http:// requests in absolute form (`GET http://host/path`). */
  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let u: URL;
    try {
      u = new URL(req.url ?? '');
    } catch {
      return void res.writeHead(400, { 'content-type': 'text/plain' }).end('atlas: this is a proxy: send absolute http:// URLs or CONNECT\n');
    }
    if (u.protocol !== 'http:') return void res.writeHead(400, { 'content-type': 'text/plain' }).end('atlas: only http:// URLs go in plain; https goes through CONNECT\n');
    const d = await this.decide(req, u.hostname);
    if ('status' in d) {
      const extra = d.status === 407 ? { 'proxy-authenticate': 'Basic realm="atlas"' } : {};
      return void res.writeHead(d.status, { 'content-type': 'text/plain', ...extra }).end(d.why + '\n');
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers, host: u.host };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const up = http.request({ host: d.address, port: u.port || 80, method: req.method, path: u.pathname + u.search, headers, setHost: false }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`atlas: ${u.host} unreachable (${e.message})\n`);
      else res.destroy();
    });
    req.pipe(up);
  }
}

function refuse(sock: Duplex, status: number, why: string): void {
  const text = { 400: 'Bad Request', 403: 'Forbidden', 407: 'Proxy Authentication Required', 502: 'Bad Gateway' }[status] ?? 'Error';
  const body = why + '\n';
  const extra = status === 407 ? 'Proxy-Authenticate: Basic realm="atlas"\r\n' : '';
  sock.end(`HTTP/1.1 ${status} ${text}\r\n${extra}Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}
