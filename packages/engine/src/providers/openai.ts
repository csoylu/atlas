import { randomUUID } from 'node:crypto';
import type { ContentBlock } from '@atlas/shared';
import { ModelError, type ModelRequest, type ModelResponse, type Provider } from './types.ts';

type OaMessage =
  | { role: 'system' | 'user'; content: string }
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
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

/** Any OpenAI-compatible /v1/chat/completions server: llama.cpp, Ollama, LM Studio, vLLM. */
export class OpenAiCompatProvider implements Provider {
  constructor(
    private baseUrl: string,
    private apiKey: string | undefined,
  ) {}

  async complete(req: ModelRequest, onText: (t: string) => void, signal: AbortSignal): Promise<ModelResponse> {
    const url = this.baseUrl.replace(/\/$/, '') + '/chat/completions';
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
          onText(d.content);
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
      let input: unknown;
      try {
        input = c.args ? JSON.parse(c.args) : {};
      } catch {
        input = { _invalid_json: c.args };
      }
      content.push({ type: 'tool_use', id: c.id || 'call_' + randomUUID().slice(0, 8), name: c.name, input });
    }
    return { content, stopReason: calls.length ? 'tool_use' : finish, usage };
  }
}
