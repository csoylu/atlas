import type { ModelRequest, ModelResponse, Provider } from './types.ts';

/** Scripted provider for tests: each call gets the next reply (or a function of the request). */
export class FakeProvider implements Provider {
  calls: ModelRequest[] = [];
  constructor(private script: (ModelResponse['content'] | ((req: ModelRequest) => ModelResponse['content']))[]) {}

  async complete(req: ModelRequest, onText: (t: string) => void, signal: AbortSignal): Promise<ModelResponse> {
    this.calls.push(structuredClone(req));
    const step = this.script.shift();
    if (!step) throw new Error('FakeProvider: script exhausted');
    const content = typeof step === 'function' ? step(req) : step;
    for (const b of content) if (b.type === 'text') for (const w of b.text.split(/(?<= )/)) onText(w);
    await new Promise((r) => setTimeout(r, 1));
    signal.throwIfAborted();
    return { content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input: 1, output: 1 } };
  }
}
