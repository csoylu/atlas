import { estimateTokens } from '../context.ts';
import type { ModelRequest, ModelResponse, OnDelta, Provider } from './types.ts';

/**
 * Scripted provider for tests: each call gets the next reply (or a function of the request). Usage is reported like a
 * real provider: input = the whole prompt (estimated), cached = the longest prefix an earlier call wrote to the cache,
 * simulating Anthropic's prompt caching (prefix order tools → system → messages; breakpoints only on `cache` requests:
 * after the stable system prefix, and after each of the last two user messages, the last `cache.tail` messages left
 * out); cacheWrite = the longest prefix this call wrote beyond what it read.
 */
export class FakeProvider implements Provider {
  calls: ModelRequest[] = [];
  /** Usage of each call, in order. */
  usages: ModelResponse['usage'][] = [];
  private cache = new Set<string>();
  /** A step: the reply's content, a function of the request, or a reply with a forced stop reason (`max_tokens`: a turn cut at the output limit, #274). */
  constructor(private script: (ModelResponse['content'] | ((req: ModelRequest) => ModelResponse['content']) | { content: ModelResponse['content']; stopReason: string; output?: number })[]) {}

  async complete(req: ModelRequest, onText: OnDelta, signal: AbortSignal): Promise<ModelResponse> {
    this.calls.push(structuredClone(req));
    const step = this.script.shift();
    if (!step) throw new Error('FakeProvider: script exhausted');
    const forced = typeof step === 'function' || Array.isArray(step) ? null : step;
    const usage = { input: estimateTokens(req.system) + estimateTokens(req.tools) + estimateTokens(req.messages), output: forced?.output ?? 1, ...this.cached(req) };
    this.usages.push(usage);
    const content = forced ? forced.content : typeof step === 'function' ? step(req) : (step as ModelResponse['content']);
    for (const b of content) {
      if (b.type === 'thinking' && b.thinking) onText(b.thinking, 'thinking');
      if (b.type === 'text') for (const w of b.text.split(/(?<= )/)) onText(w, 'text');
    }
    await new Promise((r) => setTimeout(r, 1));
    signal.throwIfAborted();
    // A provider-run tool left without its result: Anthropic pauses the turn (pause_turn) for the caller to continue it.
    const answered = new Set(content.flatMap((b) => (b.type === 'web_search_tool_result' ? [b.tool_use_id] : [])));
    const paused = content.some((b) => b.type === 'server_tool_use' && !answered.has(b.id));
    const stopReason = forced ? forced.stopReason : content.some((b) => b.type === 'tool_use') ? 'tool_use' : paused ? 'pause_turn' : 'end_turn';
    return { content, stopReason, usage };
  }

  /** Read the longest cached prefix, then write this request's breakpoints. */
  private cached(req: ModelRequest): { cached: number; cacheWrite: number } {
    if (!req.cache) return { cached: 0, cacheWrite: 0 };
    const tools = JSON.stringify(req.tools);
    const prefixes = [tools + req.system.slice(0, req.cache.systemStable)];
    const marked = req.messages.slice(0, req.messages.length - (req.cache.tail ?? 0));
    const users = marked.flatMap((m, i) => (m.role === 'user' ? [i] : [])).slice(-2);
    for (const i of users) prefixes.push(tools + req.system + JSON.stringify(req.messages.slice(0, i + 1)));
    const hit = prefixes.filter((p) => this.cache.has(p)).reduce((n, p) => Math.max(n, estimateTokens(p)), 0);
    const longest = prefixes.reduce((n, p) => Math.max(n, estimateTokens(p)), 0);
    for (const p of prefixes) this.cache.add(p);
    return { cached: hit, cacheWrite: Math.max(0, longest - hit) };
  }
}
