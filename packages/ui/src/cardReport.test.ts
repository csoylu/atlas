import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Card, Message } from '@atlas/shared';
import { Activity } from './CardPanel.tsx';
import type { MessageStream } from './useMessages.ts';
import { NO_DRAFT } from './streamDraft.ts';

/** #104: a finished task's report reads « #99 [Done] », and only a report that arrived live gets the arrival animation. */
const AT = '2026-11-18T10:00:00.000Z';
const card = { id: 'c1', conversationId: 'cv1', assignee: 'munih', status: 'ready', block: null, board: 'direct' } as unknown as Card;
const stream: MessageStream = { push() {}, listen: () => () => {} };
const sys = (id: string, seq: number, text: string): Message => ({ id, conversationId: 'cv1', seq, role: 'user', author: 'system', content: [{ type: 'text', text }], at: AT });
const agent: Message = { id: 'a1', conversationId: 'cv1', seq: 1, role: 'assistant', author: 'munih', content: [{ type: 'text', text: 'On it.' }], at: AT };

function render(messages: Message[], live: string[] = []): string {
  const convo = { messages, run: null, draft: NO_DRAFT, results: new Map(), timings: new Map(), timeline: { runs: [], rewinds: [], summary: null }, isLive: (id: string) => live.includes(id) };
  return renderToStaticMarkup(createElement(Activity, { convo, card, stream, empty: '', onError() {} }));
}

describe('card reports in the chat (#104)', () => {
  const done = sys('r1', 2, 'Task “Ship it” (#99) finished: all good.');
  it('shows a finished task as the ref plus a Done chip, not « finished »', () => {
    const html = render([agent, done]);
    expect(html).toContain('card-report done');
    expect(html).toContain('<span class="st-chip done">Done</span>');
    expect(html).not.toContain('finished');
  });
  it('keeps the verb for other reports', () => {
    const html = render([agent, sys('r2', 2, 'Task “Ship it” (#99) is blocked: needs a key.')]);
    expect(html).toContain('blocked');
    expect(html).not.toContain('st-chip');
  });
  it('animates only a report that arrived live, never one loaded with the history', () => {
    expect(render([agent, done])).not.toContain('landed');
    expect(render([agent, done], ['r1'])).toContain('card-report done landed');
  });
  it('puts the agent face next to its name', () => {
    expect(render([agent])).toMatch(/<div class="who"><span class="dot-avatar face"[^>]*><svg/);
  });
});
