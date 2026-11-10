import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { ToolSpec } from './providers/types.ts';

export interface ToolContext {
  workdir: string;
  signal: AbortSignal;
  /** Called with the pid of a spawned process, so a crash can be cleaned up on restart. */
  onSpawn?: (pid: number) => void;
}

interface Tool<S extends z.ZodType> {
  description: string;
  input: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<string>;
}
const tool = <S extends z.ZodType>(t: Tool<S>) => t;

const OUTPUT_CAP = 30_000;
const cap = (s: string) =>
  s.length <= OUTPUT_CAP ? s : `[${s.length - OUTPUT_CAP} chars omitted]\n` + s.slice(s.length - OUTPUT_CAP);

/** Resolve a path inside the workdir; anything outside is refused (design §10). */
export function inside(workdir: string, p: string): string {
  const full = resolve(workdir, p);
  const rel = relative(workdir, full);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`path ${p} is outside the workdir ${workdir}`);
  return full;
}

export const TOOLS = {
  read_file: tool({
    description: 'Read a UTF-8 text file. Paths are relative to your working directory.',
    input: z.object({ path: z.string() }),
    run: async ({ path }, { workdir }) => cap(await readFile(inside(workdir, path), 'utf8')),
  }),
  write_file: tool({
    description: 'Create or overwrite a text file (parent folders are created).',
    input: z.object({ path: z.string(), content: z.string() }),
    run: async ({ path, content }, { workdir }) => {
      const full = inside(workdir, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
      return `wrote ${content.length} chars to ${path}`;
    },
  }),
  edit_file: tool({
    description: 'Replace one exact, unique occurrence of old_text with new_text in a file.',
    input: z.object({ path: z.string(), old_text: z.string().min(1), new_text: z.string() }),
    run: async ({ path, old_text, new_text }, { workdir }) => {
      const full = inside(workdir, path);
      const text = await readFile(full, 'utf8');
      const n = text.split(old_text).length - 1;
      if (n !== 1) throw new Error(`old_text found ${n} times in ${path}; it must be found exactly once`);
      await writeFile(full, text.replace(old_text, () => new_text));
      return `edited ${path}`;
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
          if (e.name === 'node_modules' || e.name === '.git') continue;
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
  shell: tool({
    description: 'Run a shell command in your working directory. Returns exit code, stdout and stderr (tail-capped).',
    input: z.object({ command: z.string().min(1), timeout_s: z.number().int().positive().max(1800).default(120) }),
    run: ({ command, timeout_s }, { workdir, signal, onSpawn }) =>
      new Promise((resolvePromise, reject) => {
        // Own process group (Unix), so the whole command tree can be killed on stop, timeout or restart.
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
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (out += d));
        const timer = setTimeout(killTree, timeout_s * 1000);
        child.on('error', (e) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(e);
        });
        child.on('close', (code, sig) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolvePromise(cap(`exit ${code ?? sig}${sig === 'SIGKILL' ? ` (killed after ${timeout_s}s)` : ''}\n${out}`));
        });
      }),
  }),
} satisfies Record<string, Tool<z.ZodType>>;

export type ToolName = keyof typeof TOOLS;

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
