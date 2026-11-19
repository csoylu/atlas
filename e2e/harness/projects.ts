import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnClone, type CloneRun, type GhRun } from '../../packages/engine/src/projects.ts';

/**
 * A second project's « GitHub » for the e2e tests (#218): bare repos on disk (`<root>/<owner>/<name>.git`), a `gh`
 * stand-in for the New project form's repo check that answers from them, and a clone that is the real `git clone`
 * (real progress lines, real failure messages) from those repos. A gate lets a test hold every clone open to see
 * « cloning » on screen, and `down` makes clones fail like a network or access error.
 */
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'dina', GIT_AUTHOR_EMAIL: 'd@x', GIT_COMMITTER_NAME: 'dina', GIT_COMMITTER_EMAIL: 'd@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export class Remotes {
  readonly root = mkdtempSync(join(tmpdir(), 'atlas-remotes-'));
  /** Repos the check says exist although they can't be cloned (renamed after the check, access lost): `owner/name`. */
  announced = new Set<string>();
  /** While set, every clone waits for it. */
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  /** Every clone started, in order: `owner/name`. */
  cloned: string[] = [];

  /** A bare repo holding `files` on main. */
  repo(name: string, files: Record<string, string>): string {
    const work = mkdtempSync(join(tmpdir(), 'atlas-src-'));
    git(work, 'init', '-q', '-b', 'main');
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(work, f)), { recursive: true });
      writeFileSync(join(work, f), text);
    }
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'init');
    mkdirSync(join(this.root, name.split('/')[0]!), { recursive: true });
    git(this.root, 'clone', '-q', '--bare', work, `${name}.git`);
    rmSync(work, { recursive: true, force: true });
    return join(this.root, `${name}.git`);
  }
  private path = (name: string) => join(this.root, `${name}.git`);
  exists = (name: string) => existsSync(this.path(name));

  /** Hold every clone from now on until release(). */
  hold(): void {
    this.gate = new Promise((r) => (this.open = r));
  }
  release(): void {
    this.open?.();
    this.gate = null;
  }

  /** The repo check's gh: `gh api repos/<name>` and `repos/<name>/contents/?ref=<branch>`. */
  gh: GhRun = async (args) => {
    const m = /^repos\/([^/]+\/[^/?]+)(\/contents\/)?/.exec(args[1] ?? '');
    if (args[0] !== 'api' || !m) throw new Error(`unexpected gh call: ${args.join(' ')}`);
    const name = m[1]!;
    if (!this.exists(name) && !this.announced.has(name)) throw new Error('gh: Not Found (HTTP 404)');
    if (m[2]) {
      if (!this.exists(name)) return '[]';
      return JSON.stringify(git(this.path(name), 'ls-tree', 'main').split('\n').filter(Boolean).map((l) => ({ name: l.split('\t')[1], type: l.includes(' blob ') ? 'file' : 'dir' })));
    }
    return JSON.stringify({ private: true, default_branch: 'main' });
  };

  clone: CloneRun = async (repo, dir, o) => {
    this.cloned.push(repo);
    if (this.gate) await this.gate;
    o.signal.throwIfAborted();
    if (!this.exists(repo)) throw new Error(`fatal: repository '${repo}' not found`);
    return spawnClone('git', ['clone', '--progress', this.path(repo), dir], o);
  };

  get options() {
    return { gh: this.gh, clone: this.clone };
  }
  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
  /** Names of the folders in a directory (for « what is in the workspace »). */
  static ls = (dir: string) => readdirSync(dir).sort();
}

/** A fake `gh` for pr_validate on one repo (as in prTools.test.ts): the PR, a green CI, the merge; every call recorded. */
export function gateGh(repo: string, number: number, sha: string) {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    const path = args[1]!;
    if (!path.startsWith(`repos/${repo}/`)) throw new Error(`asked another repo: ${path}`);
    if (path.endsWith(`/pulls/${number}`))
      return JSON.stringify({ state: 'open', draft: false, merged: false, mergeable: true, base: { ref: 'main', repo: { full_name: repo, default_branch: 'main' } }, head: { sha, ref: 'feat/1-x', repo: { full_name: repo } }, number });
    if (path.endsWith(`/pulls/${number}/merge`)) return JSON.stringify({ sha: 'b'.repeat(40), merged: true });
    if (path.includes('/check-runs')) return JSON.stringify({ check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] });
    if (path.includes('/statuses/')) return '{}';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { gh, calls, merges: () => calls.filter((c) => c[1]!.endsWith('/merge')) };
}
