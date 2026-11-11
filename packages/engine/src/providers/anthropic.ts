import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock } from '@atlas/shared';
import { ModelError, type ModelRequest, type ModelResponse, type Provider } from './types.ts';

export const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
export const CLAUDE_CODE_USER_AGENT = 'claude-code/2.1.0';
export const CLAUDE_CODE_OAUTH_BETAS = ['claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'fine-grained-tool-streaming-2025-05-14'];

/** True for Anthropic OAuth / setup tokens (sk-ant-oat*, eyJ JWTs, cc-); False for Console API keys. */
export function isOAuthToken(key: string | null | undefined): boolean {
  if (!key) return false;
  if (key.startsWith('sk-ant-api') || key.startsWith('sk-ant-usr') || key.startsWith('sk-ant-svc') || key.startsWith('sk-ant-admin')) {
    return false;
  }
  return key.startsWith('sk-ant-') || key.startsWith('eyJ') || key.startsWith('cc-');
}

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
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private isOAuth: boolean;

  constructor(apiKey: string | null, opts: AnthropicOptions | string = {}) {
    const o = typeof opts === 'string' ? { baseURL: opts } : opts;
    const onHeaders = o.onHeaders;
    const f = o.fetch ?? fetch;

    const token = o.authToken ?? apiKey;
    this.isOAuth = isOAuthToken(token) || !!o.authToken;

    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    let actualApiKey: string | null = apiKey;
    let actualAuthToken: string | null = o.authToken ?? null;

    if (this.isOAuth && token) {
      actualApiKey = null;
      actualAuthToken = token;

      // Inject Claude Code identity headers (matches Hermes agent adapter)
      if (!headers['user-agent'] && !headers['User-Agent']) {
        headers['user-agent'] = CLAUDE_CODE_USER_AGENT;
      }
      if (!headers['x-app'] && !headers['X-App']) {
        headers['x-app'] = 'cli';
      }

      const existingBetas = headers['anthropic-beta'] ? headers['anthropic-beta'].split(',') : [];
      const mergedBetas = Array.from(new Set([...existingBetas, ...CLAUDE_CODE_OAUTH_BETAS])).filter(Boolean).join(',');
      headers['anthropic-beta'] = mergedBetas;
    }

    this.client = new Anthropic({
      apiKey: actualApiKey,
      authToken: actualAuthToken,
      baseURL: o.baseURL,
      maxRetries: o.maxRetries ?? 2,
      defaultHeaders: Object.keys(headers).length ? headers : undefined,
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
      const systemPrompt = this.isOAuth && !req.system.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)
        ? `${CLAUDE_CODE_SYSTEM_PREFIX}\n\n${req.system}`
        : req.system;

      const stream = this.client.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          // Stable prefix is cached (design §5).
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
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
