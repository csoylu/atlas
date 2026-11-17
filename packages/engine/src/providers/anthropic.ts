import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock } from '@atlas/shared';
import { ModelError, toolInput, type ModelRequest, type ModelResponse, type OnDelta, type Provider } from './types.ts';

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
  systemPrefix?: string;
  /** Offer Anthropic's web search when asked (req.webSearch). Default: only against api.anthropic.com, not a proxy or another server. */
  webSearch?: boolean;
}

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private systemPrefix: string | undefined;
  private webSearch: boolean;
  constructor(apiKey: string | null, opts: AnthropicOptions | string = {}) {
    const o = typeof opts === 'string' ? { baseURL: opts } : opts;
    this.systemPrefix = o.systemPrefix;
    this.webSearch = o.webSearch ?? isAnthropicApi(o.baseURL);
    const onHeaders = o.onHeaders;
    const f = o.fetch ?? fetch;
    this.client = new Anthropic({
      apiKey,
      authToken: o.authToken ?? null,
      baseURL: o.baseURL,
      maxRetries: o.maxRetries ?? 2,
      defaultHeaders: { ...(apiKey && !o.authToken ? { 'x-api-key': apiKey, authorization: null } : {}), ...o.headers },
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

  async complete(req: ModelRequest, onText: OnDelta, signal: AbortSignal): Promise<ModelResponse> {
    try {
      // The raw event stream, accumulated here (not the SDK's MessageStream): the SDK parses a tool call's arguments
      // itself and throws on invalid JSON, failing the whole turn; toolInput keeps them for the model to resend.
      const stream = await this.client.messages.create(
        {
          stream: true,
          model: req.model,
          max_tokens: req.maxTokens,
          // Stable prefix is cached (design §5).
          system: [...(this.systemPrefix ? [{ type: 'text' as const, text: this.systemPrefix }] : []), ...systemBlocks(req)],
          // The history too: breakpoints at its end (withCacheBreakpoints).
          messages: (req.cache ? withCacheBreakpoints(req.messages) : req.messages) as Anthropic.MessageParam[],
          tools: [...(req.tools as Anthropic.ToolUnion[]), ...(req.webSearch && this.webSearch ? [WEB_SEARCH] : [])],
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
          // Newer models think adaptively but omit the thinking text by default: ask for the summary so the user sees it.
          ...(adaptiveThinking(req.model) ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
        },
        { signal },
      );
      // Blocks by index; tool calls carry their streamed arguments until the end.
      const blocks: (ContentBlock & { json?: string })[] = [];
      let usage: Anthropic.Usage | null = null;
      let stopReason: string | null = null;
      let stopped = false;
      for await (const ev of stream) {
        if (ev.type === 'message_start') usage = { ...ev.message.usage };
        else if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          if (b.type === 'text') blocks[ev.index] = { type: 'text', text: b.text };
          else if (b.type === 'thinking') blocks[ev.index] = { type: 'thinking', thinking: b.thinking, signature: b.signature };
          else if (b.type === 'redacted_thinking') blocks[ev.index] = { type: 'redacted_thinking', data: b.data };
          else if (b.type === 'tool_use') blocks[ev.index] = { type: 'tool_use', id: b.id, name: b.name, input: {}, json: '' };
          // Web search runs at Anthropic: kept verbatim so it replays (encrypted_content included) and shows in the UI.
          else if (b.type === 'server_tool_use') blocks[ev.index] = { type: 'server_tool_use', id: b.id, name: b.name, input: {}, json: '' };
          else if (b.type === 'web_search_tool_result') blocks[ev.index] = { type: 'web_search_tool_result', tool_use_id: b.tool_use_id, content: b.content };
          else throw new ModelError(`Anthropic returned an unsupported block type: ${b.type}`);
        } else if (ev.type === 'content_block_delta') {
          const b = blocks[ev.index];
          const d = ev.delta;
          if (!b) throw new ModelError(`Anthropic streamed a delta for an unknown block ${ev.index}`, true);
          if (d.type === 'text_delta' && b.type === 'text') {
            b.text += d.text;
            onText(d.text, 'text');
          } else if (d.type === 'thinking_delta' && b.type === 'thinking') {
            b.thinking += d.thinking;
            onText(d.thinking, 'thinking');
          }
          else if (d.type === 'signature_delta' && b.type === 'thinking') b.signature = d.signature;
          else if (d.type === 'input_json_delta' && b.json !== undefined) b.json += d.partial_json;
          // citations_delta: citations aren't kept (as before).
        } else if (ev.type === 'message_delta') {
          stopReason = ev.delta.stop_reason ?? stopReason;
          if (usage) {
            usage.output_tokens = ev.usage.output_tokens;
            if (ev.usage.input_tokens != null) usage.input_tokens = ev.usage.input_tokens;
            if (ev.usage.cache_read_input_tokens != null) usage.cache_read_input_tokens = ev.usage.cache_read_input_tokens;
            if (ev.usage.cache_creation_input_tokens != null) usage.cache_creation_input_tokens = ev.usage.cache_creation_input_tokens;
          }
        } else if (ev.type === 'message_stop') stopped = true;
      }
      if (!usage || !stopped) throw new ModelError('Anthropic: the response stream ended before it completed', true);
      const content: ContentBlock[] = blocks.filter(Boolean).map(({ json, ...b }) =>
        json !== undefined && (b.type === 'tool_use' || b.type === 'server_tool_use') ? { ...b, input: toolInput(json) } : b,
      );
      return {
        content,
        stopReason: stopReason ?? 'unknown',
        usage: {
          input: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          output: usage.output_tokens,
          cached: usage.cache_read_input_tokens ?? 0,
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

function isAnthropicApi(baseURL: string | undefined): boolean {
  if (!baseURL) return true;
  try {
    return new URL(baseURL).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

/** Anthropic's server-side web search (API key and Claude plan): runs at Anthropic, results come back in the answer. */
export const WEB_SEARCH = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 } as const;

/**
 * The system prompt as blocks. Cached turns: the stable prefix carries a breakpoint, the volatile tail (memory, card,
 * date) follows it unmarked, so a memory edit or a card change re-reads the prefix from the cache. One-shot calls: one
 * plain block.
 */
export function systemBlocks(req: Pick<ModelRequest, 'system' | 'cache'>): Anthropic.TextBlockParam[] {
  const stable = req.system.slice(0, req.cache?.systemStable ?? 0);
  const tail = req.system.slice(stable.length);
  if (!req.cache || !stable.trim()) return [{ type: 'text', text: req.system }];
  return [
    { type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
    ...(tail.trim() ? [{ type: 'text' as const, text: tail }] : []),
  ];
}

/**
 * Prompt caching for the history (design §5): the view is append-only between calls, so marking its end lets the next
 * call read everything up to here from the cache (~10% of the input price, and much less of a plan's limits) instead of
 * paying the whole transcript again on every tool round. Two breakpoints: the last user message (written now, hit next
 * call) and the user message before it (where the previous call wrote, so this call hits it exactly even when the
 * new turn has more blocks than the API's 20-block lookback). With the system one, 3 of the 4 allowed. Returns copies:
 * the caller's messages are never touched. Only user messages are marked: their blocks are text or tool_result, never
 * thinking (which can't carry cache_control).
 */
export function withCacheBreakpoints(messages: ModelRequest['messages']): unknown[] {
  const out: unknown[] = messages.map((m) => m);
  let marked = 0;
  for (let i = messages.length - 1; i >= 0 && marked < 2; i--) {
    const m = messages[i]!;
    if (m.role !== 'user' || m.content.length === 0) continue;
    const last = m.content.at(-1)!;
    if (last.type === 'text' && !last.text) continue; // empty text blocks can't be cached
    out[i] = { role: m.role, content: [...m.content.slice(0, -1), { ...last, cache_control: { type: 'ephemeral' } }] };
    marked++;
  }
  return out;
}

/**
 * Models that take `thinking: { type: 'adaptive' }`: Claude 4.6 and later (opus/sonnet/haiku-<major>[-<minor>]).
 * Older or unrecognised names get no thinking parameter, as before (sending it to them is a 400).
 */
export function adaptiveThinking(model: string): boolean {
  const m = /claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(model);
  if (!m) return false;
  const major = Number(m[1]), minor = Number(m[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 6);
}
