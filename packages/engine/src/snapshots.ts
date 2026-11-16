import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { chmod, lstat, readdir, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';

/**
 * File snapshots of agent workdirs for Rewind (card #34), after Hermes Agent's checkpoint manager: one hidden git store
 * in the data dir (never inside a workdir, so it works for any folder, git or not), driven with GIT_DIR + GIT_WORK_TREE
 * + GIT_INDEX_FILE (one index per workdir, so `git add -A` only re-hashes files whose stat changed). Each snapshot is a
 * parentless commit kept alive by its own ref (refs/atlas/<name>): pruning a snapshot is deleting its ref.
 *
 * A rewind only puts back files its own chat changed (fileLog.ts, card #68): snapshots taken around a shell command
 * tell which files it changed; state() and put() read and write single files. What the agent did outside its workdir,
 * or to excluded files, can't be undone.
 */

/** Never snapshotted (or restored): dependencies, build output, VCS folders, databases, secrets, big binaries. */
export const DEFAULT_EXCLUDES = [
  'node_modules/', '.git/', '.hg/', '.svn/', 'dist/', 'build/', 'out/', 'target/', 'release/', '.next/', '.nuxt/', '.turbo/',
  '.cache/', 'coverage/', '__pycache__/', '.venv/', 'venv/', '.pytest_cache/', '.mypy_cache/', 'data/blobs/', '*.app/',
  '*.pyc', '*.o', '*.a', '*.so', '*.dylib', '*.dll', '*.exe', '*.class', '*.jar', '*.node', '*.asar',
  '*.zip', '*.tar', '*.tgz', '*.tar.gz', '*.7z', '*.rar', '*.dmg', '*.iso', '*.mp4', '*.mov', '*.mkv', '*.webm',
  '*.db', '*.db-wal', '*.db-shm', '*.sqlite', '*.sqlite3', '*-wal', '*-shm',
  '.env', '.env.*', '.DS_Store', '*.log',
];
/** Bigger files are left out of snapshots (and so never deleted or restored by a rewind). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** A folder with more files than this isn't snapshotted (too slow to be done before every message). */
export const MAX_FILES = 50_000;
const GIT_TIMEOUT_MS = 60_000;

/** A file's state: its content (a blob in the store) and git mode (100644, 100755, 120000 = symlink); null = absent. */
export type FileState = { sha: string; mode: string } | null;

export class SnapshotError extends Error {}

/** git's path: PATH first, then the usual places a GUI app's PATH lacks. Null if git isn't installed. */
let gitCache: string | null | undefined;
export function findGit(): string | null {
  if (gitCache !== undefined) return gitCache;
  for (const d of [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    if (!d) continue;
    const p = join(d, process.platform === 'win32' ? 'git.exe' : 'git');
    try {
      accessSync(p, constants.X_OK);
      return (gitCache = p);
    } catch {
      // not here
    }
  }
  return (gitCache = null);
}

const hashOf = (workdir: string) => createHash('sha256').update(workdir).digest('hex').slice(0, 16);

export class Snapshots {
  /** One operation at a time per workdir (they share its index file). */
  private queues = new Map<string, Promise<unknown>>();
  /** Snapshots and blobs made by this engine, with when: the prune keeps recent ones (their row may come later). */
  private made = new Map<string, number>();

  constructor(readonly store: string) {}

  /**
   * Snapshot the workdir; returns the commit (kept by the ref refs/atlas/k/<commit> until drop()). Throws SnapshotError
   * with a plain reason if it can't be done.
   */
  take(workdir: string): Promise<string> {
    return this.serial(workdir, () => this.takeNow(workdir));
  }

  /** The files that differ between two snapshots, with their state in each (null = absent). */
  async diff(workdir: string, from: string, to: string): Promise<{ path: string; before: FileState; after: FileState }[]> {
    const out = await this.git(workdir, ['diff-tree', '-r', '--raw', '-z', '--no-renames', from, to]);
    const parts = out.split('\0');
    const list: { path: string; before: FileState; after: FileState }[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      // ":<from mode> <to mode> <from sha> <to sha> <status>", then the path.
      const [srcMode, dstMode, srcSha, dstSha] = parts[i]!.slice(1).split(' ') as [string, string, string, string];
      // A nested git repository is stored as a link to its commit, not its files: nothing to restore there.
      if (srcMode === '160000' || dstMode === '160000') continue;
      const st = (mode: string, sha: string): FileState => (/^0+$/.test(mode) ? null : { sha, mode });
      list.push({ path: parts[i + 1]!, before: st(srcMode, srcSha), after: st(dstMode, dstSha) });
    }
    return list.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * A file's state now (null = absent). `save`: its content is stored too (and kept by a ref until dropBlobs), so put()
   * can write it back later. A folder where a file is expected gets a state no file matches.
   */
  async state(workdir: string, path: string, save = false): Promise<FileState> {
    const full = join(workdir, path);
    const st = await lstat(full).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
      throw e;
    });
    if (!st) return null;
    if (st.isDirectory()) return { sha: 'folder', mode: '040000' };
    this.init();
    const w = save ? ['-w'] : [];
    const sha = st.isSymbolicLink()
      ? (await this.git(workdir, ['hash-object', ...w, '--stdin'], await readlink(full))).trim()
      : (await this.git(workdir, ['hash-object', ...w, '--no-filters', '--', path])).trim();
    if (save) await this.keepBlobs([sha]);
    return { sha, mode: st.isSymbolicLink() ? '120000' : st.mode & 0o111 ? '100755' : '100644' };
  }

  /** Make the file `path` be `state` (null: delete it, and folders it leaves empty). */
  async put(workdir: string, path: string, state: FileState): Promise<void> {
    const full = join(workdir, path);
    if (!state) {
      await unlink(full).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
      removeEmptyParents(dirname(full), workdir);
      return;
    }
    const content = await run(this.gitPath(), ['cat-file', 'blob', state.sha], this.env(null, null), undefined, false, true);
    mkdirSync(dirname(full), { recursive: true });
    if (state.mode === '120000') {
      await unlink(full).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
      });
      await symlink(content.toString('utf8'), full);
      return;
    }
    const st = await lstat(full).catch(() => null);
    if (st?.isSymbolicLink()) await unlink(full); // write the file itself, not through a link
    await writeFile(full, content);
    await chmod(full, state.mode === '100755' ? 0o755 : 0o644);
  }

  /** Keep these blobs (refs/atlas/b/<sha>) until dropBlobs: gc deletes unreferenced objects. */
  async keepBlobs(list: string[]): Promise<void> {
    const shas = [...new Set(list)];
    if (!shas.length) return;
    this.init();
    for (const s of shas) this.made.set(s, Date.now());
    await run(this.gitPath(), ['update-ref', '--stdin'], this.env(null, null), shas.map((s) => `update refs/atlas/b/${s} ${s}\n`).join(''));
  }

  /** Snapshots and blobs made since `since` (ms); older ones are forgotten. */
  fresh(since: number): string[] {
    for (const [s, t] of this.made) if (t < since) this.made.delete(s);
    return [...this.made.keys()];
  }

  /** Drop snapshots no longer needed (their refs); gc() later deletes their objects. */
  async drop(commits: string[], kind: 'k' | 'b' = 'k'): Promise<void> {
    if (!commits.length || !existsSync(join(this.store, 'HEAD'))) return;
    const input = commits.map((c) => `delete refs/atlas/${kind}/${c}\n`).join('');
    await run(this.gitPath(), ['update-ref', '--stdin'], this.env(null, null), input);
  }

  /** Snapshots (k) or blobs (b) kept in the store. */
  async kept(kind: 'k' | 'b' = 'k'): Promise<string[]> {
    if (!existsSync(join(this.store, 'HEAD'))) return [];
    const out = await run(this.gitPath(), ['for-each-ref', '--format=%(refname:lstrip=3)', `refs/atlas/${kind}/`], this.env(null, null));
    return out.split('\n').filter(Boolean);
  }

  async gc(): Promise<void> {
    if (!existsSync(join(this.store, 'HEAD'))) return;
    await run(this.gitPath(), ['gc', '--prune=1.hour.ago', '--quiet'], this.env(null, null));
  }

  /** Bytes the store takes on disk (objects + packs). */
  async size(): Promise<number> {
    if (!existsSync(join(this.store, 'HEAD'))) return 0;
    const out = await run(this.gitPath(), ['count-objects', '-v'], this.env(null, null));
    const kb = (k: string) => Number(/^(\S+): (\d+)$/m.exec(out.split('\n').find((l) => l.startsWith(k + ':')) ?? '')?.[2] ?? 0);
    return (kb('size') + kb('size-pack')) * 1024;
  }

  private async takeNow(workdir: string): Promise<string> {
    await this.stage(workdir);
    const tree = (await this.git(workdir, ['write-tree'])).trim();
    // A fixed date and message: the same files give the same commit (one ref, no new objects).
    const commit = (await this.git(workdir, ['commit-tree', tree, '-m', 'atlas snapshot'])).trim();
    await this.git(workdir, ['update-ref', `refs/atlas/k/${commit}`, commit]);
    this.made.set(commit, Date.now());
    return commit;
  }

  /** The index = the workdir's snapshotted files now. */
  private async stage(workdir: string): Promise<void> {
    if (!existsSync(workdir)) throw new SnapshotError(`the folder ${workdir} does not exist`);
    if (workdir === resolve(homedir()) || workdir === resolve('/') || workdir === this.store)
      throw new SnapshotError(`${workdir} is too broad to snapshot`);
    this.init();
    const { files, big } = await scan(workdir, this.store);
    if (files > MAX_FILES) throw new SnapshotError(`${workdir} has more than ${MAX_FILES} files: too many to snapshot before each message`);
    const inside = relative(workdir, this.store);
    const skip = [...big, ...(inside && !inside.startsWith('..') ? [inside] : [])];
    const pathspecs = ['.', ...skip.map((p) => `:(exclude,literal)${p}`)];
    await this.git(workdir, ['add', '-A', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], pathspecs.join('\0'), true);
    // A file that grew past the cap since it was staged keeps its old copy in the index: drop it.
    if (skip.length) await this.git(workdir, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], skip.join('\0'));
  }

  private init(): void {
    if (existsSync(join(this.store, 'HEAD'))) return this.writeExcludes();
    mkdirSync(this.store, { recursive: true });
    for (const d of ['objects', 'refs', 'info', 'indexes']) mkdirSync(join(this.store, d), { recursive: true });
    writeFileSync(join(this.store, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      join(this.store, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tbare = true\n\tautocrlf = false\n\tsymlinks = true\n[gc]\n\tauto = 0\n',
    );
    this.writeExcludes();
  }

  private writeExcludes(): void {
    const file = join(this.store, 'info', 'exclude');
    const text = DEFAULT_EXCLUDES.join('\n') + '\n';
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text);
  }

  private gitPath(): string {
    const g = findGit();
    if (!g) throw new SnapshotError('git is not installed: file snapshots need it (brew install git, or the Xcode command line tools)');
    return g;
  }

  private env(workdir: string | null, index: string | null): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
    return {
      ...env,
      GIT_DIR: this.store,
      ...(workdir ? { GIT_WORK_TREE: workdir } : {}),
      ...(index ? { GIT_INDEX_FILE: index } : {}),
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Atlas',
      GIT_AUTHOR_EMAIL: 'atlas@localhost',
      GIT_COMMITTER_NAME: 'Atlas',
      GIT_COMMITTER_EMAIL: 'atlas@localhost',
      GIT_AUTHOR_DATE: '@0 +0000',
      GIT_COMMITTER_DATE: '@0 +0000',
      GIT_TERMINAL_PROMPT: '0',
    };
  }

  private git(workdir: string, args: string[], input?: string, partialOk = false): Promise<string> {
    return run(this.gitPath(), ['-c', 'core.quotepath=off', ...args], this.env(workdir, join(this.store, 'indexes', hashOf(workdir))), input, partialOk);
  }

  private serial<T>(workdir: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(workdir) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.queues.set(workdir, tail);
    void tail.then(() => {
      if (this.queues.get(workdir) === tail) this.queues.delete(workdir);
    });
    return next;
  }
}

/** Run git; a non-zero exit is a SnapshotError with its stderr. `partialOk`: exit 128 with only unreadable-file warnings is fine (add --ignore-errors). */
function run(git: string, args: string[], env: NodeJS.ProcessEnv, input?: string, partialOk?: boolean): Promise<string>;
function run(git: string, args: string[], env: NodeJS.ProcessEnv, input: string | undefined, partialOk: boolean, binary: true): Promise<Buffer>;
function run(git: string, args: string[], env: NodeJS.ProcessEnv, input?: string, partialOk = false, binary = false): Promise<string | Buffer> {
  // Pathspecs are relative to the current folder: run in the work tree (or the store).
  const cwd = env.GIT_WORK_TREE ?? env.GIT_DIR;
  return new Promise((ok, fail) => {
    const opts = { env, cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: binary ? ('buffer' as const) : ('utf8' as const) };
    const child = execFile(git, args, opts, (err, stdout: string | Buffer, stderr: string | Buffer) => {
      if (!err) return ok(stdout);
      const msg = String(stderr).trim();
      if (partialOk && (err as { code?: unknown }).code === 1 && /unable to (index|stat)|could not open|permission denied/i.test(msg)) return ok(stdout);
      fail(new SnapshotError(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} failed: ${msg || err.message}`));
    });
    child.stdin?.end(input ?? '');
  });
}

const EXCLUDED_DIRS = new Set(DEFAULT_EXCLUDES.filter((e) => e.endsWith('/') && !e.includes('*') && !e.slice(0, -1).includes('/')).map((e) => e.slice(0, -1)));
const EXCLUDED_FILE = new RegExp(
  '^(?:' +
    DEFAULT_EXCLUDES.filter((e) => !e.endsWith('/'))
      .map((e) => e.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '.*'))
      .join('|') +
    ')$',
);

/** Whether a path (relative to the workdir, `/`-separated) is snapshotted: false for excluded folders and files. */
export function snapshotted(path: string): boolean {
  const parts = path.split(/[\\/]/);
  if (parts.some((p) => p === '' || p === '..')) return false;
  if (path === 'data/blobs' || path.startsWith('data/blobs/')) return false;
  return parts.slice(0, -1).every((d) => !EXCLUDED_DIRS.has(d) && !d.endsWith('.app')) && !EXCLUDED_FILE.test(parts.at(-1)!);
}

/** Count the files a snapshot would take and list the oversize ones (relative paths), skipping excluded folders. */
async function scan(root: string, store: string): Promise<{ files: number; big: string[] }> {
  let files = 0;
  const big: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (files > MAX_FILES || dir === store) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: git skips it too (add --ignore-errors)
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name) || e.name.endsWith('.app') || relative(root, p) === join('data', 'blobs')) continue;
        await walk(p);
      } else if (e.isFile() && !EXCLUDED_FILE.test(e.name)) {
        files++;
        if (files > MAX_FILES) return;
        const st = await lstat(p).catch(() => null);
        if (st && st.size > MAX_FILE_BYTES) big.push(relative(root, p).split(sep).join('/'));
      }
    }
  };
  await walk(root);
  return { files, big };
}

function removeEmptyParents(dir: string, root: string): void {
  while (dir.startsWith(root + sep)) {
    try {
      rmdirSync(dir);
    } catch {
      return; // not empty (or gone): stop climbing
    }
    dir = dirname(dir);
  }
}
