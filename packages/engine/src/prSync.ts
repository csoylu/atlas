import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renumber, type Rename } from '../../../scripts/pr/migrations.mjs';

/**
 * The merge queue's « bring the PR up to date with main » (#236, design §7.1). Before the head of a project's queue is
 * reviewed, its branch is rebased onto main in a throwaway worktree of the reviewer's clone, its new migrations whose
 * number main already took are renumbered (and every reference to their file name in the files the PR changes), and
 * the result is pushed to the PR's branch with --force-with-lease pinned to the head GitHub showed. A rebase that does
 * not apply cleanly is not forced: the conflicting files go back to the builder. The clone's working tree, index,
 * branches and remote-tracking refs are left as they were: the commits are fetched by URL under refs/atlas-queue/.
 */
export type SyncResult =
  /** Already contains main, no migration to renumber: nothing pushed. */
  | { kind: 'current' }
  /** The branch moved on GitHub since the read: wait for the next read. */
  | { kind: 'moved'; head: string }
  | { kind: 'pushed'; oldHead: string; newHead: string; onto: string; rebased: boolean; renamed: Rename[] }
  | { kind: 'conflict'; files: string[]; onto: string };

export interface SyncArgs {
  /** A clone of the PR's repo (its origin is the repo). */
  clone: string;
  branch: string;
  /** The head GitHub showed: the push only replaces this one. */
  sha: string;
  base?: string;
  env: NodeJS.ProcessEnv;
}

const PROTECTED = new Set(['main', 'master']);

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => err.push(d));
    p.on('error', reject);
    p.on('close', (status) => resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

type Git = {
  (args: string[]): Promise<string>;
  maybe(args: string[]): Promise<{ status: number | null; out: string; err: string }>;
};

/** git in `dir` (hooks off, no ref updates by rebase): stdout without its last newline; throws with git's stderr. */
function gitIn(dir: string, env: NodeJS.ProcessEnv): Git {
  const pre = ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'rebase.updateRefs=false', '-c', 'rebase.autoStash=false', '-c', 'commit.gpgSign=false'];
  const maybe = async (args: string[]) => {
    const r = await run([...pre, ...args], env);
    return { status: r.status, out: r.stdout.replace(/\n$/, ''), err: r.stderr };
  };
  const git = (async (args: string[]) => {
    const r = await maybe(args);
    if (r.status !== 0) throw new Error(`git ${args.slice(0, 2).join(' ')} failed: ${(r.err || r.out).trim()}`);
    return r.out;
  }) as Git;
  git.maybe = maybe;
  return git;
}

const lines = (s: string) => s.split('\n').filter(Boolean);

export async function syncBranch(a: SyncArgs): Promise<SyncResult> {
  const base = a.base ?? 'main';
  if (PROTECTED.has(a.branch) || a.branch === base) throw new Error(`will not rewrite "${a.branch}"`);
  const git = gitIn(a.clone, a.env);
  const ns = `refs/atlas-queue/${process.pid}-${Date.now()}`;
  let worktree: string | null = null;
  try {
    // By URL, not by remote name: a fetch by name would move the clone's origin/* refs.
    const url = await git(['remote', 'get-url', 'origin']);
    await git(['fetch', '-q', '--no-tags', url, `+refs/heads/${base}:${ns}/base`, `+refs/heads/${a.branch}:${ns}/head`]);
    const onto = await git(['rev-parse', `${ns}/base`]);
    const oldHead = await git(['rev-parse', `${ns}/head`]);
    if (!oldHead.startsWith(a.sha.toLowerCase())) return { kind: 'moved', head: oldHead };
    const forkPoint = await git(['merge-base', onto, oldHead]);

    worktree = mkdtempSync(join(tmpdir(), 'atlas-queue-'));
    await git(['worktree', 'add', '-q', '--detach', worktree, oldHead]);
    const wt = gitIn(worktree, a.env);
    const rebased = forkPoint !== onto;
    if (rebased) {
      const r = await wt.maybe(['rebase', '-q', '--no-autosquash', onto]);
      if (r.status !== 0) {
        const files = lines((await wt.maybe(['diff', '--name-only', '--diff-filter=U'])).out);
        await wt.maybe(['rebase', '--abort']);
        if (!files.length) throw new Error(`git rebase onto ${base} failed: ${(r.err || r.out).trim()}`);
        return { kind: 'conflict', files, onto };
      }
    }

    // Migrations the PR adds whose number main already took: renamed above main's, references too, one commit.
    const added = lines(await wt(['diff', '--name-only', '--no-renames', '--diff-filter=A', onto, 'HEAD']));
    const renamed = renumber(added, lines(await wt(['ls-tree', '-r', '--name-only', onto])));
    if (renamed.length) {
      for (const r of renamed) await wt(['mv', r.from, r.to]);
      const changed = lines(await wt(['diff', '--name-only', '--no-renames', '--diff-filter=d', onto]));
      for (const f of changed) {
        const path = join(worktree, f);
        if (!existsSync(path)) continue;
        const buf = readFileSync(path);
        if (buf.includes(0)) continue; // binary
        let text = buf.toString('utf8');
        for (const r of renamed) text = text.split(r.fromStem).join(r.toStem);
        if (text !== buf.toString('utf8')) {
          writeFileSync(path, text);
          await wt(['add', '--', f]);
        }
      }
      const msg = `Renumber migration${renamed.length > 1 ? 's' : ''} above ${base}'s: ${renamed.map((r) => `${r.fromStem} → ${r.toStem}`).join(', ')} (merge queue)`;
      await wt(['commit', '-q', '--no-verify', '--cleanup=verbatim', '-m', msg]);
    }
    const newHead = await wt(['rev-parse', 'HEAD']);
    if (newHead === oldHead) return { kind: 'current' };

    // Push the branch only, and only if it is still the head GitHub showed. A push to a URL still moves the clone's
    // matching origin/<branch> on recent git: snapshot refs/remotes/origin/ and put it back right after.
    const pushUrl = await git(['remote', 'get-url', '--push', 'origin']);
    const tracking = async () => new Map(lines(await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin/'])).map((l) => l.split(' ') as [string, string]));
    const before = await tracking();
    const push = await git.maybe(['push', '-q', '--porcelain', `--force-with-lease=refs/heads/${a.branch}:${oldHead}`, pushUrl, `${newHead}:refs/heads/${a.branch}`]);
    for (const [ref, oid] of await tracking()) {
      if (!before.has(ref)) await git(['update-ref', '-d', ref, oid]);
      else if (before.get(ref) !== oid) await git(['update-ref', ref, before.get(ref)!, oid]);
    }
    if (push.status !== 0) {
      const now = (await git.maybe(['ls-remote', url, `refs/heads/${a.branch}`])).out.split(/\s/)[0] ?? '';
      if (now && now !== oldHead) return { kind: 'moved', head: now };
      throw new Error(`push of ${a.branch} refused: ${(push.err || push.out).trim()}`);
    }
    return { kind: 'pushed', oldHead, newHead, onto, rebased, renamed };
  } finally {
    if (worktree) {
      await git.maybe(['worktree', 'remove', '--force', worktree]);
      rmSync(worktree, { recursive: true, force: true });
      await git.maybe(['worktree', 'prune']);
    }
    for (const r of lines((await git.maybe(['for-each-ref', '--format=%(refname)', ns])).out)) await git.maybe(['update-ref', '-d', r]);
  }
}

/** owner/name of a git remote url (git@github.com:o/n.git, https://github.com/o/n, ssh://…), lower case; null if not GitHub. */
export function repoOfUrl(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * The reviewer's clone of `repo`: its workspace itself or a folder right inside it whose origin is the repo. None: a
 * clear error (nothing is cloned behind the agent's back). `match` (tests): how a remote url names a repo.
 */
export async function findClone(workdir: string, repo: string, env: NodeJS.ProcessEnv, match: (url: string) => string | null = repoOfUrl): Promise<string> {
  const dirs = [workdir, ...(existsSync(workdir) ? readdirSync(workdir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => join(workdir, d.name)) : [])];
  for (const dir of dirs) {
    if (!existsSync(join(dir, '.git'))) continue;
    const r = await run(['-C', dir, 'remote', 'get-url', 'origin'], env);
    if (r.status === 0 && match(r.stdout) === repo.toLowerCase()) return dir;
  }
  throw new Error(`no clone of ${repo} in ${workdir} (or a folder right inside it, origin = the repo): the merge queue rebases there`);
}
