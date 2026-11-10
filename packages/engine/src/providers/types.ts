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
}

export interface ModelResponse {
  content: ContentBlock[];
  stopReason: string;
  /** input = the whole prompt, cached part included (Anthropic reports cache reads/writes apart: summed here). */
  usage: { input: number; output: number; cached?: number };
}

export interface Provider {
  /** Stream one model turn. `onText` receives text deltas; resolves with the complete message. */
  complete(req: ModelRequest, onText: (t: string) => void, signal: AbortSignal): Promise<ModelResponse>;
}

/** A model that can't be used: missing key, unreachable server, API error. Shown as-is on the card. */
export class ModelError extends Error {
  /** Rate limit, overload, 5xx: worth retrying later without a human (design §7 'transient'). */
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}
