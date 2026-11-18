import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ContentBlock } from '@atlas/shared';
import type { ToolSpec } from './providers/types.ts';
import { REDACT_OVERLAP, type Secrets } from './secrets.ts';

/**
 * secret_set and secret_delete (#207). No tool ever reads a value: an agent stores one (from a command's output it
 * never sees, or typed in the call) and uses it as $NAME in its shell commands.
 */
export interface SecretToolContext {
  secrets: Secrets;
  agentId: string;
  /** The run's project (#215): a new secret belongs to it; only its own and global ones are visible. */
  projectId: string;
  /** The task it works on (created_card); null in a direct chat. */
  cardId: string | null;
  workdir: string;
  signal: AbortSignal;
  /** The agent's shell environment for this command (login PATH, its granted secrets). */
  env: (command: string) => Promise<NodeJS.ProcessEnv>;
}

const Name = z.string().describe('env var name: A-Z, 0-9 and _, starting with a letter, e.g. ETHERSCAN_KEY');
/** How long the value's command may run. */
const COMMAND_TIMEOUT_S = 60;
/** The end of stderr shown when the command fails (redacted). */
const STDERR_TAIL = 600;

const SecretSet = z
  .object({
    name: Name,
    description: z.string().max(500).optional().describe('what it is, shown to the user and in your instructions'),
    command: z.string().min(1).optional().describe('a shell command whose stdout is the value; you never see the output'),
    value: z.string().min(1).optional().describe('the value itself, when it is not on this machine (prefer command)'),
  })
  .refine((i) => (i.command === undefined) !== (i.value === undefined), 'give exactly one of command or value');

const SecretDelete = z.object({ name: Name });

const SPECS = {
  secret_set: {
    description:
      'Store a secret (API key, token, password) for your shell commands, as $NAME. Prefer command: the engine runs it ' +
      'in your workdir with your shell environment and stores its trimmed stdout; the output never reaches you, the ' +
      'transcript or the model provider (the result says only how many chars were stored). value: the value itself, ' +
      'when no command can produce it; it is hidden as [secret NAME] in the stored transcript, but the model provider ' +
      'has already seen it in this call. A new secret belongs to this project and is granted to you only. You can overwrite or delete only secrets ' +
      'you created, never the user\'s or another agent\'s, nor a model key. Never print a value.',
    input: SecretSet,
  },
  secret_delete: {
    description: 'Delete a secret you created (its value and its entry). Not the user\'s, another agent\'s or a model key.',
    input: SecretDelete,
  },
} as const;

export function secretToolSpecs(): ToolSpec[] {
  return Object.entries(SPECS).map(([name, t]) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
    return { name, description: t.description, input_schema: schema };
  });
}

export const isSecretTool = (name: string): boolean => name in SPECS;

/**
 * The tool call as it is stored (transcript, tool_calls, logs): a secret_set value becomes [secret NAME]. The model
 * provider got the call before this (it wrote it).
 */
export function redactSecretCalls(content: ContentBlock[]): ContentBlock[] {
  return content.map((b) => {
    if (b.type !== 'tool_use' || b.name !== 'secret_set') return b;
    const i = b.input as Record<string, unknown> | null;
    if (!i || typeof i !== 'object' || i.value === undefined) return b;
    return { ...b, input: { ...i, value: `[secret ${typeof i.name === 'string' ? i.name : '?'}]` } };
  });
}

export async function runSecretTool(name: string, input: unknown, ctx: SecretToolContext): Promise<{ output: string; isError: boolean }> {
  try {
    if (name === 'secret_delete') {
      const { name: n } = SecretDelete.parse(input);
      ctx.secrets.agentDelete(ctx.agentId, ctx.projectId, n);
      return { output: `deleted ${n}`, isError: false };
    }
    const parsed = SecretSet.safeParse(input);
    if (!parsed.success) return { output: `invalid input for secret_set: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
    const i = parsed.data;
    const value = i.command !== undefined ? await valueOf(i.command, ctx) : i.value!;
    const v = value.trim();
    if (!v) throw new Error(i.command !== undefined ? 'the command printed nothing on stdout: nothing stored' : 'the value is empty: nothing stored');
    const { created } = ctx.secrets.agentSet(ctx.agentId, ctx.projectId, ctx.cardId, i.name, v, i.description);
    const short = v.length < 8 ? ' (under 8 chars: too short to be hidden from outputs)' : '';
    return { output: `stored ${i.name}, ${v.length} chars${created ? ', granted to you only' : ' (replaced its value)'}${short}. Use it as $${i.name} in shell commands.`, isError: false };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}

/** The command's stdout, never shown; on failure an error with the end of stderr, secret values hidden. */
function valueOf(command: string, ctx: SecretToolContext): Promise<string> {
  return ctx.env(command).then(
    (env) =>
      new Promise((resolve, reject) => {
        const child = spawn(command, { cwd: ctx.workdir, shell: true, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        const kill = () => {
          if (!child.pid) return;
          try {
            if (process.platform === 'win32') child.kill('SIGKILL');
            else process.kill(-child.pid, 'SIGKILL');
          } catch {
            // already exited
          }
        };
        const onAbort = () => {
          kill();
          reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('aborted'));
        };
        if (ctx.signal.aborted) return onAbort();
        ctx.signal.addEventListener('abort', onAbort, { once: true });
        const out: Buffer[] = [];
        let err = '';
        let errCut = false;
        child.stdout.on('data', (d: Buffer) => out.push(d));
        child.stderr.on('data', (d: Buffer) => {
          err += d.toString();
          if (err.length > STDERR_TAIL + REDACT_OVERLAP) {
            err = err.slice(-(STDERR_TAIL + REDACT_OVERLAP));
            errCut = true;
          }
        });
        const timer = setTimeout(kill, COMMAND_TIMEOUT_S * 1000);
        const done = () => {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
        };
        child.on('error', (e) => {
          done();
          reject(e);
        });
        child.on('close', (code, sig) => {
          done();
          if (code === 0) return resolve(Buffer.concat(out).toString());
          // stdout may hold part of the value: never shown. stderr is shown redacted (known values), its end only.
          // Redacted before it is cut (#227): a value crossing the cut is hidden whole.
          let tail: string;
          try {
            const e = err.trimEnd();
            tail = ctx.secrets.redactWindow(e, e.length - STDERR_TAIL, e.length, { cutStart: errCut }).text.trimStart();
          } catch {
            tail = '(stderr withheld: the secret store could not be read to hide values in it)';
          }
          const why = sig === 'SIGKILL' ? `was killed after ${COMMAND_TIMEOUT_S}s` : `exited with ${code ?? sig}`;
          reject(new Error(`the command ${why}: nothing stored${tail ? `\nstderr: ${tail}` : ''}`));
        });
      }),
  );
}
