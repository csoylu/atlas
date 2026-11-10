import type { ContentBlock } from '@atlas/shared';
import { CHATGPT_USAGE_URL } from '@atlas/shared';
import { ModelError, type ModelRequest, type ModelResponse, type Provider } from './types.ts';

/** Atlas's tools go to the model as one namespace (ChatGPT plan usage accepts function tools only inside one). */
export const NAMESPACE = 'atlas';

type InputItem =
  | { role: 'user'; content: { type: 'input_text'; text: string }[] }
  | { role: 'assistant'; content: { type: 'output_text'; text: string }[] }
  | { type: 'function_call'; call_id: string; name: string; namespace: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/**
 * Anthropic-shaped transcript → Responses API input items. The system prompt goes in `instructions` (system message
 * items are rejected on this route); thinking blocks are not sent (store: false keeps no reasoning server-side).
 */
export function toResponsesInput(req: ModelRequest): InputItem[] {
  const out: InputItem[] = [];
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      if (text) out.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const b of m.content)
        if (b.type === 'tool_use')
          out.push({ type: 'function_call', call_id: b.id, name: b.name, namespace: NAMESPACE, arguments: JSON.stringify(b.input ?? {}) });
    } else {
      for (const b of m.content) if (b.type === 'tool_result') out.push({ type: 'function_call_output', call_id: b.tool_use_id, output: b.content });
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n\n');
      if (text) out.push({ role: 'user', content: [{ type: 'input_text', text }] });
    }
  }
  return out;
}

/** The request body. Only fields this route accepts: store false, stream true, no max_output_tokens/temperature. */
export function responsesBody(req: ModelRequest): Record<string, unknown> {
  return {
    model: req.model,
    instructions: req.system,
    input: toResponsesInput(req),
    ...(req.tools.length
      ? {
          tools: [
            {
              type: 'namespace',
              name: NAMESPACE,
              description: 'Atlas tools: files and shell in the agent workspace, cards, canvas, team.',
              tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema })),
            },
          ],
        }
      : {}),
    ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
    store: false,
    stream: true,
  };
}

/** What a call needs from the signed-in account (chatgpt.ts): a fresh token, and hooks for errors OpenAI defines. */
export interface PlanAccess {
  /** A valid access token (refreshed when near expiry); throws a ModelError when signed out or not allowed. */
  token(): Promise<string>;
  /** The usage limit was reached: pause new requests until Can resumes. */
  limitReached(): void;
  /** The token was refused: the sign-in must be done again. */
  signedOut(reason: string): void;
}

const LIMIT = `ChatGPT plan usage limit reached (your plan's or Atlas's own app limit). Requests are paused: review it at ${CHATGPT_USAGE_URL}, then Resume on the Models page.`;

/** One error code → what Can reads on the card, whether it may clear by itself, and its side effect. */
function planError(code: string | undefined, status: number, message: string, access: PlanAccess): ModelError {
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      access.limitReached();
      return new ModelError(LIMIT);
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return new ModelError(`ChatGPT plan: usage could not be checked right now (${code}); try again later`, true);
    case 'subscription_sharing_user_not_eligible':
      return new ModelError('ChatGPT plan usage is not available for this account or workspace (subscription_sharing_user_not_eligible)');
    case 'subscription_sharing_invalid_user':
      access.signedOut('ChatGPT refused the sign-in (subscription_sharing_invalid_user)');
      return new ModelError('ChatGPT refused the sign-in: sign in again on the Models page');
    case 'subscription_sharing_unsupported_capability':
      return new ModelError(`ChatGPT plan: unsupported request part (${message})`);
  }
  if (status === 401) {
    access.signedOut(`ChatGPT refused the access token (HTTP 401: ${message})`);
    return new ModelError(`ChatGPT refused the access token (HTTP 401: ${message}): sign in again on the Models page`);
  }
  return new ModelError(`ChatGPT plan: HTTP ${status}${code ? ` ${code}` : ''}: ${message}`, status === 429 || status >= 500);
}

/** OpenAI models on Can's ChatGPT plan: POST /v1/responses with the OAuth access token (design §5). */
export class ChatGptProvider implements Provider {
  constructor(
    private access: PlanAccess,
    private apiBase = 'https://api.openai.com/v1',
    private fetchFn: typeof fetch = fetch,
  ) {}

  async complete(req: ModelRequest, onText: (t: string) => void, signal: AbortSignal): Promise<ModelResponse> {
    const token = await this.access.token();
    let res: Response;
    try {
      res = await this.fetchFn(this.apiBase + '/responses', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify(responsesBody(req)),
      });
    } catch (e) {
      if (signal.aborted) throw e;
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : String(e);
      throw new ModelError(`ChatGPT is not reachable: ${cause}`, true);
    }
    if (!res.ok || !res.body) {
      // Admission errors may be {detail} instead of the API's {error: {code, message}}.
      const raw = await res.text();
      let code: string | undefined;
      let message = raw.slice(0, 400);
      try {
        const j = JSON.parse(raw) as { error?: { code?: string; message?: string; param?: string }; detail?: unknown };
        if (j.error) {
          code = j.error.code ?? undefined;
          message = [j.error.message, j.error.param && `param ${j.error.param}`].filter(Boolean).join(', ') || message;
        } else if (j.detail) message = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
      } catch {
        // not JSON: keep the raw text
      }
      const rid = res.headers.get('x-request-id');
      throw planError(code, res.status, message + (rid ? ` (request ${rid})` : ''), this.access);
    }

    let text = '';
    const calls: { id: string; name: string; args: string }[] = [];
    const usage = { input: 0, output: 0, cached: 0 };
    let done: 'completed' | 'incomplete' | null = null;
    let incomplete = '';
    const decoder = new TextDecoder();
    let buf = '';
    const handle = (ev: {
      type?: string;
      delta?: string;
      item?: { type?: string; call_id?: string; name?: string; arguments?: string };
      response?: { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } }; error?: { code?: string; message?: string }; incomplete_details?: { reason?: string } };
      code?: string;
      message?: string;
    }) => {
      switch (ev.type) {
        case 'response.output_text.delta':
          if (ev.delta) {
            text += ev.delta;
            onText(ev.delta);
          }
          break;
        case 'response.output_item.done':
          if (ev.item?.type === 'function_call') calls.push({ id: ev.item.call_id ?? '', name: ev.item.name ?? '', args: ev.item.arguments ?? '' });
          break;
        case 'response.completed':
        case 'response.incomplete':
          usage.input = ev.response?.usage?.input_tokens ?? 0;
          usage.output = ev.response?.usage?.output_tokens ?? 0;
          usage.cached = ev.response?.usage?.input_tokens_details?.cached_tokens ?? 0;
          done = ev.type === 'response.completed' ? 'completed' : 'incomplete';
          incomplete = ev.response?.incomplete_details?.reason ?? '';
          break;
        case 'response.failed': {
          const err = ev.response?.error;
          throw planError(err?.code, 200, err?.message ?? 'response failed', this.access);
        }
        case 'error':
          throw planError(ev.code, 200, ev.message ?? 'stream error', this.access);
      }
    };
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        handle(JSON.parse(data));
      }
    }
    // Success is only a completed response; a stream that just stops is an error, not an answer.
    if (!done) throw new ModelError('ChatGPT: the response stream ended before it completed', true);

    const content: ContentBlock[] = [];
    if (text) content.push({ type: 'text', text });
    for (const c of calls) {
      let input: unknown;
      try {
        input = c.args ? JSON.parse(c.args) : {};
      } catch {
        input = { _invalid_json: c.args };
      }
      content.push({ type: 'tool_use', id: c.id, name: c.name, input });
    }
    const stopReason = calls.length ? 'tool_use' : done === 'incomplete' ? `incomplete: ${incomplete || 'unknown'}` : 'end_turn';
    return { content, stopReason, usage };
  }
}
