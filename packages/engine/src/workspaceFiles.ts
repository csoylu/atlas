import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FILE_EDIT_MAX, FILE_LARGE_LINES, type GitLetter, type SaveWsFile, type WsEntry, type WsFile, type WsListing, type WsSaveResult, type WsStat } from '@atlas/shared';
import type { Db } from './store/db.ts';
import { ConflictError, InvalidError, NotFoundError, type Kanban } from './kanban.ts';
import { workspaceOf } from './projects.ts';

/**
 * Files of a chat's agent workspace for the pane's Files tab (#303): list, read, write, find, links in chat.
 *
 * The boundary is the agent file tools' (#245): the agent's workspace in the chat's project and nothing else. A path is
 * relative, stays inside once `..` is resolved, and once its links are resolved too (a link to another project's clone,
 * or anywhere out, is refused). Text sent to the UI passes the secrets redactor like /api/files (#226); a file that held
 * a secret value is read only, or saving would write « [secret NAME] » over the value.
 */

/** The entry is there, a link to nothing included (existsSync follows links). */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw e;
  }
}

/** Shown as pictures (not edited). svg is text: edited as code. */
export const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};
/** Never listed: git's own folder and Finder's litter. */
const HIDDEN = new Set(['.git', '.DS_Store']);
/** Not searched by « Find a file » (⌘P). */
const SKIP_FIND = new Set(['.git', 'node_modules']);
/** Most paths « Find a file » indexes, and how long an index serves. */
const FIND_CAP = 200_000;
const FIND_TTL = 15_000;
const FIND_MAX = 50;
/** How long a repository's git status serves the tree. */
const GIT_TTL = 3_000;
/** Bytes looked at to tell text from binary. */
const SNIFF = 8000;
/** Most paths one « links in chat » call resolves. */
const LINKS_MAX = 200;

const under = (root: string, full: string): boolean => {
  const rel = relative(root, full);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};
const posix = (p: string) => p.split(sep).join('/');

type Status = { files: Map<string, GitLetter>; untracked: string[] };

export class WorkspaceFiles {
  /** Key of the file fingerprints: a hash says « same bytes or not », nothing about them. New at each start. */
  private readonly key = randomBytes(32);
  private git = new Map<string, { at: number; p: Promise<Status> }>();
  private found = new Map<string, { at: number; p: Promise<string[]> }>();

  constructor(
    private db: Db,
    private dataDir: string,
    private kanban: Kanban,
    private secrets?: { redactBytes(buf: Buffer): { buf: Buffer; hidden: number } },
  ) {}

  /** The chat's agent and its workspace in the chat's project (links resolved). */
  where(chatId: string): { agentId: string; root: string; dir: string } {
    const card = this.kanban.get(chatId);
    if (card.board !== 'direct' || !card.assignee) throw new ConflictError(`${chatId} is not a direct chat: files belong to a chat's agent`);
    const dir = workspaceOf(this.db, this.dataDir, card.assignee, card.projectId);
    return { agentId: card.assignee, root: realpathSync(dir), dir };
  }

  /**
   * `p` inside `root` (a real path), with its links resolved: `abs` is the real file, `rel` the path as asked. A missing
   * file is refused unless `missing`, then its nearest existing folder is checked instead.
   */
  resolve(root: string, p: string, missing = false): { abs: string; rel: string } {
    if (typeof p !== 'string' || p.includes('\0')) throw new InvalidError('give a path');
    if (isAbsolute(p)) throw new InvalidError(`path ${p} must be relative to the workspace`);
    const full = resolve(root, p || '.');
    if (!under(root, full)) throw new ConflictError(`path ${p} is outside the workspace`);
    const rel = posix(relative(root, full));
    if (rel.split('/').includes('.git')) throw new ConflictError(`path ${p} is inside git's own folder`);
    let real: string;
    try {
      real = realpathSync(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if (!missing) throw new NotFoundError(`no file ${p} in the workspace`);
      // The nearest entry that is there, links included: a dangling link (to a missing file or folder, in or out) is
      // « there » for lstat but not for realpath, and writing through it would follow it, so it is refused.
      let parent = full;
      while (!lexists(parent)) parent = dirname(parent);
      let realParent: string;
      try {
        realParent = realpathSync(parent);
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== 'ENOENT') throw e2;
        throw new ConflictError(`path ${p} goes through a link to nothing: it is refused`);
      }
      if (parent === full || !statSync(realParent).isDirectory()) throw new ConflictError(`path ${p} goes through a link to nothing: it is refused`);
      if (!under(root, realParent)) throw new ConflictError(`path ${p} links to a place outside the workspace`);
      return { abs: join(realParent, relative(parent, full)), rel };
    }
    if (!under(root, real)) throw new ConflictError(`path ${p} links to a place outside the workspace`);
    return { abs: real, rel };
  }

  /** One folder of the tree: folders first, then files, by name; git letters where the folder is in a repository. */
  async list(chatId: string, dir: string): Promise<WsListing> {
    const { agentId, root } = this.where(chatId);
    const { abs, rel } = this.resolve(root, dir);
    if (!statSync(abs).isDirectory()) throw new InvalidError(`${dir} is not a folder`);
    const entries: WsEntry[] = [];
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (HIDDEN.has(e.name)) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        // A link is listed only when it stays inside: opening it would be refused otherwise.
        let real: string;
        try {
          real = realpathSync(join(abs, e.name));
        } catch {
          continue; // a dangling link: nothing to open
        }
        if (!under(root, real)) continue;
        isDir = statSync(real).isDirectory();
      } else if (!isDir && !e.isFile()) continue;
      entries.push({ name: e.name, path, dir: isDir, git: null });
    }
    entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
    let gitError: string | null = null;
    try {
      await this.letters(root, abs, entries);
    } catch (e) {
      gitError = e instanceof Error ? e.message : String(e);
    }
    return { agentId, dir: rel, entries, gitError };
  }

  /** A file for the editor (text, image or binary; see WsFile). */
  read(chatId: string, path: string): WsFile {
    const { root } = this.where(chatId);
    const { abs, rel } = this.resolve(root, path);
    return this.readAt(abs, rel);
  }

  /** What the pane polls: is it there, and its modified time + size. */
  stat(chatId: string, path: string): WsStat {
    const { root } = this.where(chatId);
    let abs: string;
    let rel: string;
    try {
      ({ abs, rel } = this.resolve(root, path));
    } catch (e) {
      if (e instanceof NotFoundError) return { path, exists: false, stamp: null };
      throw e;
    }
    const st = statSync(abs);
    return { path: rel, exists: st.isFile(), stamp: st.isFile() ? stampOf(st) : null };
  }

  /**
   * Save from the editor. Written only when the file on disk is still the one the editor started from (`base`), or
   * absent when `base` is null; otherwise nothing is written and the answer says what is there (#303: the banner
   * decides, never a silent overwrite).
   */
  write(chatId: string, s: SaveWsFile): WsSaveResult {
    const { root } = this.where(chatId);
    const { abs, rel } = this.resolve(root, s.path, true);
    if (Buffer.byteLength(s.content) > FILE_EDIT_MAX) throw new InvalidError(`over the 1 MB editing limit: ${rel} is read only`);
    const there = existsSync(abs) && statSync(abs).isFile();
    if (existsSync(abs) && !there) throw new InvalidError(`${rel} is a folder`);
    if (s.base === null) {
      if (there) return { ok: false, conflict: 'exists', file: this.readAt(abs, rel) };
    } else {
      if (!there) return { ok: false, conflict: 'deleted', file: null };
      const now = this.readAt(abs, rel);
      if (now.hash !== s.base) return { ok: false, conflict: 'changed', file: now };
      if (now.readOnly) throw new ConflictError(`${rel} is read only here (${READ_ONLY_WHY[now.readOnly]})`);
    }
    mkdirSync(dirname(abs), { recursive: true });
    // A new file is created exclusively: O_EXCL never follows a link, even one made after the check above.
    writeFileSync(abs, s.content, { flag: there ? 'w' : 'wx' });
    return { ok: true, file: this.readAt(abs, rel) };
  }

  /** An image's bytes and type (pictures only: text goes through `read`, redacted). */
  image(chatId: string, path: string): { abs: string; mime: string } {
    const { root } = this.where(chatId);
    const { abs } = this.resolve(root, path);
    const mime = IMAGE_MIME[extname(abs).toLowerCase()];
    if (!mime) throw new InvalidError(`${path} is not an image`);
    return { abs, mime };
  }

  /** « Find a file » (⌘P): paths holding every word of `q` (any case), the name matching first, at most 50. */
  async find(chatId: string, q: string): Promise<{ paths: string[]; truncated: boolean }> {
    const { root } = this.where(chatId);
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { paths: [], truncated: false };
    const all = await this.index(root);
    const last = words.at(-1)!;
    const hits = all
      .filter((p) => {
        const l = p.toLowerCase();
        return words.every((w) => l.includes(w));
      })
      .map((p) => {
        const name = basename(p).toLowerCase();
        return { p, score: name.startsWith(last) ? 0 : name.includes(last) ? 1 : 2 };
      })
      .sort((a, b) => a.score - b.score || a.p.length - b.p.length || a.p.localeCompare(b.p));
    return { paths: hits.slice(0, FIND_MAX).map((h) => h.p), truncated: all.length >= FIND_CAP };
  }

  /**
   * File paths written in the chat (#303): each one that names a file of the workspace → its path there, else null.
   * Tried as given, then inside each repository right in the workspace (an agent writes `src/x.ts` of its clone); when
   * several match, the one written last. An absolute path counts only inside the workspace.
   */
  links(chatId: string, paths: string[]): Record<string, string | null> {
    const { root, dir } = this.where(chatId);
    const repos = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(root, e.name, '.git')))
      .map((e) => e.name);
    const out: Record<string, string | null> = {};
    for (const asked of paths.slice(0, LINKS_MAX)) {
      let p = asked.replace(/^\.\//, '');
      if (isAbsolute(p)) {
        const base = [dir, root].find((r) => under(r, p));
        if (!base) {
          out[asked] = null;
          continue;
        }
        p = posix(relative(base, p));
      }
      let best: { rel: string; at: number } | null = null;
      for (const c of [p, ...repos.map((r) => `${r}/${p}`)]) {
        try {
          const { abs, rel } = this.resolve(root, c);
          const st = statSync(abs);
          if (st.isFile() && (!best || st.mtimeMs > best.at)) best = { rel, at: st.mtimeMs };
        } catch {
          // not there (or out of bounds): not a link
        }
      }
      out[asked] = best?.rel ?? null;
    }
    return out;
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private hash(buf: Buffer): string {
    return createHmac('sha256', this.key).update(buf).digest('hex').slice(0, 32);
  }

  private readAt(abs: string, rel: string): WsFile {
    const st = statSync(abs);
    if (!st.isFile()) throw new InvalidError(`${rel} is a folder`);
    const base = { path: rel, size: st.size, stamp: stampOf(st) };
    const bytes = readFileSync(abs);
    const hash = this.hash(bytes);
    if (IMAGE_MIME[extname(abs).toLowerCase()]) return { ...base, kind: 'image', hash, content: null, readOnly: 'image' };
    if (bytes.subarray(0, SNIFF).includes(0)) return { ...base, kind: 'binary', hash, content: null, readOnly: 'binary' };
    const large = st.size > FILE_EDIT_MAX;
    const shown = large ? firstLines(bytes, FILE_LARGE_LINES) : bytes;
    const red = this.secrets ? this.secrets.redactBytes(shown) : { buf: shown, hidden: 0 };
    return { ...base, kind: 'text', hash, content: red.buf.toString('utf8'), readOnly: large ? 'large' : red.hidden ? 'secret' : null };
  }

  /** Sets the A / M letters of `entries` (rows of folder `abs`). */
  private async letters(root: string, abs: string, entries: WsEntry[]): Promise<void> {
    const repo = repoOf(root, abs);
    if (repo) {
      const st = await this.status(repo);
      for (const e of entries) e.git = letterOf(st, posix(relative(repo, join(abs, e.name))), e.dir);
    }
    // A repository right in this folder (an agent's clones in its workspace): its folder sums up its changes.
    const nested = entries.filter((e) => e.dir && existsSync(join(abs, e.name, '.git')));
    await limit(nested, 8, async (e) => {
      const st = await this.status(join(abs, e.name));
      e.git = st.untracked.length || [...st.files.values()].includes('A') ? 'A' : null;
      if ([...st.files.values()].includes('M')) e.git = 'M';
    });
  }

  private status(repo: string): Promise<Status> {
    const hit = this.git.get(repo);
    if (hit && Date.now() - hit.at < GIT_TTL) return hit.p;
    const p = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules']).then(parseStatus);
    this.git.set(repo, { at: Date.now(), p });
    p.catch(() => this.git.delete(repo));
    return p;
  }

  /** Every file of the workspace for « Find a file »: git's list in a repository (ignored files left out), else a walk. */
  private index(root: string): Promise<string[]> {
    const hit = this.found.get(root);
    if (hit && Date.now() - hit.at < FIND_TTL) return hit.p;
    const p = (async () => {
      const out: string[] = [];
      const walk = async (abs: string, rel: string): Promise<void> => {
        if (out.length >= FIND_CAP) return;
        if (existsSync(join(abs, '.git'))) {
          const listed = (await git(abs, ['ls-files', '-co', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
          for (const f of listed) if (out.length < FIND_CAP) out.push(rel ? `${rel}/${f}` : f);
          return;
        }
        let entries;
        try {
          entries = readdirSync(abs, { withFileTypes: true });
        } catch {
          return; // unreadable folder: left out of the search
        }
        for (const e of entries) {
          if (SKIP_FIND.has(e.name) || HIDDEN.has(e.name)) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(join(abs, e.name), r);
          else if (e.isFile() && out.length < FIND_CAP) out.push(r);
        }
      };
      await walk(root, '');
      return out;
    })();
    this.found.set(root, { at: Date.now(), p });
    p.catch(() => this.found.delete(root));
    return p;
  }
}

const READ_ONLY_WHY = { large: 'over 1 MB', binary: 'binary', secret: 'it holds a secret value', image: 'an image' } as const;

const stampOf = (st: { mtimeMs: number; size: number }) => `${Math.round(st.mtimeMs)}:${st.size}`;

/** The first `n` lines of `buf`. */
function firstLines(buf: Buffer, n: number): Buffer {
  let at = -1;
  for (let i = 0; i < n; i++) {
    at = buf.indexOf(10, at + 1);
    if (at < 0) return buf;
  }
  return buf.subarray(0, at + 1);
}

/** The repository holding `abs`, up to `root` (a `.git` folder or worktree file). */
function repoOf(root: string, abs: string): string | null {
  for (let d = abs; under(root, d); d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (d === root) break;
  }
  return null;
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((ok, fail) => {
    // GIT_OPTIONAL_LOCKS=0: reading the status never takes the index lock an agent's git command may need.
    execFile('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new Error(`git ${args[0]} in ${basename(cwd)}: ${(stderr || err.message).trim().split('\n')[0]}`));
      else ok(stdout);
    });
  });
}

/** `git status --porcelain=v1 -z`: ?? and A → A, anything else (M, R, C, D, T, U) → M. */
export function parseStatus(out: string): Status {
  const files = new Map<string, GitLetter>();
  const untracked: string[] = [];
  const recs = out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!;
    if (r.length < 4) continue;
    const xy = r.slice(0, 2);
    const p = r.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // the old path follows
    if (xy === '??') {
      if (p.endsWith('/')) untracked.push(p.slice(0, -1));
      else files.set(p, 'A');
    } else if (xy !== '!!') files.set(p, xy[0] === 'A' ? 'A' : 'M');
  }
  return { files, untracked };
}

/** The letter of `rel` (relative to its repository): a file's own, a folder's content's (M wins over A). */
export function letterOf(st: Status, rel: string, dir: boolean): GitLetter | null {
  if (st.untracked.some((u) => rel === u || rel.startsWith(u + '/'))) return 'A';
  if (!dir) return st.files.get(rel) ?? null;
  const pre = rel + '/';
  let letter: GitLetter | null = st.untracked.some((u) => u.startsWith(pre)) ? 'A' : null;
  for (const [p, l] of st.files) {
    if (!p.startsWith(pre)) continue;
    if (l === 'M') return 'M';
    letter = 'A';
  }
  return letter;
}

async function limit<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}
