import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ImageBlock, ToolCallDetail } from '@atlas/shared';
import { describeImage, extOf, imageLine, looksLikeImage, sniff } from './images.ts';
import type { ToolSpec } from './providers/types.ts';
import type { Background } from './background.ts';
import type { Secrets } from './secrets.ts';
import { findSpans, replaceSpans, type Span } from './fuzzy.ts';
import { globFiles, grep, isBinary, shownPath, SKIP_DIRS } from './search.ts';
import { fetchPage, headTail } from './web.ts';
import { FULL_PAGE_MAX, PHONE_BELOW, TIMEOUT_MS, takeScreenshot, type EngineAccess } from './screenshot.ts';

export interface ToolContext {
  workdir: string;
  signal: AbortSignal;
  /** Called with the pid of a spawned process, so a crash can be cleaned up on restart. */
  onSpawn?: (pid: number) => void;
  /** The conversation: edits need a read_file of the file in it first (read tracking). */
  conversationId: string;
  /** Full outputs too long for a tool result (shell, web_fetch, background logs). read_file and grep can read it. */
  outputsDir: string;
  /** Background processes of this conversation's card; omitted = background: true is refused. */
  background?: { registry: Background; agentId: string; cardId: string };
  fetch?: typeof fetch;
  /** What a file tool did, for the chat (stored in tool_calls.detail, never sent to the model). */
  onDetail?: (d: ToolCallDetail) => void;
  /** Output of a running foreground shell command, as it comes (the chat's live tail). */
  onOutput?: (chunk: string) => void;
  /** The engine this agent runs in, for screenshot (#133); omitted = screenshot is refused. */
  engine?: EngineAccess;
  /**
   * Environment of a shell command (#136: login PATH, agent as git author; #206: the agent's granted secrets, read at
   * each command); omitted = the engine's own. Throws when a secret can't be given: the command does not run.
   */
  env?: (command: string) => Promise<NodeJS.ProcessEnv>;
  /**
   * Hides secret values (#206). The runner redacts every tool result, but a tool that cuts its output (long shell output,
   * a page of a background log, a long line) redacts first and cuts second (#227), or half a value at the cut would stay.
   */
  redact?: Redactor;
}

interface Tool<S extends z.ZodType> {
  description: string;
  input: S;
  /** Text, or text + pictures (read_file / web_fetch of an image). */
  run(input: z.infer<S>, ctx: ToolContext): Promise<string | ToolOutput>;
}
export interface ToolOutput {
  output: string;
  images?: ImageBlock[];
}
const tool = <S extends z.ZodType>(t: Tool<S>) => t;

/** What a tool needs to hide secret values in output it cuts (#227). */
export type Redactor = Pick<Secrets, 'redact' | 'redactWindow'>;
/** `text` with secret values hidden (as is without a redactor). */
const hide = (ctx: Pick<ToolContext, 'redact'>, text: string): string => (ctx.redact ? ctx.redact.redact(text).text : text);

const OUTPUT_CAP = 30_000;
/** A rewritten file's previous text is kept for the chat's diff up to this size. */
const BEFORE_CAP = 100_000;
/** read_file: lines per call by default, characters per call at most, characters per line at most. */
const READ_LINES = 2000;
const READ_CHARS = 100_000;
const LINE_CHARS = 5000;

/** Resolve a path inside the workdir; anything outside is refused (design §10). */
export function inside(workdir: string, p: string): string {
  const full = resolve(workdir, p);
  const rel = relative(workdir, full);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`path ${p} is outside the workdir ${workdir}`);
  return full;
}

/** The rule, in the refusal of any path a file tool may not open. */
export const PATH_RULE = 'read: workdir and temp folders; write: workdir only';

const under = (root: string, full: string): boolean => {
  const rel = relative(root, full);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};

/** The OS temp folders (/tmp, /private/tmp, os.tmpdir()), as given and with their links resolved. */
export function tempRoots(): string[] {
  const roots = new Set<string>();
  for (const r of ['/tmp', '/private/tmp', tmpdir()]) {
    if (!r || resolve(r) === resolve('/')) continue;
    roots.add(resolve(r));
    try {
      roots.add(realpathSync(r));
    } catch {
      // not there on this OS
    }
  }
  return [...roots];
}

/** For writing: the workdir only. */
function writable(ctx: ToolContext, p: string): string {
  try {
    return inside(ctx.workdir, p);
  } catch {
    throw new Error(`path ${p} is outside your workdir ${ctx.workdir} (${PATH_RULE})`);
  }
}

/**
 * For reading: the workdir, the outputs folder (absolute paths given in tool results), or a temp folder (read-only).
 * A temp path is checked with its links resolved: a link in /tmp to a file elsewhere is refused.
 */
export function readable(ctx: Pick<ToolContext, 'workdir' | 'outputsDir'>, p: string): string {
  const full = resolve(ctx.workdir, p);
  if (under(ctx.workdir, full)) return full;
  if (isAbsolute(p) && under(ctx.outputsDir, full) && full !== resolve(ctx.outputsDir)) return full;
  const roots = tempRoots();
  if (roots.some((r) => under(r, full))) {
    let real: string;
    try {
      real = realpathSync(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`no such file or folder: ${p}`);
      throw e;
    }
    if (roots.some((r) => under(r, real))) return real;
    throw new Error(`path ${p} links to ${real}, outside the folders you can open (${PATH_RULE})`);
  }
  throw new Error(`path ${p} is outside the folders you can open (${PATH_RULE})`);
}

/** Save a full output to the outputs folder (text: already redacted by the caller); returns its path. */
async function saveOutput(ctx: ToolContext, kind: string, text: string | Buffer, ext = 'txt'): Promise<string> {
  await mkdir(ctx.outputsDir, { recursive: true });
  const path = join(ctx.outputsDir, `${kind}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}.${ext}`);
  await writeFile(path, text);
  return path;
}

// ── Read tracking ──────────────────────────────────────────────────────────────────────────────────────────────────
// Per conversation, the stat (mtime + size) of each file when the agent last read or wrote it. write_file and
// edit_file refuse when the file changed since (another agent, the user, a shell command); write_file over an existing
// file also refuses when it was never read here. In memory only: after a restart the agent reads again if it overwrites.
const reads = new Map<string, Map<string, string>>();
const READS_KEPT = 200;

async function stampOf(full: string): Promise<string | null> {
  try {
    const s = await stat(full);
    return `${s.mtimeMs}:${s.size}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function remember(ctx: ToolContext, full: string): Promise<void> {
  const stamp = await stampOf(full);
  if (!stamp) return;
  let m = reads.get(ctx.conversationId);
  if (m) reads.delete(ctx.conversationId); // re-insert: most recently used last
  else m = new Map();
  m.set(full, stamp);
  reads.set(ctx.conversationId, m);
  if (reads.size > READS_KEPT) reads.delete(reads.keys().next().value!);
}

/**
 * Throws if this conversation read or wrote the file and it changed on disk since. A file never seen here passes
 * only with allowUnread (edit_file: its exact old_text match proves the agent knows the text it replaces); write_file
 * would overwrite it blind, so it must be read first.
 */
async function checkFresh(ctx: ToolContext, full: string, path: string, allowUnread = false): Promise<void> {
  const now = await stampOf(full);
  if (now == null) return;
  const known = reads.get(ctx.conversationId)?.get(full);
  if (!known && allowUnread) return;
  if (!known) throw new Error(`${path} exists and has not been read in this conversation: read_file it first, then overwrite it`);
  if (known !== now) throw new Error(`${path} changed on disk since you last read or wrote it: read_file it first, then edit it`);
}

/**
 * One change at a time per file: tool calls of one turn run in parallel, and two edits of the same file would
 * otherwise read and write over each other (writeFile truncates first: the other read can see half a file).
 */
const locks = new Map<string, Promise<unknown>>();
function serial<T>(full: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(full) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  locks.set(full, tail);
  void tail.then(() => locks.get(full) === tail && locks.delete(full));
  return next;
}

/** A page of a text file with line numbers (`N|text`), cut on a line boundary, with a footer when there is more. */
export function numberedPage(text: string, offset: number, limit: number, budget = READ_CHARS, redact: (line: string) => string = (l) => l): string {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const total = lines.length;
  if (!total) return '(empty file)';
  if (offset > total) throw new Error(`offset ${offset} is past the end of the file (${total} lines)`);
  const last = Math.min(total, offset + limit - 1);
  const width = String(last).length;
  const out: string[] = [];
  let used = 0;
  let b = offset - 1;
  for (let i = offset - 1; i < last; i++) {
    let line = lines[i]!;
    if (line.length > LINE_CHARS) line = redact(line); // before the cut (#227); whole lines are redacted by the runner
    if (line.length > LINE_CHARS) line = `${line.slice(0, LINE_CHARS)}… [line cut: ${line.length - LINE_CHARS} more chars]`;
    const row = `${String(i + 1).padStart(width)}|${line}`;
    if (out.length && used + row.length + 1 > budget) break;
    out.push(row);
    used += row.length + 1;
    b = i + 1;
  }
  const footer = b < total ? `\n[showing lines ${offset}–${b} of ${total}; use offset=${b + 1} to continue]` : '';
  return out.join('\n') + footer;
}

export const TOOLS = {
  read_file: tool({
    description:
      'Read a UTF-8 text file, with line numbers (`N|text`; the `N|` prefix is not part of the file). Paths are relative ' +
      'to your working directory; absolute paths work there, in the temp folders (/tmp, $TMPDIR) and for a saved output ' +
      `Atlas gave you (${PATH_RULE}). Reads ${READ_LINES} lines from ` +
      '`offset` (1-based) by default; a footer says how to continue. Read a file before editing or overwriting it. ' +
      'A png, jpeg, gif or webp file (up to 10 MB) comes back as the picture itself, so you can look at it (e.g. a ' +
      'screenshot in /tmp: no need to copy it into your workdir).',
    input: z.object({
      path: z.string(),
      offset: z.number().int().min(1).default(1).describe('first line to read (1-based)'),
      limit: z.number().int().min(1).default(READ_LINES).describe('lines to read at most'),
    }),
    run: async ({ path, offset, limit }, ctx) => {
      const full = readable(ctx, path);
      const st = await stat(full);
      if (st.isDirectory()) throw new Error(`${path} is a directory: use list_files or glob`);
      const buf = await serial(full, async () => {
        const b = await readFile(full);
        await remember(ctx, full);
        return b;
      });
      if (sniff(buf) || looksLikeImage(full)) {
        const image = await describeImage(full, buf);
        return { output: imageLine(image), images: [image] };
      }
      if (isBinary(buf)) throw new Error(`${path} is a binary file (${buf.length} bytes); read_file reads text and png/jpeg/gif/webp images only`);
      return numberedPage(buf.toString('utf8'), offset, limit, READ_CHARS, (l) => hide(ctx, l));
    },
  }),
  write_file: tool({
    description:
      'Create or overwrite a text file in your working directory (parent folders are created; ' + PATH_RULE + '). Overwriting an existing file needs a read_file of it ' +
      'in this conversation first. Prefer edit_file for changes to an existing file.',
    input: z.object({ path: z.string(), content: z.string() }),
    run: ({ path, content }, ctx) => {
      const full = writable(ctx, path);
      return serial(full, async () => {
        await checkFresh(ctx, full, path);
        const created = (await stampOf(full)) == null;
        const before = created ? null : await readFile(full);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
        await remember(ctx, full);
        ctx.onDetail?.({ kind: 'write', created, before: before && before.length <= BEFORE_CAP && !isBinary(before) ? before.toString('utf8') : null });
        return `wrote ${content.length} chars to ${path}`;
      });
    },
  }),
  edit_file: tool({
    description:
      'Replace old_text with new_text in a file of your working directory (' + PATH_RULE + '). old_text must be found exactly once (add surrounding lines to make it ' +
      'unique), or set replace_all to replace every occurrence. Refused if the file changed on disk since you last read ' +
      'or wrote it in this conversation. ' +
      'If old_text is not found exactly, a match ignoring indentation or runs of spaces is tried and reported.',
    input: z.object({
      path: z.string(),
      old_text: z.string().min(1),
      new_text: z.string(),
      replace_all: z.boolean().default(false),
    }),
    run: ({ path, old_text, new_text, replace_all }, ctx) => {
      const full = writable(ctx, path);
      return serial(full, () => editFile(ctx, full, path, old_text, new_text, replace_all));
    },
  }),
  list_files: tool({
    description: `List files and folders (recursive up to depth 3, skips node_modules and .git). Your working directory or a temp folder such as /tmp (${PATH_RULE}).`,
    input: z.object({ path: z.string().default('.') }),
    run: async ({ path }, ctx) => {
      const { workdir } = ctx;
      const root = readable(ctx, path);
      const out: string[] = [];
      const walk = async (dir: string, depth: number) => {
        for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (SKIP_DIRS.has(e.name)) continue;
          const p = join(dir, e.name);
          out.push(shownPath(workdir, p) + (e.isDirectory() ? '/' : ''));
          if (out.length > 1000) return;
          if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
        }
      };
      if (!(await stat(root)).isDirectory()) throw new Error(`${path} is not a directory`);
      await walk(root, 1);
      return out.length ? out.join('\n') : '(empty)';
    },
  }),
  grep: tool({
    description:
      'Search file contents with a regular expression (ripgrep syntax; use ignore_case instead of (?i)). Use this instead of grep/rg/find in shell. ' +
      'mode: content (matching lines as path:line:text), files (paths only) or count (path:matches). Skips node_modules and .git. ' +
      `Searches your working directory, a temp folder such as /tmp, or a saved output (${PATH_RULE}).`,
    input: z.object({
      pattern: z.string().min(1),
      path: z.string().default('.').describe('file or folder to search'),
      glob: z.string().optional().describe('only files matching this glob, e.g. *.ts or src/**/*.{ts,tsx}'),
      mode: z.enum(['content', 'files', 'count']).default('content'),
      limit: z.number().int().min(1).max(2000).default(100).describe('output lines at most'),
      context: z.number().int().min(0).max(20).optional().describe('lines of context around each match (content mode)'),
      ignore_case: z.boolean().default(false),
    }),
    run: async ({ pattern, path, glob, mode, limit, context, ignore_case }, ctx) => {
      const root = readable(ctx, path);
      await stat(root); // a clear ENOENT before searching
      return grep({ pattern, root, base: ctx.workdir, glob, mode, limit, context, ignoreCase: ignore_case, signal: ctx.signal, redact: (l) => hide(ctx, l) });
    },
  }),
  glob: tool({
    description:
      'Find files by name pattern, newest first: `**/*.ts`, `src/**/test*.{ts,tsx}`; a pattern without / matches the name ' +
      'at any depth. Use this instead of find/ls in shell. Skips node_modules and .git. ' +
      `path: your working directory or a temp folder such as /tmp (${PATH_RULE}).`,
    input: z.object({
      pattern: z.string().min(1),
      path: z.string().default('.').describe('folder to search from'),
      limit: z.number().int().min(1).max(1000).default(100),
    }),
    run: async ({ pattern, path, limit }, ctx) => {
      const root = readable(ctx, path);
      if (!(await stat(root)).isDirectory()) throw new Error(`${path} is not a directory`);
      return globFiles(pattern, root, ctx.workdir, limit);
    },
  }),
  shell: tool({
    description:
      'Run a shell command in your working directory. Returns the exit code and output (the last 30000 chars; the full ' +
      'output is saved to a file when longer). background: true starts it and returns at once with an id (servers, ' +
      'watchers, long builds): read its output with shell_output, stop it with shell_kill; you get a message when it ends.',
    input: z.object({
      command: z.string().min(1),
      timeout_s: z.number().int().positive().max(1800).default(120).describe('foreground only'),
      background: z.boolean().default(false),
    }),
    run: async ({ command, timeout_s, background }, ctx) => {
      if (background) {
        if (!ctx.background) throw new Error('background processes are not available here');
        const { registry, agentId, cardId } = ctx.background;
        const env = ctx.env ? await ctx.env(command) : process.env;
        const p = registry.start({ command, cwd: ctx.workdir, logDir: ctx.outputsDir, agentId, cardId, env });
        return `started ${p.id} in the background (pid ${p.pid}); its output goes to ${p.logPath}. shell_output("${p.id}") reads new output, shell_kill("${p.id}") stops it; a message comes here when it ends.`;
      }
      const env = ctx.env ? await ctx.env(command) : process.env;
      const run = await runForeground(command, timeout_s, env, ctx);
      const { code, sig } = run;
      const head = `exit ${code ?? sig}${sig === 'SIGKILL' ? ` (killed after ${timeout_s}s)` : ''}\n`;
      const out = hide(ctx, run.out); // the whole output, before it is cut (#227)
      if (out.length <= OUTPUT_CAP) return head + out;
      const path = await saveOutput(ctx, 'shell', out);
      return `${head}[output is ${out.length} chars: showing the last ${OUTPUT_CAP}; the full output is in ${path} (read_file with offset, or grep it)]\n${out.slice(out.length - OUTPUT_CAP)}`;
    },
  }),
  shell_output: tool({
    description: 'Status and new output of a background process started with shell (background: true). offset (bytes) re-reads from there.',
    input: z.object({ id: z.string(), offset: z.number().int().min(0).optional() }),
    run: async ({ id, offset }, ctx) => {
      if (!ctx.background) throw new Error('background processes are not available here');
      return ctx.background.registry.read(id, ctx.background.agentId, offset, ctx.redact);
    },
  }),
  shell_kill: tool({
    description: 'Stop a background process (its whole process tree).',
    input: z.object({ id: z.string() }),
    run: async ({ id }, ctx) => {
      if (!ctx.background) throw new Error('background processes are not available here');
      return ctx.background.registry.kill(id, ctx.background.agentId);
    },
  }),
  web_fetch: tool({
    description:
      'Fetch a web page or text URL as readable text (HTML converted to markdown). Long pages show the start and the end; ' +
      'the full text is saved to a file you can read_file or grep. A png, jpeg, gif or webp URL comes back as the picture ' +
      '(saved to a file too).',
    input: z.object({
      url: z.string().min(1),
      max_chars: z.number().int().min(1000).max(100_000).default(15_000),
    }),
    run: async ({ url, max_chars }, ctx) => {
      const page = await fetchPage(url, ctx.signal, ctx.fetch);
      if (page.image) {
        const type = sniff(page.image);
        if (!type) throw new Error(`${page.url} says it is an image (${page.contentType}) but is not a png, jpeg, gif or webp`);
        const path = await saveOutput(ctx, 'image', page.image, extOf(type));
        const image = await describeImage(path, page.image);
        return { output: `URL: ${page.url}\n${imageLine(image)}`, images: [image] };
      }
      const head = `URL: ${page.url}${page.title ? `\nTitle: ${page.title}` : ''}\n\n`;
      const text = hide(ctx, page.text); // before headTail cuts it (#227)
      if (text.length <= max_chars) return head + text;
      const path = await saveOutput(ctx, 'web', head + text, 'md');
      return head + headTail(text, max_chars, `full text (${text.length} chars) in ${path}: read_file it with offset, or grep it`);
    },
  }),
  screenshot: tool({
    description:
      'Take a screenshot of the running Atlas UI or of a page in a workspace, and get it back as a picture (also saved to ' +
      'screenshots/ in your workspace). target: an app route (`#/chat/paris`, `#/board`, `/` = home), a file in your ' +
      'workspace (`pages/x.html`), or another agent\'s `/api/files/<agent>/pages/x.html`; other sites are refused (use ' +
      'web_fetch). Read-only: the page sees your live data, but every write it tries (POST, PUT, DELETE…) is refused and ' +
      `listed. Waits for the page to load, fonts and a quiet network (then wait_for), ${TIMEOUT_MS / 1000} s at most, else it ` +
      `fails and says what was missing. Under ${PHONE_BELOW} px wide: phone mode (mobile, touch). actions run before the ` +
      'shot: {click: selector}, {type: selector, text}, {press: "Escape" | "Meta+k"}. Page errors and console.error lines ' +
      'come back with the picture. Needs Google Chrome.',
    input: z.object({
      target: z.string().min(1).describe('#/route, a workspace file path, or /api/files/<agent>/<path>'),
      width: z.number().int().min(320).max(2560).default(1440),
      height: z.number().int().min(320).max(2000).default(900),
      theme: z.enum(['dark', 'light']).optional().describe("omitted: the page's own choice"),
      full_page: z.boolean().default(false).describe(`the whole page height (up to ${FULL_PAGE_MAX} px), not just the viewport`),
      clip: z.string().optional().describe('CSS selector: shoot only this element'),
      wait_for: z.string().optional().describe('CSS selector that must be visible before the shot (after actions)'),
      actions: z
        .array(z.union([z.object({ click: z.string() }), z.object({ type: z.string(), text: z.string() }), z.object({ press: z.string() })]))
        .max(20)
        .optional()
        .describe('steps before the shot, in order'),
    }),
    run: async (o, ctx) => {
      if (!ctx.engine) throw new Error('screenshot is not available here (no engine address)');
      const shot = await takeScreenshot(o, { engine: ctx.engine, workdir: ctx.workdir, signal: ctx.signal, onSpawn: ctx.onSpawn });
      const image = await describeImage(inside(ctx.workdir, shot.file), shot.bytes);
      const lines = [
        `Screenshot of ${shot.url} (${ctx.engine.url}, this Atlas engine: live data, writes refused)`,
        `Viewport: ${shot.viewport}, ${shot.mode === 'phone' ? 'phone mode (mobile, touch)' : 'desktop mode'}, scale 2, theme ${o.theme ?? 'page default'}`,
        `Saved: ${shot.file}`,
        imageLine(image),
        shot.errors.length ? `Page errors (${shot.errors.length}):\n  ${shot.errors.join('\n  ')}` : 'Page errors: none',
        ...(shot.refused.length ? [`Writes refused (read-only):\n  ${shot.refused.join('\n  ')}`] : []),
      ];
      return { output: lines.join('\n'), images: [image] };
    },
  }),
} satisfies Record<string, Tool<z.ZodType>>;

async function editFile(ctx: ToolContext, full: string, path: string, old_text: string, new_text: string, replace_all: boolean): Promise<string> {
  if (old_text === new_text) throw new Error('old_text and new_text are identical: nothing to change');
  if ((await stampOf(full)) == null) throw new Error(`${path} does not exist (write_file creates files)`);
  await checkFresh(ctx, full, path, true);
  const text = await readFile(full, 'utf8');
  const { strategy, spans } = findSpans(text, old_text);
  if (!spans.length)
    throw new Error(`old_text not found in ${path} (also tried ignoring indentation and runs of spaces); read_file it to see the current text`);
  if (spans.length > 1 && !replace_all)
    throw new Error(`old_text found ${spans.length} times in ${path}; add surrounding lines to make it unique, or set replace_all`);
  await writeFile(full, replaceSpans(text, spans, new_text));
  await remember(ctx, full);
  ctx.onDetail?.({ kind: 'edit', lines: landedLines(text, spans, new_text) });
  const n = spans.length > 1 ? ` (${spans.length} replacements)` : '';
  return strategy === 'exact'
    ? `edited ${path}${n}`
    : `edited ${path}${n}. old_text did not match exactly: it matched with ${strategy} matching; read the changed lines to check the result`;
}

/** The 1-based line, in the edited text, where each replacement starts (earlier replacements shift the later ones). */
export function landedLines(text: string, spans: Span[], replacement: string): number[] {
  const newlines = (t: string) => t.split('\n').length - 1;
  const added = newlines(replacement);
  let line = 1;
  let pos = 0;
  return spans.map(([s, e], i) => {
    line += newlines(text.slice(pos, s)) + (i ? added : 0);
    pos = e;
    return line;
  });
}

/** A foreground command: its own process group (Unix), killed whole on stop, timeout or restart. */
function runForeground(command: string, timeout_s: number, env: NodeJS.ProcessEnv, { workdir, signal, onSpawn, onOutput }: ToolContext): Promise<{ code: number | null; sig: NodeJS.Signals | null; out: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { cwd: workdir, shell: true, env, detached: process.platform !== 'win32' });
    if (child.pid) onSpawn?.(child.pid);
    const killTree = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already exited
      }
    };
    const onAbort = () => {
      killTree();
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    let out = '';
    const take = (d: Buffer) => {
      out += d;
      onOutput?.(d.toString());
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(killTree, timeout_s * 1000);
    child.on('error', (e) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(e);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolvePromise({ code, sig, out });
    });
  });
}

export function toolSpecs(): ToolSpec[] {
  return Object.entries(TOOLS).map(([name, t]) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
    return { name, description: t.description, input_schema: schema };
  });
}

/** Execute a tool call. Errors are returned to the model as is_error results, not thrown. */
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<{ output: string; isError: boolean; images?: ImageBlock[] }> {
  const t = (TOOLS as Record<string, Tool<z.ZodType>>)[name];
  if (!t) return { output: `unknown tool ${name}`, isError: true };
  const parsed = t.input.safeParse(input);
  if (!parsed.success) return { output: `invalid input for ${name}: ${parsed.error.message}`, isError: true };
  try {
    const r = await t.run(parsed.data, ctx);
    return typeof r === 'string' ? { output: r, isError: false } : { ...r, isError: false };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}
