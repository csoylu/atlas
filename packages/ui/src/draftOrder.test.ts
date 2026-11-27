import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Card, ContentBlock, Message } from '@atlas/shared';
import { Activity } from './CardPanel.tsx';
import type { MessageStream } from './useMessages.ts';
import { NO_DRAFT, type Draft } from './streamDraft.ts';

/** The chat as rendered while the answer streams (a draft) and after it lands (#80): same layout, thinking first. */
const AT = '2026-11-16T10:00:00.000Z';
const card = { id: 'c1', conversationId: 'cv1', assignee: 'atlas', status: 'running', block: null, board: 'direct' } as unknown as Card;
const stream: MessageStream = { push() {}, listen: () => () => {} };
let seq = 0;
const msg = (role: 'user' | 'assistant', author: string, content: ContentBlock[]): Message => ({ id: 'm' + ++seq, conversationId: 'cv1', seq, role, author, content, at: AT });
const user = msg('user', 'user', [{ type: 'text', text: 'hello' }]);
const thinking: ContentBlock = { type: 'thinking', thinking: 'Let me see.', signature: 's' };
const reply: ContentBlock = { type: 'text', text: 'Hi there.' };

function render(messages: Message[], draft: Draft): string {
  const convo = { messages, run: null, draft, results: new Map(), timings: new Map(), timeline: { runs: [], rewinds: [], summary: null }, isLive: () => false };
  const html = renderToStaticMarkup(createElement(Activity, { convo, card, stream, empty: '', onError() {} }));
  // What only differs by streaming: the caret, the streaming class, React's generated ids, the seq a landed message
  // carries for memory source links (#82).
  // Quote attributes (#367) come with the landed message: a streaming text can't be quoted yet.
  return html.replace('<span class="caret" aria-hidden="true"></span>', '').replace(' streaming', '').replace(/ (id|aria-controls|data-seq|data-qseq|data-qblock|data-qwho)="[^"]*"/g, '');
}

describe('streaming thinking (#80)', () => {
  it('a thinking-only draft shows the live « Thinking » row, no text yet', () => {
    const html = render([user], [{ kind: 'thinking', text: 'Let me see.', at: AT }]);
    expect(html).toContain('Thinking');
    expect(html).toContain('chat-row-spin');
    expect(html).not.toContain('Hi there.');
  });

  it('as its own message: thinking above the text, then the landed message renders the same', () => {
    const live = render([user], [
      { kind: 'thinking', text: 'Let me see.', at: AT },
      { kind: 'text', text: 'Hi there.', at: AT },
    ]);
    expect(live.indexOf('Thought')).toBeGreaterThan(-1);
    expect(live.indexOf('Thought')).toBeLessThan(live.indexOf('Hi there.'));
    const landed = render([user, msg('assistant', 'atlas', [thinking, reply])], NO_DRAFT);
    expect(live).toBe(landed);
  });

  it('joined to the agent turn: thinking above the text there too, same layout once landed', () => {
    const before = msg('assistant', 'atlas', [{ type: 'text', text: 'First.' }]);
    const live = render([user, before], [
      { kind: 'thinking', text: 'Let me see.', at: AT },
      { kind: 'text', text: 'Hi there.', at: AT },
    ]);
    expect(live.match(/class="msg assistant/g)).toHaveLength(1); // joined, not a second bubble
    expect(live.indexOf('First.')).toBeLessThan(live.indexOf('Thought'));
    expect(live.indexOf('Thought')).toBeLessThan(live.indexOf('Hi there.'));
    const landed = render([user, before, msg('assistant', 'atlas', [thinking, reply])], NO_DRAFT);
    expect(live).toBe(landed);
  });
});
