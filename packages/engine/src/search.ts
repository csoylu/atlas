import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { delimiter, join, relative } from 'node:path';

/** Folders never searched or listed. */
export const SKIP_DIRS = new Set(['node_modules', '.git']);
/** Entries visited at most by one walk: a huge tree gives a partial answer with a note, not a hang. */
const WALK_LIMIT = 100_000;
const LINE_CAP = 500;

/**
 * A glob as a RegExp on '/'-separated relative paths: `**` any folders, `*` and `?` within a name, `{a,b}`, `[…]`.
 * A pattern without '/' matches the file name at any depth (as in ripgrep and .gitignore).
 */
export function globToRegex(glob: string): RegExp {
  let src = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        src += '(?:.*/)?';
        i += 2;
      } else {
        src += '.*';
        i += 1;
      }
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else if (c === '{') {
      src += '(?:';
      braces++;
    } else if (c === '}' && braces) {
      src += ')';
      braces--;
    } else if (c === ',' && braces) src += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) src += '\\[';
      else {
        src += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else src += c.replace(/[.+^$()|\\/]/g, '\\$&');
  }
  return new RegExp(glob.includes('/') ? `^${src}$` : `(?:^|/)${src}$`);
}

/** Every file under root (sorted, SKIP_DIRS skipped), as paths relative to root. */
export async function walkFiles(root: string): Promise<{ files: string[]; partial: boolean }> {
  const files: string[] = [];
  let seen = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > WALK_LIMIT) return;
      if (SKIP_DIRS.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) files.push(relative(root, p));
    }
  };
  await walk(root);
  return { files, partial: seen > WALK_LIMIT };
}

/** ripgrep's path, if installed (PATH first, then the usual Homebrew/MacPorts places a GUI app's PATH lacks). */
let rgCache: string | null | undefined;
export function findRg(): string | null {
  if (rgCache !== undefined) return rgCache;
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
  for (const d of dirs) {
    if (!d) continue;
    const p = join(d, process.platform === 'win32' ? 'rg.exe' : 'rg');
    try {
      accessSync(p, constants.X_OK);
      return (rgCache = p);
    } catch {
      // not here
    }
  }
  return (rgCache = null);
}

export interface GrepOptions {
  pattern: string;
  /** Absolute file or folder to search. */
  root: string;
  /** Paths in the output are relative to this. */
  base: string;
  glob?: string;
  mode: 'content' | 'files' | 'count';
  limit: number;
  context?: number;
  ignoreCase?: boolean;
  signal?: AbortSignal;
}

/** Search with ripgrep when `rg` is given, else in JS. Output lines: `path:line:text` (context `path-line-text`), paths, or `path:count`. */
export async function grep(o: GrepOptions, rg: string | null = findRg()): Promise<string> {
  const lines = rg ? await grepRg(o, rg) : await grepJs(o);
  if (!lines.length) return 'no matches';
  const shown = lines.slice(0, o.limit).map((l) => (l.length > LINE_CAP ? `${l.slice(0, LINE_CAP)}… (+${l.length - LINE_CAP} chars)` : l));
  const more = lines.length - shown.length;
  return shown.join('\n') + (more > 0 ? `\n[${more}${lines.length >= HARD_CAP ? '+' : ''} more not shown; narrow the search or raise limit]` : '');
}

/** Lines collected at most from a backend (way past any useful limit). */
const HARD_CAP = 5000;

async function grepRg(o: GrepOptions, rg: string): Promise<string[]> {
  const args = ['--no-heading', '--color', 'never', '--no-ignore', '--hidden', '--glob', '!node_modules', '--glob', '!.git', '--no-messages'];
  if (o.mode === 'files') args.push('--files-with-matches');
  else if (o.mode === 'count') args.push('--count', '--with-filename');
  else {
    args.push('--line-number', '--with-filename');
    if (o.context) args.push('--context', String(o.context));
  }
  if (o.ignoreCase) args.push('--ignore-case');
  if (o.glob) args.push('--glob', o.glob);
  args.push('--regexp', o.pattern, '--', relative(o.base, o.root) || '.');
  return new Promise((resolve, reject) => {
    const child = spawn(rg, args, { cwd: o.base, signal: o.signal });
    const out: string[] = [];
    let buf = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const parts = buf.split('\n');
      buf = parts.pop()!;
      out.push(...parts);
      if (out.length >= HARD_CAP) child.kill();
    });
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf) out.push(buf);
      if (code === 2 && !out.length) return reject(new Error(`grep failed: ${err.trim() || 'ripgrep exited 2'}`));
      resolve(out.slice(0, HARD_CAP).map((l) => l.replace(/^\.\//, '')));
    });
  });
}

/** JS flags for ripgrep's leading inline-flag group (`(?i)`, `(?is)`…), which JS RegExp rejects. Only a leading group is handled. */
const INLINE_FLAGS: Record<string, string> = { i: 'i', s: 's', m: 'm' };
export function jsRegex(pattern: string, ignoreCase = false): RegExp {
  const flags = new Set(ignoreCase ? ['i'] : []);
  const lead = /^\(\?([a-zA-Z]+)\)/.exec(pattern);
  if (lead) {
    for (const f of lead[1]!) {
      if (!INLINE_FLAGS[f])
        throw new Error(`unsupported inline flag (?${f}) in the JS grep fallback (ripgrep not found): only (?i), (?s), (?m) are supported; use ignore_case instead of (?i)`);
      flags.add(INLINE_FLAGS[f]);
    }
    pattern = pattern.slice(lead[0].length);
  }
  try {
    return new RegExp(pattern, [...flags].join(''));
  } catch (e) {
    throw new Error(`invalid regex for the JS grep fallback (ripgrep not found): ${e instanceof Error ? e.message : e}`);
  }
}

async function grepJs(o: GrepOptions): Promise<string[]> {
  const re = jsRegex(o.pattern, o.ignoreCase);
  const st = await stat(o.root);
  const files = st.isDirectory() ? (await walkFiles(o.root)).files.map((f) => join(o.root, f)) : [o.root];
  const filter = o.glob ? globToRegex(o.glob) : null;
  const out: string[] = [];
  for (const full of files) {
    o.signal?.throwIfAborted();
    const rel = relative(o.base, full);
    if (filter && !filter.test(relative(st.isDirectory() ? o.root : o.base, full))) continue;
    const text = await readText(full);
    if (text == null) continue;
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i]!)) hits.push(i);
    const isHit = new Set(hits);
    if (!hits.length) continue;
    if (o.mode === 'files') out.push(rel);
    else if (o.mode === 'count') out.push(`${rel}:${hits.length}`);
    else {
      const ctx = o.context ?? 0;
      let last = -1;
      for (const h of hits) {
        const from = Math.max(h - ctx, last + 1);
        if (ctx && last >= 0 && from > last + 1) out.push('--');
        for (let i = from; i <= Math.min(h + ctx, lines.length - 1); i++) {
          if (i <= last) continue;
          const sep = isHit.has(i) ? ':' : '-';
          out.push(`${rel}${sep}${i + 1}${sep}${lines[i]}`);
          last = i;
        }
      }
    }
    if (out.length >= HARD_CAP) break;
  }
  return out;
}

/** A file's text, or null if it looks binary (a NUL byte in its first 8 KB) or is over 10 MB. */
export async function readText(full: string): Promise<string | null> {
  const fh = await open(full, 'r');
  try {
    const { size } = await fh.stat();
    if (size > 10_000_000) return null;
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, 0);
    return isBinary(buf) ? null : buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

export const isBinary = (buf: Buffer): boolean => buf.subarray(0, 8192).includes(0);

/** Files matching a glob under root, newest first. */
export async function globFiles(pattern: string, root: string, base: string, limit: number): Promise<string> {
  const re = globToRegex(pattern);
  const { files, partial } = await walkFiles(root);
  const hits = await Promise.all(
    files.filter((f) => re.test(f)).map(async (f) => ({ path: relative(base, join(root, f)), mtime: (await stat(join(root, f))).mtimeMs })),
  );
  hits.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  if (!hits.length) return 'no files match' + (partial ? ' (the tree is too big: searched the first 100000 entries)' : '');
  const more = hits.length - limit;
  return (
    hits
      .slice(0, limit)
      .map((h) => h.path)
      .join('\n') +
    (more > 0 ? `\n[${more} more not shown]` : '') +
    (partial ? '\n[tree too big: searched the first 100000 entries]' : '')
  );
}
