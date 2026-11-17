import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ToolCallDetail } from '@atlas/shared';
import type { ToolSpec } from './providers/types.ts';
import type { Background } from './background.ts';
import { findSpans, replaceSpans, type Span } from './fuzzy.ts';
import { globFiles, grep, isBinary, SKIP_DIRS } from './search.ts';
import { fetchPage, headTail } from './web.ts';

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
}

interface Tool<S extends z.ZodType> {
  description: string;
  input: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<string>;
}
const tool = <S extends z.ZodType>(t: Tool<S>) => t;

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

/** For reading: the workdir, or the outputs folder (absolute paths given in tool results). */
function readable(ctx: ToolContext, p: string): string {
  if (isAbsolute(p)) {
    const rel = relative(ctx.outputsDir, resolve(p));
    if (rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) return resolve(p);
  }
  return inside(ctx.workdir, p);
}

/** Save a full output to the outputs folder; returns its path. */
async function saveOutput(ctx: ToolContext, kind: string, text: string, ext = 'txt'): Promise<string> {
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
export function numberedPage(text: string, offset: number, limit: number, budget = READ_CHARS): string {
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
      `to your working directory (or an absolute path Atlas gave you for a saved output). Reads ${READ_LINES} lines from ` +
      '`offset` (1-based) by default; a footer says how to continue. Read a file before editing or overwriting it.',
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
      if (isBinary(buf)) throw new Error(`${path} is a binary file (${buf.length} bytes); read_file reads text only`);
      return numberedPage(buf.toString('utf8'), offset, limit);
    },
  }),
  write_file: tool({
    description:
      'Create or overwrite a text file (parent folders are created). Overwriting an existing file needs a read_file of it ' +
      'in this conversation first. Prefer edit_file for changes to an existing file.',
    input: z.object({ path: z.string(), content: z.string() }),
    run: ({ path, content }, ctx) => {
      const full = inside(ctx.workdir, path);
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
      'Replace old_text with new_text in a file. old_text must be found exactly once (add surrounding lines to make it ' +
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
      const full = inside(ctx.workdir, path);
      return serial(full, () => editFile(ctx, full, path, old_text, new_text, replace_all));
    },
  }),
  list_files: tool({
    description: 'List files and folders (recursive up to depth 3, skips node_modules and .git).',
    input: z.object({ path: z.string().default('.') }),
    run: async ({ path }, { workdir }) => {
      const root = inside(workdir, path);
      const out: string[] = [];
      const walk = async (dir: string, depth: number) => {
        for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (SKIP_DIRS.has(e.name)) continue;
          const p = join(dir, e.name);
          out.push(relative(workdir, p) + (e.isDirectory() ? '/' : ''));
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
      'mode: content (matching lines as path:line:text), files (paths only) or count (path:matches). Skips node_modules and .git.',
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
      return grep({ pattern, root, base: isAbsolute(path) ? ctx.outputsDir : ctx.workdir, glob, mode, limit, context, ignoreCase: ignore_case, signal: ctx.signal });
    },
  }),
  glob: tool({
    description:
      'Find files by name pattern, newest first: `**/*.ts`, `src/**/test*.{ts,tsx}`; a pattern without / matches the name ' +
      'at any depth. Use this instead of find/ls in shell. Skips node_modules and .git.',
    input: z.object({
      pattern: z.string().min(1),
      path: z.string().default('.').describe('folder to search from'),
      limit: z.number().int().min(1).max(1000).default(100),
    }),
    run: async ({ pattern, path, limit }, { workdir }) => {
      const root = inside(workdir, path);
      if (!(await stat(root)).isDirectory()) throw new Error(`${path} is not a directory`);
      return globFiles(pattern, root, workdir, limit);
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
        const p = registry.start({ command, cwd: ctx.workdir, logDir: ctx.outputsDir, agentId, cardId });
        return `started ${p.id} in the background (pid ${p.pid}); its output goes to ${p.logPath}. shell_output("${p.id}") reads new output, shell_kill("${p.id}") stops it; a message comes here when it ends.`;
      }
      const { code, sig, out } = await runForeground(command, timeout_s, ctx);
      const head = `exit ${code ?? sig}${sig === 'SIGKILL' ? ` (killed after ${timeout_s}s)` : ''}\n`;
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
      return ctx.background.registry.read(id, ctx.background.agentId, offset);
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
      'the full text is saved to a file you can read_file or grep.',
    input: z.object({
      url: z.string().min(1),
      max_chars: z.number().int().min(1000).max(100_000).default(15_000),
    }),
    run: async ({ url, max_chars }, ctx) => {
      const page = await fetchPage(url, ctx.signal, ctx.fetch);
      const head = `URL: ${page.url}${page.title ? `\nTitle: ${page.title}` : ''}\n\n`;
      if (page.text.length <= max_chars) return head + page.text;
      const path = await saveOutput(ctx, 'web', head + page.text, 'md');
      return head + headTail(page.text, max_chars, `full text (${page.text.length} chars) in ${path}: read_file it with offset, or grep it`);
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
function runForeground(command: string, timeout_s: number, { workdir, signal, onSpawn, onOutput }: ToolContext): Promise<{ code: number | null; sig: NodeJS.Signals | null; out: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, { cwd: workdir, shell: true, env: process.env, detached: process.platform !== 'win32' });
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
export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<{ output: string; isError: boolean }> {
  const t = (TOOLS as Record<string, Tool<z.ZodType>>)[name];
  if (!t) return { output: `unknown tool ${name}`, isError: true };
  const parsed = t.input.safeParse(input);
  if (!parsed.success) return { output: `invalid input for ${name}: ${parsed.error.message}`, isError: true };
  try {
    return { output: await t.run(parsed.data, ctx), isError: false };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}
