import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { NetworkLevel, SandboxStatus } from '@atlas/shared';
import type { Network } from './network.ts';

/**
 * Agent command sandbox (#298 §1.2, §1.4, §1.5, §1.6). Every agent command (shell, background shell, secret_set's
 * command, workflow command steps) goes through `spawnAgentCommand`. With the sandbox on, it runs as
 * `sandbox-exec -p <profile> /bin/bash -c <cmd>` on macOS (S1) or `bwrap <args> -- /bin/bash -c <cmd>` on Linux (S2),
 * with HOME = the workspace, a private TMPDIR and cache under the data dir, and a git config that takes GitHub
 * credentials from $GH_TOKEN only. Fail closed: if the startup probe failed (Windows always: no sandbox there), every
 * agent command throws SandboxUnavailable and the run stops; there is never a host fallback. Server setup: docs/server-sandbox.md.
 *
 * Temporary (S1–S4): the sandbox is on only with ATLAS_SANDBOX=1. Off, commands spawn on the host exactly as before.
 */

/** Thrown instead of running a command when the sandbox is on but can't be used: the run stops with this message. */
export class SandboxUnavailable extends Error {
  constructor(reason: string) {
    super(`Sandbox unavailable: ${reason}. Agent commands are stopped.`);
    this.name = 'SandboxUnavailable';
  }
}

/** Whose command it is: one (project, agent) workspace. Workflow command steps use agent 'workflow' and the checkout root. */
export interface SandboxScope {
  sandbox: Sandbox;
  projectId: string;
  /** Shown in the missing GH_TOKEN message. */
  projectName: string;
  agentId: string;
  /** The only folder the command can write besides its private temp (the agent's workspace). */
  workspace: string;
}

export interface SandboxOptions {
  /** ATLAS_SANDBOX=1 (temporary, until S5). */
  enabled: boolean;
  /** The Atlas data dir: denied (database, other workspaces, outputs), except the command's own workspace and private dir. */
  dataDir: string;
  /** The engine's HTTP port once it listens: denied to agent commands. */
  enginePort: () => number | null;
  /** Tests: another home, platform, sandbox-exec, bwrap or /proc/sys. */
  home?: string;
  platform?: NodeJS.Platform;
  sandboxExec?: string;
  bwrap?: string;
  procSys?: string;
  /** Tests: where socat is (Linux, Allowed hosts); default: the first of SOCAT that exists. */
  socat?: string;
  /** Internet levels and the allow-list proxy (#298 S3); omitted = every workspace On (tests). */
  network?: Network;
  /**
   * The engine requires its login (ATLAS_PASSWORD) on every API call but the public ones. Linux at level On shares the
   * host network, so the engine port is reachable: without the login there a command is refused (#298 §2.1).
   */
  engineLogin?: () => boolean;
}

/** Toolchains under $HOME that stay readable (besides the PATH's own folders under $HOME). */
const HOME_READABLE = ['.nvm', '.cargo', '.rustup', 'Library/Caches/ms-playwright'];
const HOME_FILES = ['.gitconfig'];

/** A Seatbelt string literal. */
const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Every ancestor of `p` (not `p`), for stat-only reads: git, node and realpath walk up from the workspace. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  let d = dirname(p);
  for (;;) {
    out.push(d);
    const up = dirname(d);
    if (up === d) return out;
    d = up;
  }
}

export interface ProfileInput {
  home: string;
  dataDir: string;
  workspace: string;
  /** The private folder: TMPDIR and caches. */
  private: string;
  enginePort: number | null;
  /** The command's PATH: its folders under $HOME (toolchains) stay readable. */
  path: string;
  /** Internet level (#298 §2.1), default on; `proxyPort` = the engine's allow-list proxy, denied at Off. */
  network?: { level: NetworkLevel; proxyPort: number | null };
}

/** DNS on macOS: the mDNSResponder socket and the dnssd service. */
const DNS_DENY = [
  '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
  '(deny mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.dnssd.service.v2"))',
];

/** The Seatbelt profile of one (project, agent) workspace (#298 §1.2). Allow by default, then deny; the last matching rule wins. */
export function seatbeltProfile(i: ProfileInput): string {
  const home = real(i.home);
  const data = real(i.dataDir);
  const ws = real(i.workspace);
  const priv = real(i.private);
  const pathDirs = i.path
    .split(delimiter)
    .filter((d) => isAbsolute(d))
    .map(real)
    // A PATH folder under $HOME is a toolchain, unless it would open $HOME itself or the data dir.
    .filter((d) => within(d, home) && d !== home && !within(data, d) && !within(d, data));
  const readable = [...new Set([...HOME_READABLE.map((d) => join(home, d)), ...pathDirs])];
  const level = i.network?.level ?? 'on';
  const L: string[] = [
    '(version 1)',
    '(allow default)',
    // Reads: nothing under $HOME (ssh keys, gh login, keychain files, other projects) but toolchains and ~/.gitconfig.
    `(deny file-read* (subpath ${q(home)}))`,
    `(allow file-read-metadata (literal ${q(home)}) (literal ${q(join(home, 'Library'))}) (literal ${q(join(home, 'Library/Caches'))}))`,
    `(allow file-read* ${readable.map((d) => `(subpath ${q(d)})`).join(' ')} ${HOME_FILES.map((f) => `(literal ${q(join(home, f))})`).join(' ')})`,
    // Shared temp folders hold other agents' and the engine's files.
    '(deny file-read* file-write* (subpath "/private/tmp") (subpath "/private/var/tmp"))',
    '(deny file-read* (regex #"^/private/var/folders/[^/]+/[^/]+/T/"))',
    // Atlas data: the database, other workspaces, outputs, checkpoints.
    `(deny file-read* file-write* (subpath ${q(data)}))`,
    // Writes: the workspace and the private folder only (below), the per-user cache of macOS, ttys and /dev/null.
    '(deny file-write* (subpath "/"))',
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/private/var/folders/[^/]+/[^/]+/C/"))',
    // Stat of the folders above the workspace and the private folder (they are denied above when under $HOME or data).
    `(allow file-read-metadata ${[...new Set([...ancestors(ws), ...ancestors(priv)])].map((d) => `(literal ${q(d)})`).join(' ')})`,
    // The command's own workspace and private folder, after every deny.
    `(allow file-read* file-write* (subpath ${q(ws)}) (subpath ${q(priv)}))`,
    // macOS's per-user T folder (confstr, not $TMPDIR): only the names Chrome and xcrun need.
    '(allow file-read* file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/T/(\\.org\\.chromium\\.Chromium\\.|\\.com\\.google\\.Chrome\\.|com\\.google\\.Chrome|xcrun_db)"))',
    // No keychain; no way out through launchd or LaunchServices (an LSOpen of an .app built in the workspace would run it unsandboxed).
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent") (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.quarantine-resolver"))',
    '(deny appleevent-send)',
    '(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/open") (literal "/usr/bin/osascript"))',
    // No docker, no engine API.
    '(deny network-outbound (remote unix-socket (path-literal "/private/var/run/docker.sock")))',
    // Internet (#298 §2.1). Allowed hosts: nothing out but localhost (the proxy, the agent's own servers), no DNS (the
    // proxy resolves names). Off: the same without the proxy. The engine port is denied last, at every level.
    ...(level === 'on' ? [] : ['(deny network-outbound (remote ip "*:*"))', '(allow network-outbound (remote ip "localhost:*"))', ...DNS_DENY]),
    ...(level === 'off' && i.network?.proxyPort ? [`(deny network-outbound (remote ip ${q(`*:${i.network.proxyPort}`)}))`] : []),
    ...(i.enginePort ? [`(deny network-outbound (remote ip ${q(`*:${i.enginePort}`)}))`] : []),
  ];
  return L.join('\n') + '\n';
}

/** Linux: toolchains under $HOME that stay readable (besides the PATH's own folders). */
const HOME_READABLE_LINUX = ['.nvm', '.cargo', '.rustup', '.cache/ms-playwright'];
/** Linux: the system, read-only. /bin, /lib… are symlinks into /usr on merged-/usr systems (Ubuntu), folders elsewhere. */
const SYSTEM_RO = ['/usr', '/etc', '/opt', '/sys', '/run/systemd/resolve'];
const SYSTEM_LINKS = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];

export interface BwrapInput {
  home: string;
  dataDir: string;
  workspace: string;
  /** The private folder: TMPDIR and caches. */
  private: string;
  /** The command's working directory (in the workspace). */
  cwd: string;
  /** The command's PATH: its folders (toolchains) stay readable, unless they open $HOME or the data dir. */
  path: string;
  /** Tests: what a path is on this machine. */
  kind?: (p: string) => { link: string } | 'dir' | 'file' | null;
  /**
   * Internet level (#298 §2.1), default on (the host network). Allowed hosts and Off get their own network namespace
   * (nothing out, a loopback of their own); Allowed hosts gets the engine proxy's unix socket at PROXY_SOCKET.
   */
  network?: { level: NetworkLevel; proxySocket: string | null };
}

/** Linux, Allowed hosts: where the proxy's unix socket appears inside the sandbox, and the port socat relays it on. */
export const PROXY_SOCKET = '/run/atlas/proxy.sock';
export const PROXY_PORT_INSIDE = 3128;

const fsKind = (p: string): { link: string } | 'dir' | 'file' | null => {
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return { link: readlinkSync(p) };
    return st.isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
};

/**
 * The bubblewrap arguments of one (project, agent) workspace (#298 §1.4). bwrap starts from an empty root (a tmpfs) and
 * mounts only what is listed: the system read-only, the PATH's toolchains read-only, a private /proc (own pid
 * namespace), /dev, a tmpfs /tmp, then the workspace and the private folder read-write, last. $HOME and the data dir
 * (database, other workspaces, outputs) are never mounted: inside, they do not exist. When one of them lies under a
 * mounted system folder (a data dir in /opt), an empty tmpfs hides it. Children inherit it all; --die-with-parent and
 * the pid namespace end every process of the command with it. Network: the host's at level On; its own namespace at
 * Allowed hosts (the proxy's socket only) and Off (nothing).
 */
export function bwrapArgs(i: BwrapInput): string[] {
  const kind = i.kind ?? fsKind;
  const home = real(i.home);
  const data = real(i.dataDir);
  const ws = real(i.workspace);
  const priv = real(i.private);
  const a = ['--unshare-pid', '--unshare-ipc', '--die-with-parent', '--new-session'];
  const level = i.network?.level ?? 'on';
  if (level !== 'on') a.push('--unshare-net');
  const mounted: string[] = [];
  for (const d of SYSTEM_LINKS) {
    const k = kind(d);
    if (k && typeof k === 'object') a.push('--symlink', k.link, d);
    else if (k === 'dir') a.push('--ro-bind', d, d), mounted.push(d);
  }
  for (const d of SYSTEM_RO) if (kind(d) === 'dir') a.push('--ro-bind', d, d), mounted.push(d);
  // Hide $HOME and the data dir if a system mount holds them (deepest last, so the data dir's mask is not undone).
  for (const d of [home, data]) if (mounted.some((m) => within(d, m))) a.push('--tmpfs', d);
  const pathDirs = i.path
    .split(delimiter)
    .filter((d) => isAbsolute(d))
    .map(real)
    .filter((d) => d !== '/' && !within(home, d) && !within(data, d) && !within(d, data) && !mounted.some((m) => within(d, m)));
  const tool = [...HOME_READABLE_LINUX.map((d) => join(home, d)), ...pathDirs].filter((d) => !within(d, data) && kind(d) === 'dir');
  for (const d of [...new Set(tool)]) a.push('--ro-bind', d, d);
  a.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  // The command's own workspace and private folder, after everything else: they win over any mask above.
  a.push('--bind', ws, ws, '--bind', priv, priv);
  if (level === 'hosts') {
    if (!i.network?.proxySocket) throw new Error('the network proxy has no unix socket: Allowed hosts cannot run');
    a.push('--bind', i.network.proxySocket, PROXY_SOCKET);
  }
  a.push('--chdir', within(real(i.cwd), ws) || within(real(i.cwd), priv) ? real(i.cwd) : ws);
  return a;
}

/** Why bwrap cannot make its namespaces here, and the fix (#298 §1.4: Ubuntu 24.04 blocks it as shipped). */
export function bwrapFailure(stderr: string, procSys: string): string {
  const msg = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'bwrap failed';
  const read = (f: string) => {
    try {
      return readFileSync(join(procSys, f), 'utf8').trim();
    } catch {
      return null;
    }
  };
  if (!/uid map|Permission denied|Operation not permitted|No permissions to creat|namespace/i.test(msg)) return `bwrap failed: ${msg}`;
  if (read('kernel/apparmor_restrict_unprivileged_userns') === '1')
    return (
      `bwrap cannot create a user namespace (${msg}): this system restricts unprivileged user namespaces ` +
      '(kernel.apparmor_restrict_unprivileged_userns=1, Ubuntu 23.10+). Fix: add the AppArmor profile for bwrap in ' +
      'docs/server-sandbox.md, or run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`, then restart Atlas'
    );
  if (read('kernel/unprivileged_userns_clone') === '0')
    return `bwrap cannot create a user namespace (${msg}): unprivileged user namespaces are off (kernel.unprivileged_userns_clone=0). Fix: \`sudo sysctl -w kernel.unprivileged_userns_clone=1\` (docs/server-sandbox.md), then restart Atlas`;
  if (read('user/max_user_namespaces') === '0')
    return `bwrap cannot create a user namespace (${msg}): user.max_user_namespaces=0. Fix: \`sudo sysctl -w user.max_user_namespaces=15000\` (docs/server-sandbox.md), then restart Atlas`;
  return `bwrap cannot create its namespaces (${msg}): see docs/server-sandbox.md`;
}

/**
 * The generic git config of §1.5, as env (nothing written to disk): ssh GitHub remotes go over https, the only
 * credential helper answers x-access-token / $GH_TOKEN for github.com, and without GH_TOKEN it stops git with what to do.
 */
export function gitEnv(projectName: string, identity: { name?: string; email?: string }): Record<string, string> {
  const missing = `GH_TOKEN is not granted to you in project ${projectName}: ask Master for it with task_block(kind: "capability", secret: "GH_TOKEN")`;
  // git runs it with sh as `<helper> get`, the request on stdin; it is set for https://github.com only (the token never
  // goes to another host). Without GH_TOKEN it says what to do and answers nothing: GIT_TERMINAL_PROMPT=0 makes git stop.
  const helper =
    '!f() { test "$1" = get || exit 0; cat >/dev/null; if [ -z "$GH_TOKEN" ]; then printf "%s\\n" ' +
    `'${missing.replace(/'/g, `'\\''`)}'` +
    ' >&2; exit 0; fi; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';
  const pairs: [string, string][] = [
    ['url.https://github.com/.insteadOf', 'git@github.com:'],
    ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
    // An empty value clears the helpers of the system and global config (osxkeychain needs the keychain: denied).
    ['credential.helper', ''],
    ['credential.https://github.com.helper', helper],
    ...(identity.name ? ([['user.name', identity.name]] as [string, string][]) : []),
    ...(identity.email ? ([['user.email', identity.email]] as [string, string][]) : []),
  ];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length), GIT_TERMINAL_PROMPT: '0' };
  pairs.forEach(([k, v], n) => {
    env[`GIT_CONFIG_KEY_${n}`] = k;
    env[`GIT_CONFIG_VALUE_${n}`] = v;
  });
  return env;
}

export class Sandbox {
  private state: SandboxStatus;
  private identity: { name?: string; email?: string } | null = null;
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly exec: string;
  private readonly bwrap: string;

  constructor(private o: SandboxOptions) {
    this.home = o.home ?? homedir();
    this.platform = o.platform ?? process.platform;
    this.exec = o.sandboxExec ?? '/usr/bin/sandbox-exec';
    this.bwrap = o.bwrap ?? 'bwrap';
    this.state = {
      enabled: o.enabled,
      kind: this.platform === 'darwin' ? 'seatbelt' : this.platform === 'linux' ? 'bwrap' : null,
      ok: false,
      reason: o.enabled ? 'not checked yet' : 'off (ATLAS_SANDBOX is not 1): agent commands run unconfined',
    };
  }

  get enabled(): boolean {
    return this.o.enabled;
  }

  /** The internet levels, when they apply (the sandbox on, #298 S3); null = every workspace On. */
  get network(): Network | null {
    return this.o.enabled ? (this.o.network ?? null) : null;
  }

  status(): SandboxStatus {
    return { ...this.state };
  }

  /** The private folder of a (project, agent): TMPDIR and caches, under the data dir (denied to the others). */
  privateDir(projectId: string, agentId: string): string {
    return join(this.o.dataDir, 'sandbox', projectId, agentId);
  }

  /**
   * The startup probe (§1.6): `true` under a real profile (macOS) or the real bwrap arguments (Linux). Any failure is
   * kept as the reason every agent command fails with, and logged. Off: nothing to check.
   */
  async probe(): Promise<SandboxStatus> {
    if (!this.o.enabled) return this.status();
    const fail = (reason: string) => {
      this.state = { ...this.state, ok: false, reason };
      console.error(`Sandbox unavailable: ${reason}. Agent commands are stopped.`);
      return this.status();
    };
    if (this.platform === 'win32') return fail('no sandbox on Windows');
    if (this.platform !== 'darwin' && this.platform !== 'linux') return fail(`no sandbox on ${this.platform}`);
    try {
      const priv = this.privateDir('_probe', '_probe');
      mkdirSync(join(priv, 'tmp'), { recursive: true });
      if (this.platform === 'darwin') {
        const profile = seatbeltProfile({ home: this.home, dataDir: this.o.dataDir, workspace: priv, private: priv, enginePort: this.o.enginePort(), path: '' });
        await run(this.exec, ['-p', profile, '/usr/bin/true'], (err, e) => `${this.exec} failed: ${(err.trim() || e.message).slice(0, 300)}`);
      } else {
        const args = bwrapArgs({ home: this.home, dataDir: this.o.dataDir, workspace: priv, private: priv, cwd: priv, path: '' });
        await run(this.bwrap, [...args, '--', '/bin/sh', '-c', 'true'], (err, e) =>
          (e as NodeJS.ErrnoException).code === 'ENOENT'
            ? `bubblewrap is not installed (\`${this.bwrap}\` not found): install the bubblewrap package (docs/server-sandbox.md)`
            : bwrapFailure(err || e.message, this.o.procSys ?? '/proc/sys'),
        );
      }
      this.identity = await gitIdentity();
      this.state = { ...this.state, ok: true, reason: null };
      return this.status();
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** Tests: make the probe's verdict. */
  setUnavailable(reason: string): void {
    this.state = { ...this.state, ok: false, reason };
  }

  /** The command line and env of a sandboxed command. Throws SandboxUnavailable when it can't run. */
  wrap(scope: SandboxScope, command: string, env: NodeJS.ProcessEnv, cwd: string = scope.workspace): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
    if (!this.state.ok) throw new SandboxUnavailable(this.state.reason ?? 'unknown');
    const priv = this.privateDir(scope.projectId, scope.agentId);
    const tmp = join(priv, 'tmp');
    const cache = join(priv, 'cache');
    mkdirSync(tmp, { recursive: true });
    mkdirSync(cache, { recursive: true });
    mkdirSync(scope.workspace, { recursive: true });
    const full: NodeJS.ProcessEnv = {
      ...env,
      HOME: scope.workspace,
      TMPDIR: tmp + '/',
      XDG_CACHE_HOME: cache,
      npm_config_cache: join(cache, 'npm'),
      ...gitEnv(scope.projectName, this.identity ?? {}),
    };
    // Master's ssh-agent (teleport keys) never reaches a sandbox.
    delete full.SSH_AUTH_SOCK;
    // No password prompt of any kind (§1.5).
    delete full.GIT_ASKPASS;
    delete full.SSH_ASKPASS;
    // Internet level (#298 §2): read now, so a change applies from the next command on.
    const net = this.o.network ? this.o.network.forCommand(scope.projectId, scope.agentId) : { level: 'on' as const, token: null, proxyUrl: null };
    const linux = this.platform === 'linux';
    if (linux && net.level === 'on' && this.o.engineLogin && !this.o.engineLogin())
      throw new Error(
        'internet level On shares the host network on Linux, where the engine port is reachable: start Atlas with ATLAS_PASSWORD (every API call then needs the login), or set this workspace to Allowed hosts or Off',
      );
    if (net.level === 'hosts') {
      const url = linux ? `http://ws:${net.token}@127.0.0.1:${PROXY_PORT_INSIDE}` : net.proxyUrl!;
      for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy']) full[k] = url;
      full.NO_PROXY = full.no_proxy = 'localhost,127.0.0.1,::1';
      // Node's fetch follows the proxy env only when asked (Node 24).
      full.NODE_USE_ENV_PROXY = '1';
    }
    if (linux) {
      const network = { level: net.level, proxySocket: this.o.network?.socketPath ?? null };
      const args = bwrapArgs({ home: this.home, dataDir: this.o.dataDir, workspace: scope.workspace, private: priv, cwd, path: full.PATH ?? '', network });
      if (net.level !== 'hosts') return { file: this.bwrap, args: [...args, '--', '/bin/bash', '-c', command], env: full };
      // Allowed hosts: socat relays 127.0.0.1:3128 in the sandbox's own network to the proxy's socket, then the command.
      const socat = this.o.socat ?? SOCAT.find((p) => existsSync(p));
      if (!socat || !existsSync(socat)) throw new Error('internet level Allowed hosts needs socat on Linux: install it (sudo apt-get install socat, docs/server-sandbox.md), or set this workspace to On or Off');
      const launcher =
        `${socat} TCP-LISTEN:${PROXY_PORT_INSIDE},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${PROXY_SOCKET} 2>/dev/null & ` +
        `for i in $(seq 200); do (: </dev/tcp/127.0.0.1/${PROXY_PORT_INSIDE}) 2>/dev/null && break; sleep 0.01; done; exec /bin/bash -c "$1"`;
      return { file: this.bwrap, args: [...args, '--', '/bin/bash', '-c', launcher, 'atlas-net', command], env: full };
    }
    const network = { level: net.level, proxyPort: this.o.network?.port ?? null };
    const profile = seatbeltProfile({ home: this.home, dataDir: this.o.dataDir, workspace: scope.workspace, private: priv, enginePort: this.o.enginePort(), path: full.PATH ?? '', network });
    return { file: this.exec, args: ['-p', profile, '/bin/bash', '-c', command], env: full };
  }
}

/** Where socat may be (Linux, Allowed hosts): the system folders mounted in the sandbox. */
const SOCAT = ['/usr/bin/socat', '/usr/local/bin/socat', '/bin/socat'];

/** Runs a probe command; a failure becomes an Error with `why(stderr, error)` as its message. */
function run(file: string, args: string[], why: (stderr: string, e: Error) => string): Promise<void> {
  return new Promise<void>((ok, ko) => execFile(file, args, { timeout: 15_000 }, (e, _out, err) => (e ? ko(new Error(why(String(err), e))) : ok())));
}

/** Master's git name and email (global config), read once by the probe: HOME is the workspace inside the sandbox. */
function gitIdentity(): Promise<{ name?: string; email?: string }> {
  const get = (key: string) =>
    new Promise<string | undefined>((ok) => execFile('git', ['config', '--global', '--get', key], { timeout: 5000 }, (e, out) => ok(e ? undefined : out.trim() || undefined)));
  return Promise.all([get('user.name'), get('user.email')]).then(([name, email]) => ({ name, email }));
}

/** Where and how an agent command runs. `sandbox` null or a sandbox that is off: on the host, as before #298. */
export interface AgentCommandContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  sandbox?: SandboxScope | null;
}

/**
 * The one place an agent command is spawned (#298 §1.6; a test refuses any other `shell: true` spawn in engine/src).
 * Its own process group (Unix) so the whole tree can be killed. `background`: output straight to that file descriptor;
 * else stdout and stderr are pipes. stdin is always closed. `bash`: bash rather than the default shell when unsandboxed
 * (workflow command steps); sandboxed commands always run in bash. Throws SandboxUnavailable (fail closed).
 */
export function spawnAgentCommand(ctx: AgentCommandContext, command: string, o: { background?: { fd: number }; bash?: boolean } = {}): ChildProcess {
  const stdio: ['ignore', 'pipe' | number, 'pipe' | number] = o.background ? ['ignore', o.background.fd, o.background.fd] : ['ignore', 'pipe', 'pipe'];
  const detached = process.platform !== 'win32';
  const s = ctx.sandbox;
  if (s && s.sandbox.enabled) {
    const w = s.sandbox.wrap(s, command, ctx.env, ctx.cwd);
    return spawn(w.file, w.args, { cwd: ctx.cwd, env: w.env, detached, stdio });
  }
  return spawn(command, { cwd: ctx.cwd, shell: o.bash ? 'bash' : true, env: ctx.env, detached, stdio });
}
