import type { ContentBlock } from '@atlas/shared';
import type { ModelRequest, ModelResponse, OnDelta, Provider } from '../../packages/engine/src/providers/types.ts';

export type Kind = 'main' | 'summary' | 'title';
export interface Call {
  kind: Kind;
  req: ModelRequest;
  /** Everything the model was sent, flattened to text: for « does it contain X » checks. */
  text: string;
}
export type Reply = ContentBlock[] | ((req: ModelRequest, n: number) => ContentBlock[]);

export const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
export const shell = (command: string, id = 't' + Math.random().toString(36).slice(2, 8)): ContentBlock[] => [{ type: 'tool_use', id, name: 'shell', input: { command } }];

/**
 * The model of an e2e engine. Every call is recorded and classified: the agent's own turns ('main'), /compact's
 * summarizer ('summary') and the chat-naming call ('title'). Main turns take the next queued reply, else answer
 * « Reply N to: <last user message> ». Summaries answer « SUMMARY<k>[focus]: ... » so tests can read the focus back.
 */
export class Scripted implements Provider {
  calls: Call[] = [];
  private queue: Reply[] = [];
  private mains = 0;
  private sums = 0;

  /** The next main turns answer these, in order. */
  next(...replies: Reply[]): this {
    this.queue.push(...replies);
    return this;
  }
  of(kind: Kind): Call[] {
    return this.calls.filter((c) => c.kind === kind);
  }
  get lastMain(): Call {
    return this.of('main').at(-1)!;
  }

  async complete(req: ModelRequest, onText: OnDelta, signal: AbortSignal): Promise<ModelResponse> {
    const first = JSON.stringify(req.messages[0]?.content ?? '');
    const kind: Kind = req.tools.length === 0 && first.includes('Write the updated summary.') ? 'summary' : req.tools.length === 0 && first.includes('Write the title.') ? 'title' : 'main';
    const call: Call = { kind, req: structuredClone(req), text: req.system + '\n' + JSON.stringify(req.messages) };
    this.calls.push(call);
    let content: ContentBlock[];
    if (kind === 'title') content = text('Scripted chat');
    else if (kind === 'summary') {
      const focus = /with this focus: ([^"\\]*)/.exec(first)?.[1];
      content = text(`SUMMARY${++this.sums}${focus ? ` [focus: ${focus.trim()}]` : ''}: the conversation so far, condensed.`);
    } else {
      const n = ++this.mains;
      const r = this.queue.shift();
      content = r ? (typeof r === 'function' ? r(req, n) : r) : text(`Reply ${n} to: ${lastUserText(req)}`);
    }
    for (const b of content) if (b.type === 'text') for (const w of b.text.split(/(?<= )/)) onText(w, 'text');
    await new Promise((r) => setTimeout(r, 5));
    signal.throwIfAborted();
    const stopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    return { content, stopReason, usage: { input: Math.ceil(call.text.length / 4), output: 10 } };
  }
}

/** The text of the last user message that carries any (tool results don't count). */
export function lastUserText(req: ModelRequest): string {
  for (const m of [...req.messages].reverse()) {
    if (m.role !== 'user') continue;
    const t = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(' ');
    if (t) return t;
  }
  return '';
}
