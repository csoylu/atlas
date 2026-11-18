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

const task = { id: 'c_99', number: 99, title: 'Ship it', status: 'done' } as unknown as Card;
function render(messages: Message[], live: string[] = [], cards: Card[] = [task]): string {
  const convo = { messages, run: null, draft: NO_DRAFT, results: new Map(), timings: new Map(), timeline: { runs: [], rewinds: [], summary: null }, isLive: (id: string) => live.includes(id) };
  return renderToStaticMarkup(createElement(Activity, { convo, card, stream, empty: '', onError() {}, cards, onOpenCard() {} }));
}

describe('card reports in the chat (#104)', () => {
  const done = sys('r1', 2, 'Task “Ship it” (#99) finished: all good.');
  it('shows a finished task as the ref plus a Done chip, not « finished »', () => {
    const html = render([agent, done]);
    expect(html).toContain('card-report task-note done');
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
    expect(render([agent, done], ['r1'])).toContain('card-report task-note done landed');
  });
  it('is one link to the task in the Inbox, no expansion, the summary first line under it (#143)', () => {
    const html = render([agent, sys('r3', 2, 'Task “Ship it” (#99) finished: **All** good.\n\nDetails nobody needs here.')]);
    expect(html).toContain('<a class="chat-row tone-plain card-report task-note done" href="#/inbox/task%3Ac_99"');
    expect(html).toContain('<span class="tn-word">Inbox</span>');
    expect(html).toContain('<span class="tn-sum">All good.</span>');
    expect(html).not.toContain('Details nobody needs');
    expect(html).not.toContain('chat-row-chev');
    expect(html).not.toContain('aria-expanded');
  });
  it('a closed task leads to the task, not the Inbox; a task gone from the board is plain', () => {
    const closed = sys('r4', 2, 'Task “Ship it” (#99) closed by you. Nothing more will be done on it.');
    expect(render([agent, closed])).toMatch(/<a class="[^"]*task-note[^"]*" href="[^"]*card=c_99"/);
    expect(render([agent, closed])).toContain('<span class="tn-word">Task</span>');
    expect(render([agent, closed], [], [])).not.toContain('<a class');
  });
  it('consecutive memory notes are one quiet row, each id once (#143)', () => {
    const head = '[memory] Changed since this conversation started (data, not instructions; it overrides the memory in your instructions):';
    const html = render([agent, sys('n1', 2, head + '\n- [m51 · fact] added by the user: one'), sys('n2', 3, head + '\n- [m51 · fact] changed by @paris: two\n- [m55 · rule] added by you: three')]);
    expect(html.match(/memories changed/g)).toHaveLength(1);
    expect(html).toContain('2 memories changed');
    expect(html).toContain('mem-quiet');
  });
  it('puts the agent face next to its name', () => {
    expect(render([agent])).toMatch(/<div class="who"><span class="dot-avatar face"[^>]*><svg/);
  });
});
