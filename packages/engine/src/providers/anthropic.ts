import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock } from '@atlas/shared';
import { ModelError, type ModelRequest, type ModelResponse, type Provider } from './types.ts';

/** An Anthropic HTTP error with what account failover needs (status, the response headers). */
export class AnthropicError extends ModelError {
  constructor(
    message: string,
    transient: boolean,
    readonly status: number | undefined,
    readonly headers: Headers | null,
  ) {
    super(message, transient);
  }
}

export interface AnthropicOptions {
  baseURL?: string;
  /** SDK retries (accounts set 0 so failover to the next account is immediate). */
  maxRetries?: number;
  /** Sees every response's headers (rate limits). */
  onHeaders?: (h: Headers) => void;
  /** OAuth access token (Claude plan, claude-plan.ts): sent as `Authorization: Bearer`, no API key. */
  authToken?: string;
  /** Extra headers on every request (only the ones Anthropic's approval names). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  constructor(apiKey: string | null, opts: AnthropicOptions | string = {}) {
    const o = typeof opts === 'string' ? { baseURL: opts } : opts;
    const onHeaders = o.onHeaders;
    const f = o.fetch ?? fetch;
    this.client = new Anthropic({
      apiKey,
      authToken: o.authToken ?? null,
      baseURL: o.baseURL,
      maxRetries: o.maxRetries ?? 2,
      defaultHeaders: o.headers,
      fetch:
        onHeaders || o.fetch
          ? async (url: RequestInfo | URL, init?: RequestInit) => {
              const res = await f(url, init);
              onHeaders?.(res.headers);
              return res;
            }
          : undefined,
    });
  }

  async complete(req: ModelRequest, onText: (t: string) => void, signal: AbortSignal): Promise<ModelResponse> {
    try {
      const stream = this.client.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          // Stable prefix is cached (design §5).
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages: req.messages as Anthropic.MessageParam[],
          tools: req.tools as Anthropic.Tool[],
          // Claude has no « off »: none → low.
          ...(req.effort ? { output_config: { effort: req.effort === 'none' ? 'low' : req.effort } } : {}),
        },
        { signal },
      );
      stream.on('text', onText);
      const msg = await stream.finalMessage();
      const content: ContentBlock[] = [];
      for (const b of msg.content) {
        if (b.type === 'text') content.push({ type: 'text', text: b.text });
        else if (b.type === 'thinking') content.push({ type: 'thinking', thinking: b.thinking, signature: b.signature });
        else if (b.type === 'redacted_thinking') content.push({ type: 'redacted_thinking', data: b.data });
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        else throw new ModelError(`Anthropic returned an unsupported block type: ${b.type}`);
      }
      return {
        content,
        stopReason: msg.stop_reason ?? 'unknown',
        usage: {
          input: msg.usage.input_tokens + (msg.usage.cache_read_input_tokens ?? 0) + (msg.usage.cache_creation_input_tokens ?? 0),
          output: msg.usage.output_tokens,
          cached: msg.usage.cache_read_input_tokens ?? 0,
        },
      };
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof Anthropic.APIError) {
        const transient = e.status === undefined || e.status === 429 || e.status >= 500;
        const headers = e.headers instanceof Headers ? e.headers : e.headers ? new Headers(e.headers as Record<string, string>) : null;
        throw new AnthropicError(`Anthropic API error ${e.status ?? '(no response)'}: ${e.message}`, transient, e.status, headers);
      }
      throw e;
    }
  }
}
