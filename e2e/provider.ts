import type { ContentBlock } from '@atlas/shared';
import type { ModelRequest, ModelResponse, OnDelta, Provider } from '../packages/engine/src/providers/types.ts';

/**
 * The model of the E2E suite: deterministic, and it answers from what it was actually SENT, so a test can read the
 * agent's view in the chat itself.
 *
 * Agent turns (the request has tools), by the last user text:
 *   HANG ...        streams « working… » then never ends until the run is aborted (a run in progress).
 *   RECALL          answers « I see: <every user text in my view> | summary: <summary in my view, or none> ».
 *   SEARCH <word>   calls history_search {query: word}; then answers « FOUND: <tool result> ».
 *   anything else   « ack: <text> ».
 * One-shot calls: the summary (/compact) answers « SUMMARY[focus=<focus or none>] <the user lines it was given> », the
 * chat title « E2E chat ». Every request is kept in `calls`, tagged with its kind.
 */
export type CallKind = 'turn' | 'summary' | 'title' | 'other';
export interface Call {
  kind: CallKind;
  req: ModelRequest;
  /** The text of every block of the view, flattened. */
  view: string;
}

const textOf = (blocks: ContentBlock[]) => blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');

export class E2EProvider implements Provider {
  calls: Call[] = [];

  kindOf(req: ModelRequest): CallKind {
    if (req.system.startsWith('You compress')) return 'summary';
    if (req.system.startsWith('You name a chat')) return 'title';
    return req.tools.length ? 'turn' : 'other';
  }

  turns(): Call[] {
    return this.calls.filter((c) => c.kind === 'turn');
  }

  async complete(req: ModelRequest, onText: OnDelta, signal: AbortSignal): Promise<ModelResponse> {
    const kind = this.kindOf(req);
    this.calls.push({ kind, req: structuredClone(req), view: req.messages.map((m) => textOf(m.content)).join('\n---\n') });
    const done = (content: ContentBlock[], stopReason = 'end_turn'): ModelResponse => ({ content, stopReason, usage: { input: 100, output: 10 } });
    const say = (t: string) => {
      onText(t, 'text');
      return done([{ type: 'text', text: t }]);
    };
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    // The view may put the summary and the user's text in one message (separate blocks): the user's words are the last block.
    const last = lastUser ? (lastUser.content.filter((b) => b.type === 'text').at(-1) as { text: string } | undefined)?.text ?? '' : '';

    if (kind === 'summary') {
      const body = textOf(req.messages[0]!.content);
      const focus = /with this focus: (.*)$/m.exec(body)?.[1] ?? 'none';
      const users = body.split(/\n\n(?=#\d+ )/).flatMap((chunk) => {
        const m = /^#\d+ user:\n([\s\S]*)$/.exec(chunk);
        return m ? [m[1]!.split('\n\nThe user asked for this summary')[0]!.replace(/\n\nWrite the updated summary\.$/, '').trim()] : [];
      });
      return say(`SUMMARY[focus=${focus}] ${users.join(' / ') || 'nothing'}`);
    }
    if (kind === 'title') return say('E2E chat');
    if (kind === 'other') return say('ok');

    // A tool result just came back: report it.
    const result = lastUser?.content.find((b) => b.type === 'tool_result');
    if (result && result.type === 'tool_result') return say('FOUND: ' + (typeof result.content === 'string' ? result.content : JSON.stringify(result.content)));

    if (last.startsWith('HANG')) {
      onText('working… ', 'text');
      await new Promise<void>((_, reject) => {
        const stop = () => reject(signal.reason ?? new Error('aborted'));
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      });
    }
    if (last.startsWith('SEARCH ')) {
      const q = last.slice(7).trim();
      onText('searching… ', 'text');
      return done([{ type: 'tool_use', id: 'tu_' + this.calls.length, name: 'history_search', input: { query: q } }], 'tool_use');
    }
    if (last.startsWith('RECALL')) {
      const users = req.messages.filter((m) => m.role === 'user').flatMap((m) => m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text));
      const summary = users.find((u) => u.startsWith('Summary of the earlier part'));
      const seen = users.filter((u) => u !== summary && !u.startsWith('RECALL') && !u.startsWith('Your todo list'));
      return say(`I see: ${seen.join(' | ') || 'nothing'} ; summary: ${summary ? summary.split('\n\n').slice(1).join(' ') : 'none'}`);
    }
    return say('ack: ' + last);
  }
}
