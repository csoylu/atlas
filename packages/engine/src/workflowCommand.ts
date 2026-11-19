import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * « Run a command » steps (#273, design §10b): the pieces outside the store. Run fields as env vars with size caps, a
 * clean checkout per step on the project repo's default branch, the child in its own process group with a time
 * limit, and the pid + start time check that lets a restart kill only that child.
 */

/** Per field value, and for all fields together (the OS limit on the environment). */
export const FIELD_VALUE_MAX = 16 * 1024;
export const FIELDS_TOTAL_MAX = 128 * 1024;
/** The step summary keeps the end of the (redacted) output. */
export const SUMMARY_TAIL = 4000;
/** After SIGTERM at the time limit, SIGKILL this much later. */
export const KILL_GRACE_MS = 10_000;
/** Output kept in memory at most; more is dropped and the summary says so. */
const OUTPUT_MAX = 64 * 1024 * 1024;

/** Names a field must never take: a shell relies on them. */
const SHELL_BASICS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'TMPDIR', 'LANG', 'TERM', 'IFS', 'ENV', 'BASH_ENV', 'CDPATH',
  'PS1', 'PS2', 'PS4', 'SHELLOPTS', 'BASHOPTS', 'GLOBIGNORE', 'HOSTNAME', 'SHLVL', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'GIT_DIR', 'GIT_WORK_TREE',
]);

/** `task.ref` → TASK_REF, `steps.review.summary` → STEPS_REVIEW_SUMMARY. */
export const envName = (field: string) => field.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** The digest Master approves: exactly what the approval banner shows (the checkout is always the default branch). */
export function commandDigest(c: { command: string; secrets: string[]; limitMin: number }, project: string, repo: string | null): string {
  const body = JSON.stringify({ command: c.command, secrets: [...c.secrets].sort(), limitMin: c.limitMin, project, repo });
  return createHash('sha256').update(body).digest('hex');
}

/**
 * The run's fields as env vars. A name taken (a secret, a shell basic, the base env) drops the field; a value over
 * 16 KB is cut; past 128 KB in total the longest fields are dropped first. Every cut or drop is in `notes`.
 */
export function fieldsEnv(fields: Record<string, string>, taken: Set<string>): { env: Record<string, string>; notes: string[] } {
  const env: Record<string, string> = {};
  const notes: string[] = [];
  const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
  for (const [field, raw] of Object.entries(fields)) {
    const name = envName(field);
    if (SHELL_BASICS.has(name) || taken.has(name)) {
      notes.push(`${field} not passed: $${name} is taken`);
      continue;
    }
    if (env[name] !== undefined) {
      notes.push(`${field} not passed: $${name} is another field's`);
      continue;
    }
    let v = raw.replace(/\0/g, '');
    if (bytes(v) > FIELD_VALUE_MAX) {
      v = Buffer.from(v, 'utf8').subarray(0, FIELD_VALUE_MAX).toString('utf8').replace(/\uFFFD$/, '');
      notes.push(`$${name} cut to 16 KB (it had ${Math.ceil(bytes(raw) / 1024)} KB)`);
    }
    env[name] = v;
  }
  let total = Object.entries(env).reduce((n, [k, v]) => n + bytes(k) + bytes(v) + 2, 0);
  const longest = Object.keys(env).sort((a, b) => bytes(env[b]!) - bytes(env[a]!));
  for (const k of longest) {
    if (total <= FIELDS_TOTAL_MAX) break;
    total -= bytes(k) + bytes(env[k]!) + 2;
    delete env[k];
    notes.push(`$${k} dropped: the fields passed 128 KB in total`);
  }
  return { env, notes };
}

/** How a step's checkout is made: `<data>/checkouts/<project>/repo`, a worktree per step in `runs/`. */
export interface CheckoutOptions {
  dataDir: string;
  /** First clone of the repo into `dir` (default: gh repo clone, Master's login). Throws when it can't. */
  clone?: (repo: string, dir: string, env: NodeJS.ProcessEnv) => Promise<void>;
}

const run = (cmd: string, args: string[], o: { cwd?: string; env: NodeJS.ProcessEnv }) =>
  new Promise<string>((ok, ko) => {
    execFile(cmd, args, { cwd: o.cwd, env: o.env, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 }, (err, stdout, stderr) => {
      if (err) ko(new Error(`${cmd} ${args[0]} failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`));
      else ok(stdout);
    });
  });

export const checkoutRoot = (dataDir: string, project: string) => resolve(dataDir, 'checkouts', project);
export const worktreeDir = (dataDir: string, project: string, key: string) => join(checkoutRoot(dataDir, project), 'runs', key);

/**
 * A clean worktree of the repo's default branch for one step. Each failure (gh logged out, offline, no default
 * branch) throws: the step couldn't run, it is not an outcome. Returns the folder and the commit checked out.
 */
export async function prepareCheckout(o: CheckoutOptions, project: string, repo: string, key: string, env: NodeJS.ProcessEnv): Promise<{ dir: string; branch: string; sha: string }> {
  const root = checkoutRoot(o.dataDir, project);
  const clone = join(root, 'repo');
  mkdirSync(join(root, 'runs'), { recursive: true });
  if (!existsSync(join(clone, '.git'))) {
    rmSync(clone, { recursive: true, force: true }); // a clone a kill left half done
    const doClone = o.clone ?? ((r: string, d: string, e: NodeJS.ProcessEnv) => run('gh', ['repo', 'clone', r, d], { env: e }).then(() => undefined));
    await doClone(repo, clone, env);
  }
  const head = await run('git', ['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: clone, env });
  const branch = head.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1];
  if (!branch) throw new Error(`the default branch of ${repo} could not be read`);
  await run('git', ['fetch', '--quiet', 'origin', branch], { cwd: clone, env });
  const dir = worktreeDir(o.dataDir, project, key);
  await removeWorktree(clone, dir, env);
  await run('git', ['worktree', 'add', '--quiet', '--detach', dir, 'FETCH_HEAD'], { cwd: clone, env });
  const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: dir, env })).trim();
  return { dir, branch, sha };
}

/** Remove a step's worktree (and git's record of it). Never throws: a missing one is fine. */
export async function removeWorktree(clone: string, dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  if (existsSync(join(clone, '.git'))) await run('git', ['worktree', 'prune'], { cwd: clone, env }).catch((e: unknown) => console.error('git worktree prune failed', e));
}

/** At start: every step worktree a stopped engine left (none of them is running). */
export function removeStaleWorktrees(dataDir: string): string[] {
  const base = resolve(dataDir, 'checkouts');
  if (!existsSync(base)) return [];
  const gone: string[] = [];
  for (const p of readdirSync(base)) {
    const runs = join(base, p, 'runs');
    if (!existsSync(runs)) continue;
    for (const d of readdirSync(runs)) {
      rmSync(join(runs, d), { recursive: true, force: true });
      gone.push(join(runs, d));
    }
    const clone = join(base, p, 'repo');
    if (existsSync(join(clone, '.git'))) {
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: clone, stdio: 'ignore' });
      } catch (e) {
        console.error(`git worktree prune in ${clone} failed`, e);
      }
    }
  }
  return gone;
}

/** The start time of a process as `ps` gives it (null: no such process). Compared to tell a reused pid apart. */
export function processStart(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out || null;
  } catch {
    return null; // ps exits 1 when there is no such process
  }
}

export function signalGroup(pid: number, sig: NodeJS.Signals): boolean {
  try {
    if (process.platform === 'win32') process.kill(pid, sig);
    else process.kill(-pid, sig);
    return true;
  } catch {
    return false; // already gone
  }
}

/** Kill a stopped engine's command group, only if `pid` is still the process that was started (same start time). */
export function killIfSame(pid: number, started: string | null): boolean {
  const now = processStart(pid);
  if (!now || !started || now !== started) return false;
  return signalGroup(pid, 'SIGKILL');
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
  /** More than OUTPUT_MAX: the end was dropped. */
  truncated: boolean;
}

/**
 * `bash -c command` in `cwd`, its own process group. `onSpawn` gets the pid synchronously, before any other event
 * (the caller stores it in one transaction). The limit sends SIGTERM to the group, then SIGKILL after KILL_GRACE_MS.
 */
export function spawnCommand(command: string, o: { cwd: string; env: NodeJS.ProcessEnv; limitMs: number; onSpawn: (pid: number, child: ChildProcess) => void }): Promise<CommandResult> {
  return new Promise((done) => {
    const child = spawn('bash', ['-c', command], { cwd: o.cwd, env: o.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const take = (b: Buffer) => {
      if (size >= OUTPUT_MAX) return void (truncated = true);
      chunks.push(b);
      size += b.length;
    };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    let timedOut = false;
    let kill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) signalGroup(child.pid, 'SIGTERM');
      kill = setTimeout(() => child.pid && signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    }, o.limitMs);
    let spawnError: string | null = null;
    child.on('error', (e) => (spawnError = e.message));
    if (child.pid) o.onSpawn(child.pid, child);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(kill);
      let output = Buffer.concat(chunks).toString('utf8');
      // A value cut at the end could slip past the redactor: drop the last 4 KB too.
      if (truncated) output = output.slice(0, Math.max(0, output.length - 4096));
      if (spawnError) output += `\n(could not start bash: ${spawnError})`;
      done({ code, signal, timedOut, output, truncated });
    });
  });
}

export function writeLog(dataDir: string, name: string, text: string): string {
  const dir = resolve(dataDir, 'outputs', 'workflows');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.log`);
  writeFileSync(path, text);
  return path;
}
