import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { SandboxStatus } from '@atlas/shared';

/**
 * Agent command sandbox (#298 §1.2, §1.5, §1.6; S1 = macOS Seatbelt). Every agent command (shell, background shell,
 * secret_set's command, workflow command steps) goes through `spawnAgentCommand`. With the sandbox on, it runs as
 * `sandbox-exec -p <profile> /bin/bash -c <cmd>` with HOME = the workspace, a private TMPDIR and cache under the data
 * dir, and a git config that takes GitHub credentials from $GH_TOKEN only. Fail closed: if the startup probe failed,
 * every agent command throws SandboxUnavailable and the run stops; there is never a host fallback.
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
  /** Tests: another home, platform or sandbox-exec. */
  home?: string;
  platform?: NodeJS.Platform;
  sandboxExec?: string;
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
}

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
    ...(i.enginePort ? [`(deny network-outbound (remote ip ${q(`*:${i.enginePort}`)}))`] : []),
  ];
  return L.join('\n') + '\n';
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

  constructor(private o: SandboxOptions) {
    this.home = o.home ?? homedir();
    this.platform = o.platform ?? process.platform;
    this.exec = o.sandboxExec ?? '/usr/bin/sandbox-exec';
    this.state = {
      enabled: o.enabled,
      kind: this.platform === 'darwin' ? 'seatbelt' : null,
      ok: false,
      reason: o.enabled ? 'not checked yet' : 'off (ATLAS_SANDBOX is not 1): agent commands run unconfined',
    };
  }

  get enabled(): boolean {
    return this.o.enabled;
  }

  status(): SandboxStatus {
    return { ...this.state };
  }

  /** The private folder of a (project, agent): TMPDIR and caches, under the data dir (denied to the others). */
  privateDir(projectId: string, agentId: string): string {
    return join(this.o.dataDir, 'sandbox', projectId, agentId);
  }

  /**
   * The startup probe (§1.6): `true` under a real profile. Any failure is kept as the reason every agent command
   * fails with, and logged. Off: nothing to check.
   */
  async probe(): Promise<SandboxStatus> {
    if (!this.o.enabled) return this.status();
    const fail = (reason: string) => {
      this.state = { ...this.state, ok: false, reason };
      console.error(`Sandbox unavailable: ${reason}. Agent commands are stopped.`);
      return this.status();
    };
    if (this.platform === 'linux') return fail('no Linux sandbox yet (bubblewrap comes with #298 S2)');
    if (this.platform !== 'darwin') return fail(`no sandbox on ${this.platform}`);
    try {
      const priv = this.privateDir('_probe', '_probe');
      mkdirSync(join(priv, 'tmp'), { recursive: true });
      const profile = seatbeltProfile({ home: this.home, dataDir: this.o.dataDir, workspace: priv, private: priv, enginePort: this.o.enginePort(), path: '' });
      await new Promise<void>((ok, ko) =>
        execFile(this.exec, ['-p', profile, '/usr/bin/true'], { timeout: 15_000 }, (e, _out, err) =>
          e ? ko(new Error(`${this.exec} failed: ${(String(err).trim() || e.message).slice(0, 300)}`)) : ok(),
        ),
      );
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
  wrap(scope: SandboxScope, command: string, env: NodeJS.ProcessEnv): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
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
    const profile = seatbeltProfile({ home: this.home, dataDir: this.o.dataDir, workspace: scope.workspace, private: priv, enginePort: this.o.enginePort(), path: full.PATH ?? '' });
    return { file: this.exec, args: ['-p', profile, '/bin/bash', '-c', command], env: full };
  }
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
    const w = s.sandbox.wrap(s, command, ctx.env);
    return spawn(w.file, w.args, { cwd: ctx.cwd, env: w.env, detached, stdio });
  }
  return spawn(command, { cwd: ctx.cwd, shell: o.bash ? 'bash' : true, env: ctx.env, detached, stdio });
}
