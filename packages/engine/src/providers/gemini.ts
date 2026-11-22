import { randomUUID } from 'node:crypto';
import type { ContentBlock } from '@atlas/shared';
import { ModelError, type ModelRequest, type ModelResponse, type Provider } from './types.ts';

/** Antigravity's Cloud Code host for consumer subscriptions (the production host serves Gemini CLI quota instead). */
export const DEFAULT_GEMINI_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
/** The Hub release whose headers the server expects; below 2.23.0 newer models are refused. */
export const ANTIGRAVITY_VERSION = '2.24.0';
/**
 * Cloud Code accepts this in place of a real thought signature. Gemini 3 rejects function calls without one; Atlas
 * keeps the real signature when the model sent thinking, and uses the sentinel when it didn't.
 */
export const SKIP_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/** Atlas speaks as the Antigravity Hub; Cloud Code routes the request to subscription quota from these headers. */
export function antigravityUserAgent(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return `antigravity/hub/${ANTIGRAVITY_VERSION} (aidev_client; os_type=${os}; arch=${process.arch}; cl=1000335682)`;
}

/** A Cloud Code HTTP error, with what the plan needs to pause (429) or sign out (401). */
export class GeminiError extends ModelError {
  constructor(
    message: string,
    transient: boolean,
    readonly status: number | undefined,
    readonly headers: Headers | null,
    readonly body: string,
  ) {
    super(message, transient);
  }
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}
interface GeminiResponse {
  candidates?: { content?: { role?: string; parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number };
}

/**
 * Atlas's transcript → Cloud Code contents. Tool results carry the name Gemini expects; the first function call of
 * an assistant turn carries the turn's thinking signature (or the skip sentinel, like Antigravity's own client).
 */
export function toGeminiContents(req: ModelRequest): GeminiContent[] {
  const toolNames = new Map<string, string>();
  for (const m of req.messages) for (const b of m.content) if (b.type === 'tool_use') toolNames.set(b.id, b.name);

  const out: GeminiContent[] = [];
  for (const m of req.messages) {
    const parts: GeminiPart[] = [];
    if (m.role === 'assistant') {
      let signature = '';
      let firstCall = true;
      for (const b of m.content) {
        if (b.type === 'thinking') {
          // Cloud Code checks a signature against the exact thought text it was issued for; Atlas can't match them
          // after a wait, so thinking text replays with the skip sentinel (as Antigravity's own client does) and the
          // real signature goes on the turn's first function call below.
          if (b.thinking) parts.push({ text: b.thinking, thought: true, thoughtSignature: SKIP_THOUGHT_SIGNATURE });
          if (b.signature) signature = b.signature;
        } else if (b.type === 'text') {
          if (b.text) parts.push({ text: b.text });
        } else if (b.type === 'tool_use') {
          const sig = firstCall ? signature || SKIP_THOUGHT_SIGNATURE : undefined;
          firstCall = false;
          signature = '';
          parts.push({
            functionCall: { id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> },
            ...(sig ? { thoughtSignature: sig } : {}),
          });
        }
        // redacted_thinking has no Cloud Code form; it is never replayed.
      }
      if (parts.length) out.push({ role: 'model', parts });
    } else {
      for (const b of m.content) {
        if (b.type === 'text') {
          if (b.text) parts.push({ text: b.text });
        } else if (b.type === 'tool_result') {
          parts.push({
            functionResponse: {
              id: b.tool_use_id,
              name: toolNames.get(b.tool_use_id) ?? 'tool',
              response: b.is_error ? { error: b.content } : { result: b.content },
            },
          });
        }
      }
      if (parts.length) out.push({ role: 'user', parts });
    }
  }
  return out;
}

/** JSON Schema fields Gemini's subset refuses; everything else is passed through. */
export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const drop = new Set(['$schema', '$id', '$comment', 'additionalProperties', 'strict', 'unevaluatedProperties']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (drop.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([n, s]) => [n, cleanSchema(s)]));
    } else out[k] = cleanSchema(v);
  }
  return out;
}

const STOP_REASONS: Record<string, string> = { STOP: 'stop', MAX_TOKENS: 'max_tokens', SAFETY: 'safety', RECITATION: 'recitation', OTHER: 'other' };

/** What Cloud Code said when it refused a request, in one line. */
export function geminiErrorText(status: number, body: string): string {
  let detail = body.trim().slice(0, 400);
  try {
    const j = JSON.parse(body) as { error?: { message?: string; status?: string } };
    if (j.error?.message) detail = `${j.error.status ? j.error.status + ': ' : ''}${j.error.message}`;
  } catch {}
  return `Gemini plan: Cloud Code answered HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

/** Streams one turn through Antigravity's Cloud Code endpoint and maps the answer to Atlas blocks. */
export class GeminiProvider implements Provider {
  constructor(
    private project: string,
    private accessToken: string,
    private endpoint: string = DEFAULT_GEMINI_ENDPOINT,
    private fetchFn: typeof fetch = fetch,
  ) {}

  private body(req: ModelRequest): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = { maxOutputTokens: req.maxTokens };
    if (req.effort) {
      // Gemini 3+ takes a level; older models take a budget. 'none' means no thinking at all, as on local models.
      if (/gemini-[34]/i.test(req.model)) {
        const level = req.effort === 'none' || req.effort === 'low' ? 'low' : req.effort === 'medium' ? 'medium' : 'high';
        generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: level };
      } else if (req.effort === 'none') {
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
      } else {
        const budget = req.effort === 'low' ? 2048 : req.effort === 'medium' ? 8192 : 16384;
        generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };
      }
    }
    return {
      project: this.project,
      model: req.model,
      requestType: 'agent',
      userAgent: 'antigravity',
      requestId: 'agent-' + randomUUID(),
      request: {
        contents: toGeminiContents(req),
        ...(req.system ? { systemInstruction: { role: 'user', parts: [{ text: req.system }] } } : {}),
        ...(req.tools.length
          ? {
              tools: [
                {
                  functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: cleanSchema(t.input_schema) })),
                },
              ],
            }
          : {}),
        generationConfig,
        sessionId: randomUUID(),
      },
    };
  }

  async complete(req: ModelRequest, onText: (t: string) => void, signal: AbortSignal): Promise<ModelResponse> {
    const url = this.endpoint.replace(/\/+$/, '') + '/v1internal:streamGenerateContent?alt=sse';
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': antigravityUserAgent(),
        },
        body: JSON.stringify(this.body(req)),
      });
    } catch (e) {
      if (signal.aborted) throw e;
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : e instanceof Error ? e.message : String(e);
      throw new ModelError(`model ${req.model}: ${this.endpoint} is not reachable: ${cause}`, true);
    }
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new GeminiError(geminiErrorText(res.status, raw), res.status === 429 || res.status >= 500, res.status, res.headers, raw);
    }

    const acc = new Answer(onText);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/event-stream')) {
      // A non-streaming answer (or an error body behind HTTP 200): parse it whole.
      const raw = await res.text();
      if (raw.trim()) {
        try {
          acc.feedJson(raw);
        } catch (e) {
          if (e instanceof ModelError) throw e;
          throw new ModelError(`Gemini plan: unreadable answer: ${raw.slice(0, 300)}`);
        }
      }
      return acc.done();
    }

    const decoder = new TextDecoder();
    let buf = '';
    const body = res.body;
    if (!body) throw new ModelError('Gemini plan: Cloud Code sent an empty answer.');
    for await (const chunk of body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '').trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          acc.feedJson(data);
        } catch (e) {
          if (e instanceof ModelError) throw e;
          throw new ModelError(`Gemini plan: unreadable stream chunk: ${data.slice(0, 300)}`);
        }
      }
    }
    const rest = buf.trim();
    if (rest.startsWith('data:')) {
      const data = rest.slice(5).trim();
      if (data && data !== '[DONE]') acc.feedJson(data);
    }
    return acc.done();
  }
}

/** The answer as it streams in: text goes out live, thinking and tool calls are kept for the transcript. */
class Answer {
  private text = '';
  private thought = '';
  private signature = '';
  private finish = 'unknown';
  private calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
  private usage = { input: 0, output: 0, cached: 0 };

  constructor(private onText: (t: string) => void) {}

  feedJson(raw: string): void {
    const j = JSON.parse(raw) as { response?: GeminiResponse; error?: { message?: string; status?: string } };
    if (j.error) throw new ModelError(`Gemini plan: Cloud Code answered an error: ${j.error.status ?? ''} ${j.error.message ?? ''}`.trim());
    const r = j.response ?? (j as GeminiResponse);
    const cand = r.candidates?.[0];
    if (cand?.finishReason) this.finish = cand.finishReason;
    for (const p of cand?.content?.parts ?? []) {
      if (p.functionCall) {
        this.calls.push({ id: p.functionCall.id ?? '', name: p.functionCall.name, args: p.functionCall.args ?? {} });
        if (p.thoughtSignature) this.signature ||= p.thoughtSignature;
      } else if (typeof p.text === 'string') {
        if (p.thought) {
          this.thought += p.text;
          if (p.thoughtSignature) this.signature ||= p.thoughtSignature;
        } else if (p.text) {
          this.text += p.text;
          this.onText(p.text);
        }
      }
    }
    const u = r.usageMetadata;
    if (u) {
      this.usage.input = u.promptTokenCount ?? this.usage.input;
      // Thinking tokens are output tokens (Anthropic counts them the same way).
      this.usage.output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
      this.usage.cached = u.cachedContentTokenCount ?? 0;
    }
  }

  done(): ModelResponse {
    const content: ContentBlock[] = [];
    // Gemini 3 checks a signature on the next call even when the model sent no thought text, so a signature gets an
    // empty thinking block (the card hides it, context.ts keeps it). Unsigned thinking still shows on the card;
    // context.ts never replays it.
    if (this.thought || this.signature) content.push({ type: 'thinking', thinking: this.thought, signature: this.signature });
    if (this.text) content.push({ type: 'text', text: this.text });
    for (const c of this.calls) content.push({ type: 'tool_use', id: c.id || 'call_' + randomUUID().slice(0, 8), name: c.name, input: c.args });
    return {
      content,
      stopReason: this.calls.length ? 'tool_use' : (STOP_REASONS[this.finish] ?? this.finish.toLowerCase()),
      usage: this.usage,
    };
  }
}
