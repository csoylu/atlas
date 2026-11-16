import { estimateTokens } from '../context.ts';
import type { ModelRequest, ModelResponse, Provider } from './types.ts';

/**
 * Scripted provider for tests: each call gets the next reply (or a function of the request). Usage is reported like a
 * real provider: input = the whole prompt (estimated), cached = the longest prefix an earlier call wrote to the cache,
 * simulating Anthropic's prompt caching (prefix order tools → system → messages; breakpoints only on `cache` requests:
 * after the stable system prefix, and after each of the last two user messages).
 */
export class FakeProvider implements Provider {
  calls: ModelRequest[] = [];
  /** Usage of each call, in order. */
  usages: ModelResponse['usage'][] = [];
  private cache = new Set<string>();
  constructor(private script: (ModelResponse['content'] | ((req: ModelRequest) => ModelResponse['content']))[]) {}

  async complete(req: ModelRequest, onText: (t: string) => void, signal: AbortSignal): Promise<ModelResponse> {
    this.calls.push(structuredClone(req));
    const step = this.script.shift();
    if (!step) throw new Error('FakeProvider: script exhausted');
    const usage = { input: estimateTokens(req.system) + estimateTokens(req.tools) + estimateTokens(req.messages), output: 1, cached: this.cached(req) };
    this.usages.push(usage);
    const content = typeof step === 'function' ? step(req) : step;
    for (const b of content) if (b.type === 'text') for (const w of b.text.split(/(?<= )/)) onText(w);
    await new Promise((r) => setTimeout(r, 1));
    signal.throwIfAborted();
    // A provider-run tool left without its result: Anthropic pauses the turn (pause_turn) for the caller to continue it.
    const answered = new Set(content.flatMap((b) => (b.type === 'web_search_tool_result' ? [b.tool_use_id] : [])));
    const paused = content.some((b) => b.type === 'server_tool_use' && !answered.has(b.id));
    const stopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : paused ? 'pause_turn' : 'end_turn';
    return { content, stopReason, usage };
  }

  /** Read the longest cached prefix, then write this request's breakpoints. */
  private cached(req: ModelRequest): number {
    if (!req.cache) return 0;
    const tools = JSON.stringify(req.tools);
    const prefixes = [tools + req.system.slice(0, req.cache.systemStable)];
    const users = req.messages.flatMap((m, i) => (m.role === 'user' ? [i] : [])).slice(-2);
    for (const i of users) prefixes.push(tools + req.system + JSON.stringify(req.messages.slice(0, i + 1)));
    const hit = prefixes.filter((p) => this.cache.has(p)).reduce((n, p) => Math.max(n, estimateTokens(p)), 0);
    for (const p of prefixes) this.cache.add(p);
    return hit;
  }
}
