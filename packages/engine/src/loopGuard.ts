import { createHash } from 'node:crypto';

/**
 * Loop guard (#239): a run that is progressing goes on; a run that repeats itself stops. Cheap, deterministic rules
 * over what the tools returned, no model judging "progress". The state lives on the run's row (migration 0055) and a
 * run resumed after a restart inherits it (Runner.wake), so a kill never lets a loop start again from zero.
 */

/** Safety ceiling: model calls in one run (and the runs it resumed after a restart) before it stops. */
export const MAX_TURNS = 600;
/** The same tool call with the same input and the same result this many times in a row stops the run. */
export const REPEAT_LIMIT = 5;
/** This many turns in a row where every tool call failed stops the run. */
export const FAIL_TURNS_LIMIT = 30;

export interface GuardState {
  /** Model calls so far. */
  turns: number;
  /** Turns in a row whose tool calls all failed. */
  failStreak: number;
  /** How many times in a row the last call (repeatKey) came back identical. */
  repeatStreak: number;
  repeatKey: string | null;
}

export const freshGuard = (): GuardState => ({ turns: 0, failStreak: 0, repeatStreak: 0, repeatKey: null });

export interface GuardCall {
  name: string;
  input: unknown;
  output: string;
  isError: boolean;
}

/** A short, one-line name for a call: the command of a shell call, else the tool and its input. */
export function callLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const raw = name === 'shell' && typeof i.command === 'string' ? i.command : `${name} ${JSON.stringify(input ?? {})}`;
  const line = raw.replace(/\s+/g, ' ').trim();
  return line.length > 120 ? line.slice(0, 119) + '…' : line;
}

const firstLine = (s: string) => {
  const l = s.split('\n').find((x) => x.trim()) ?? '';
  return l.length > 160 ? l.slice(0, 159) + '…' : l;
};

/** The note a run leaves when the ceiling stops it. */
export const ceilingReason = (n: number) => `reached the safety ceiling of ${n} turns in one run`;

/**
 * The state after one turn's tool calls (in order), and why the run stops now, if it does. A turn without tool calls
 * changes nothing.
 */
export function afterTools(s: GuardState, calls: GuardCall[]): { state: GuardState; stop: string | null } {
  if (!calls.length) return { state: s, stop: null };
  let { repeatStreak, repeatKey } = s;
  let stop: string | null = null;
  for (const c of calls) {
    const key = createHash('sha1').update(JSON.stringify([c.name, c.input ?? null, c.isError, c.output])).digest('hex');
    repeatStreak = key === repeatKey ? repeatStreak + 1 : 1;
    repeatKey = key;
    if (!stop && repeatStreak >= REPEAT_LIMIT)
      stop = `\`${callLabel(c.name, c.input)}\` ${c.isError ? 'failed' : 'returned'} the same way ${repeatStreak} times in a row${c.isError && firstLine(c.output) ? ` (${firstLine(c.output)})` : ''}`;
  }
  const failStreak = calls.every((c) => c.isError) ? s.failStreak + 1 : 0;
  if (!stop && failStreak >= FAIL_TURNS_LIMIT) {
    const last = calls.at(-1)!;
    stop = `every tool call failed for ${failStreak} turns in a row (last: \`${callLabel(last.name, last.input)}\`${firstLine(last.output) ? `: ${firstLine(last.output)}` : ''})`;
  }
  return { state: { turns: s.turns, failStreak, repeatStreak, repeatKey }, stop };
}

/** The system note that ends a stopped run (the card and the chat show it). */
export const stopNote = (reason: string) => `Stopped: ${reason}.`;
