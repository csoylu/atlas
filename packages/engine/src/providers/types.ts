import type { ContentBlock, Effort } from '@atlas/shared';

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: ContentBlock[] }[];
  tools: ToolSpec[];
  maxTokens: number;
  /** Unset = the model's default. */
  effort?: Effort;
  /** Offer the provider's own web search where it has one (Anthropic's server tool); others offer none. */
  webSearch?: boolean;
  /**
   * Prompt caching, for an agent's turns (Anthropic): the first `systemStable` chars of `system` are a prefix that stays
   * the same across turns (marked), the rest is volatile; the history's end is marked too. Unset on one-shot calls
   * (title, summary, model test): a cache write nothing would read costs more than no cache.
   */
  cache?: { systemStable: number };
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: string;
  /** input = the whole prompt, cached part included (Anthropic reports cache reads/writes apart: summed here). */
  usage: { input: number; output: number; cached?: number };
  /** The plan subscription that answered (plan-accounts.ts), for the composer's quota. */
  account?: string;
}

/** A streamed piece of the answer: reply text, or thinking text (shown live above the reply, #80). */
export type OnDelta = (text: string, kind: 'text' | 'thinking') => void;

export interface Provider {
  /** Stream one model turn. `onText` receives text and thinking deltas, in order; resolves with the complete message. */
  complete(req: ModelRequest, onText: OnDelta, signal: AbortSignal): Promise<ModelResponse>;
}

/**
 * A tool call's arguments as the model streamed them. Arguments that aren't a JSON object (an unescaped quote in a long
 * string, a call cut off at max_tokens) don't fail the turn: the call keeps the raw text as `{ _invalid_json: raw }`
 * and the runner answers it with an error result so the model resends it (invalidToolInput).
 */
export function toolInput(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // kept raw below; invalidToolInput re-parses it for the error shown to the model
  }
  return { _invalid_json: raw };
}

/**
 * The stop reason of a turn the model's output limit cut off. Every provider reports that case as this value
 * (Anthropic `max_tokens`; OpenAI-compatible `length` and ChatGPT `incomplete: max_output_tokens` are mapped to it), even
 * when the turn holds tool calls (#274): the runner needs it to tell a cut call from a badly escaped one.
 */
export const OUTPUT_LIMIT = 'max_tokens';

/** The start of the error a call cut at the output limit gets (invalidToolInput); the UI matches it (toolRows badInput). */
export const CUT_OFF = 'Your tool call was cut off at the output limit';

/**
 * Why a tool call's arguments were rejected (toolInput), for the model; null for valid arguments. `cut`: the turn
 * stopped at the output limit and this was its last call, so its arguments are cut short, not badly escaped (#274):
 * the model is told to send less per call instead of « escape your quotes », which would only resend the same
 * oversized call. `cut.tokens` = the output tokens the turn used (the limit it hit).
 */
export function invalidToolInput(input: unknown, cut?: { tokens: number }): string | null {
  if (!input || typeof input !== 'object' || !('_invalid_json' in input)) return null;
  const raw = String((input as { _invalid_json: unknown })._invalid_json);
  if (cut)
    return (
      `${CUT_OFF} (${cut.tokens} output tokens, your thinking included): its arguments stop after ${raw.length} chars. ` +
      'The tool did not run and nothing was written.\n' +
      'Do not resend the same call: it would be cut again. Send less per call: write a long file in parts ' +
      '(write_file with the first part, then edit_file to append each next part after its last lines), or split it into several files.'
    );
  let why = 'the arguments must be a JSON object';
  try {
    JSON.parse(raw);
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  const at = /position (\d+)/.exec(why);
  const near = at ? Number(at[1]) : null;
  const excerpt = near == null ? '' : `\nNear position ${near}: …${raw.slice(Math.max(0, near - 60), near)}⟨HERE⟩${raw.slice(near, near + 40)}…`;
  return (
    `Your arguments were not valid JSON (${raw.length} chars): ${why}.${excerpt}\n` +
    'The tool did not run. Resend the call with valid JSON arguments (escape every " and newline inside strings).'
  );
}

/** A model that can't be used: missing key, unreachable server, API error. Shown as-is on the card. */
export class ModelError extends Error {
  /** When a transient failure is known to clear (every plan subscription paused: the earliest reset). */
  retryAt?: string;
  /** Rate limit, overload, 5xx: worth retrying later without a human (design §7 'transient'). */
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}
