import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The merge queue's tests (#236): a local bare repo standing for GitHub, a builder's clone that pushes to it, and a
// reviewer's clone (in a workspace folder) where the queue rebases. Git runs with a fixed identity and no user config.
const M = 'pkg/migrations';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'csoylu', GIT_AUTHOR_EMAIL: 'c@x', GIT_COMMITTER_NAME: 'csoylu', GIT_COMMITTER_EMAIL: 'c@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** A bare « GitHub » repo, a builder's clone that pushes, and the reviewer's clone the queue works in. */
export function repoKit() {
  const root = mkdtempSync(join(tmpdir(), 'queue-'));
  const bare = join(root, 'origin.git');
  const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  sh(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const dev = join(root, 'dev');
  sh(root, 'clone', '-q', bare, dev);
  const write = (files: Record<string, string>) => {
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dev, f)), { recursive: true });
      writeFileSync(join(dev, f), c);
    }
  };
  /** Commit `files` on `branch` (from main when new) and push it; returns the new head. */
  const commit = (branch: string, files: Record<string, string>, msg = 'change') => {
    const exists = sh(dev, 'ls-remote', 'origin', `refs/heads/${branch}`);
    sh(dev, 'fetch', '-q', 'origin');
    if (branch === 'main') sh(dev, 'checkout', '-q', '-B', 'main', 'origin/main');
    else sh(dev, 'checkout', '-q', '-B', branch, exists ? `origin/${branch}` : 'origin/main');
    write(files);
    sh(dev, 'add', '-A');
    sh(dev, 'commit', '-q', '-m', msg);
    sh(dev, 'push', '-q', '-f', 'origin', `HEAD:refs/heads/${branch}`);
    return sh(dev, 'rev-parse', 'HEAD');
  };
  write({ 'README.md': 'atlas\n', [`${M}/0001_init.sql`]: 'CREATE TABLE a (x);\n', 'src/a.ts': 'export const a = 1;\n' });
  sh(dev, 'add', '-A');
  sh(dev, 'commit', '-q', '-m', 'init');
  sh(dev, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  const ws = join(root, 'zurich');
  mkdirSync(ws);
  const clone = join(ws, 'atlas');
  sh(ws, 'clone', '-q', bare, clone);
  const head = (branch: string) => sh(bare, 'rev-parse', `refs/heads/${branch}`);
  const show = (rev: string, path: string) => sh(bare, 'show', `${rev}:${path}`);
  const files = (rev: string) => sh(bare, 'ls-tree', '-r', '--name-only', rev).split('\n');
  /** main merges `branch` (a merge commit, like GitHub's merge button). */
  const merge = (branch: string) => {
    sh(dev, 'fetch', '-q', 'origin');
    sh(dev, 'checkout', '-q', '-B', 'main', 'origin/main');
    sh(dev, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}`, `origin/${branch}`);
    sh(dev, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    return sh(dev, 'rev-parse', 'HEAD');
  };
  return { root, bare, clone, ws, commit, head, show, files, merge, sh, env: ENV };
}

