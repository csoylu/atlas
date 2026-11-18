import { randomUUID } from 'node:crypto';
import type { ContentBlock, ImageBlock } from '@atlas/shared';
import { imageLine, viewHasPictures } from '../images.ts';
import { ModelError, toolInput, type ModelRequest, type ModelResponse, type OnDelta, type Provider } from './types.ts';

type OaPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type OaMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OaPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: OaToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
interface OaToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Anthropic-shaped transcript → OpenAI chat messages. Thinking blocks are not sent. */
export function toOpenAiMessages(req: ModelRequest): OaMessage[] {
  const out: OaMessage[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const calls = m.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [{ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }]
          : [],
      );
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
      // Tool messages carry text only: a tool's pictures follow in a user message, named by the call they came from.
      const parts: OaPart[] = [];
      for (const b of m.content)
        if (b.type === 'tool_result' && b.images?.length) {
          parts.push({ type: 'text', text: `Pictures returned by tool call ${b.tool_use_id}:` });
          parts.push(...b.images.map(imagePart));
        }
      for (const b of m.content) {
        if (b.type === 'text') {
          const last = parts.at(-1);
          if (last?.type === 'text' && !last.text.startsWith('Pictures returned')) last.text += '\n\n' + b.text;
          else parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image') parts.push(imagePart(b));
      }
      // Text only: a plain string, as before (servers without vision support still read it).
      if (parts.length) out.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n\n') : parts });
    }
  }
  return out;
}

const imagePart = (b: ImageBlock): OaPart =>
  b.data ? { type: 'image_url', image_url: { url: `data:${b.media_type};base64,${b.data}` } } : { type: 'text', text: imageLine(b) };

/** Any OpenAI-compatible /v1/chat/completions server: llama.cpp, Ollama, LM Studio, vLLM. */
export class OpenAiCompatProvider implements Provider {
  constructor(
    private baseUrl: string,
    private apiKey: string | undefined,
  ) {}

  private vision = new Map<string, boolean | null>();
  /**
   * True when the server says the model has no vision (Ollama's /api/show `capabilities`). Servers without that route
   * (llama.cpp, LM Studio) answer null: the request goes, and a refusal is reported as « can't see images ».
   */
  private async noVision(model: string, signal: AbortSignal): Promise<boolean> {
    if (!this.vision.has(model)) {
      let v: boolean | null = null;
      try {
        const res = await fetch(this.baseUrl.replace(/\/v1\/?$/, '') + '/api/show', {
          method: 'POST',
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        const j = res.ok ? ((await res.json()) as { capabilities?: unknown }) : null;
        if (Array.isArray(j?.capabilities)) v = j.capabilities.includes('vision');
      } catch (e) {
        signal.throwIfAborted();
        void e; // not an Ollama server: unknown, the request itself tells
      }
      this.vision.set(model, v);
    }
    return this.vision.get(model) === false;
  }

  async complete(req: ModelRequest, onText: OnDelta, signal: AbortSignal): Promise<ModelResponse> {
    const url = this.baseUrl.replace(/\/$/, '') + '/chat/completions';
    if (viewHasPictures(req.messages) && (await this.noVision(req.model, signal)))
      throw new ModelError(`model ${req.model} at ${this.baseUrl} can't see images (it has no vision capability): pick a vision model for this chat, or send text only`);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          stream: true,
          stream_options: { include_usage: true },
          // Ollama and others know low/medium/high only.
          ...(req.effort ? { reasoning_effort: req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort } : {}),
          messages: toOpenAiMessages(req),
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
        }),
      });
    } catch (e) {
      if (signal.aborted) throw e;
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : String(e);
      throw new ModelError(`model ${req.model} at ${this.baseUrl} is not reachable: ${cause}`);
    }
    if (!res.ok || !res.body) {
      // A refused request with pictures: most likely a model without vision; say so instead of a bare HTTP error.
      if (res.status >= 400 && res.status < 500 && viewHasPictures(req.messages))
        throw new ModelError(`model ${req.model} at ${this.baseUrl} refused a message with images (HTTP ${res.status}: ${(await res.text()).slice(0, 300)}): this model can't see images; pick a vision model for this chat`);
      throw new ModelError(
        `model ${req.model} at ${this.baseUrl} answered HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`,
        res.status === 429 || res.status >= 500,
      );
    }

    let text = '';
    let finish = 'unknown';
    const usage = { input: 0, output: 0, cached: 0 };
    const calls: { id: string; name: string; args: string }[] = [];
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const ev = JSON.parse(data) as {
          choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
        };
        if (ev.usage) {
          usage.input = ev.usage.prompt_tokens ?? 0;
          usage.output = ev.usage.completion_tokens ?? 0;
          usage.cached = ev.usage.prompt_tokens_details?.cached_tokens ?? 0;
        }
        const choice = ev.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const d = choice.delta;
        if (d?.content) {
          text += d.content;
          onText(d.content, 'text');
        }
        for (const tc of d?.tool_calls ?? []) {
          const c = (calls[tc.index] ??= { id: '', name: '', args: '' });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
        }
      }
    }

    const content: ContentBlock[] = [];
    if (text) content.push({ type: 'text', text });
    for (const c of calls) {
      content.push({ type: 'tool_use', id: c.id || 'call_' + randomUUID().slice(0, 8), name: c.name, input: toolInput(c.args) });
    }
    return { content, stopReason: calls.length ? 'tool_use' : finish, usage };
  }
}
