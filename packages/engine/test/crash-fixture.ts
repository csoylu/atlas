import { randomUUID } from 'node:crypto';
import type { ModelRequest, ModelResponse, Provider } from '../src/providers/types.ts';

export const STEPS = 4;
export const LEASE_MS = 300;

/** Deterministic slow agent: runs STEPS shell commands one by one, then says 'finished'. */
export class SlowProvider implements Provider {
  constructor(private marker: string) {}
  async complete(req: ModelRequest, onText: (t: string) => void, signal: AbortSignal): Promise<ModelResponse> {
    await new Promise((r) => setTimeout(r, 20));
    signal.throwIfAborted();
    const done = req.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result' && b.content.startsWith('exit 0')).length;
    if (done >= STEPS) {
      onText('finished');
      return { content: [{ type: 'text', text: 'finished' }], stopReason: 'end_turn', usage: { input: 1, output: 1 } };
    }
    return {
      content: [{ type: 'tool_use', id: 't_' + randomUUID().slice(0, 8), name: 'shell', input: { command: `sleep 0.15 # ${this.marker}` } }],
      stopReason: 'tool_use',
      usage: { input: 1, output: 1 },
    };
  }
}
