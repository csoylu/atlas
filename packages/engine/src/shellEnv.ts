import { spawn } from 'node:child_process';
import type { ShellPathInfo } from '@atlas/shared';

/**
 * The environment of an agent's commands (#136): shell (foreground and background: true) and everything they start.
 *
 * - PATH: the PATH of the user's login shell, read once at engine start. A desktop app opened from Finder only gets
 *   /usr/bin:/bin:/usr/sbin:/sbin, so gh, rg or the nvm node were not found. Server mode (and Windows) use the engine's
 *   own PATH: there is no user terminal to copy, the engine's environment is the reference.
 * - Git author and committer name: the agent id, so a commit says which agent made it. The email stays the user's git
 *   config (GitHub keeps linking commits to the account).
 */

const MARK = '__ATLAS_PATH__';
/** What a new terminal starts from on macOS before its profile runs (so the engine's own PATH, e.g. npx's, doesn't leak in). */
const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** Generous: nvm and friends make a login shell slow (1-2 s here, more on a busy machine). Only the first commands wait. */
const TIMEOUT_MS = 15_000;

export interface ShellPathOptions {
  /** 'login': read the login shell's PATH; 'engine': use the engine's own (server mode, tests). */
  mode: 'login' | 'engine';
  env?: NodeJS.ProcessEnv;
  /** The login shell (default $SHELL). */
  shell?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/** Ask the login shell for its PATH. Never throws: a failure is in `error`, and the engine's PATH is used. */
export async function resolveShellPath(o: ShellPathOptions): Promise<ShellPathInfo> {
  const env = o.env ?? process.env;
  const enginePath = env.PATH ?? '';
  if (o.mode === 'engine') return { path: enginePath, source: 'engine', shell: null, error: null };
  if ((o.platform ?? process.platform) === 'win32') return { path: enginePath, source: 'engine', shell: null, error: null };
  const shell = o.shell ?? env.SHELL;
  const fail = (error: string, sh: string | null = shell ?? null): ShellPathInfo => {
    console.error(`agent shells: could not read the login shell's PATH (${error}); using the engine's PATH: ${enginePath}`);
    return { path: enginePath, source: 'engine', shell: sh, error };
  };
  if (!shell) return fail('$SHELL is not set', null);
  const started = Date.now();
  try {
    const out = await readLoginPath(shell, env, o.timeoutMs ?? TIMEOUT_MS);
    // rc files may print things (banners, prompts): take what's between the marks.
    const m = out.match(new RegExp(`${MARK}(.*?)${MARK}`, 's'));
    const path = m?.[1]?.trim();
    if (!path) return fail(`${shell} printed no PATH`);
    console.log(`agent shells: PATH from the login shell ${shell} (${Date.now() - started} ms): ${path}`);
    return { path, source: 'login', shell, error: null };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

function readLoginPath(shell: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // -i -l: the same files a new terminal reads (zsh: .zprofile and .zshrc, where nvm and Homebrew are set up).
    const child = spawn(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], {
      env: { ...env, PATH: BASE_PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d));
    child.stderr.resume();
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      reject(new Error(`${shell} took more than ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (out.includes(MARK)) resolve(out);
      else reject(new Error(`${shell} exited with ${code}`));
    });
  });
}

/** The environment for a command of `agentId`: the engine's, with the resolved PATH and the agent as git author. */
export function agentEnv(base: NodeJS.ProcessEnv, path: string, agentId: string): NodeJS.ProcessEnv {
  return { ...base, PATH: path, GIT_AUTHOR_NAME: agentId, GIT_COMMITTER_NAME: agentId };
}

/** Resolved once per engine; commands wait for it (only right after start; bounded by the timeout). */
export class ShellEnv {
  readonly ready: Promise<ShellPathInfo>;
  private info: ShellPathInfo | null = null;

  constructor(
    o: ShellPathOptions,
    private base: NodeJS.ProcessEnv = o.env ?? process.env,
  ) {
    this.ready = resolveShellPath(o).then((i) => (this.info = i));
  }

  /** Null until resolved. */
  status(): ShellPathInfo | null {
    return this.info;
  }

  /** The engine's own commands (gh for pull requests, #189): its environment with the login shell's PATH. */
  async engineEnv(): Promise<NodeJS.ProcessEnv> {
    const { path } = await this.ready;
    return { ...this.base, PATH: path };
  }

  async for(agentId: string): Promise<NodeJS.ProcessEnv> {
    const { path } = await this.ready;
    return agentEnv(this.base, path, agentId);
  }
}
