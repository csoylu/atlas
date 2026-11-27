import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message } from '@atlas/shared';
import { Turn } from './ChatActivity.tsx';
import type { ToolOutcome } from './toolRows.ts';

const use = (id: string, name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id, name, input });
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const ok = (content: string): ToolOutcome => ({ content, isError: false });

describe('an old chat with canvas tool steps (#342)', () => {
  it('renders them as plain steps: no error, no artifact card, no link', () => {
    const message: Message = {
      id: 'm1',
      conversationId: 'c',
      seq: 1,
      role: 'assistant',
      author: 'atlas',
      at: '2026-11-14T17:00:00.000Z',
      content: [
        text('Drawing it.'),
        use('a', 'canvas_create', { name: 'Old board' }),
        text('Updating it.'),
        use('b', 'canvas_write', { id: 'cv_a0bd7384', show: ['n1'] }),
        text('Showing it.'),
        use('c', 'panel_open', { canvas: 'cv_a0bd7384' }),
      ],
    } as Message;
    const results = new Map([
      ['a', ok('created cv_a0bd7384')],
      ['b', ok('canvas cv_a0bd7384 is now v2 with 1 node; shown inline: n1')],
      ['c', ok('opened canvas')],
    ]);
    const html = renderToString(
      createElement(Turn, {
        messages: [message],
        results,
        timings: new Map(),
        live: false,
        last: true,
        stream: { push: () => {}, listen: () => () => {} },
        renderText: (t: string) => t,
      }),
    );
    expect(html).toContain('Created canvas');
    expect(html).toContain('Updated canvas');
    expect(html).toContain('Opened in the panel');
    expect(html).not.toContain('href');
    expect(html).not.toContain('art-text'); // the artifact card's body
  });
});

describe('a live « N steps » box (#382)', () => {
  const message = (content: ContentBlock[]): Message => ({ id: 'm1', conversationId: 'c', seq: 1, role: 'assistant', author: 'atlas', at: '2026-11-14T17:00:00.000Z', content }) as Message;
  const render = (content: ContentBlock[], results: Map<string, ToolOutcome>, live: boolean, tail?: string) =>
    renderToString(
      createElement(Turn, {
        messages: [message(content)],
        results,
        timings: new Map(content.flatMap((b) => (b.type === 'tool_use' ? [[b.id, { startedAt: '2026-11-14T17:00:00.000Z', ...(results.has(b.id) ? { endedAt: '2026-11-14T17:00:01.000Z' } : { tail }) }] as const] : []))),
        live,
        last: true,
        stream: { push: () => {}, listen: () => () => {} },
        renderText: (t: string) => t,
      }),
    );

  it('is one closed live group from the first call, a running shell opens nothing, the ticker shows the call', () => {
    const one = render([use('a', 'shell', { command: 'npm test' })], new Map(), true, 'line 1\nPASS chatTurn.test.ts\n');
    expect(one).toContain('chat-row tone-plain running steps live');
    expect(one).toContain('Working');
    expect(one).not.toContain('chat-row-body'); // no autoOpen: the live tail stays folded
    expect(one).toContain('steps-tick');
    expect(one).toContain('PASS chatTurn.test.ts'); // the tail's last line in the ticker
    const many = render([use('a', 'read_file', { path: 'x.ts' }), use('b', 'shell', { command: 'npm test' }), use('c', 'shell', { command: 'npm run typecheck' })], new Map([['a', ok('1|x')], ['b', ok('exit 0\n')]]), true);
    expect(many).toContain('steps live');
    expect(many).toContain('3 steps');
    expect(many).not.toContain('chat-row-body');
  });

  it('between two calls the ticker shows the last call, idle; a finished turn has no ticker', () => {
    const calls = [use('a', 'read_file', { path: 'x.ts' }), use('b', 'grep', { pattern: 'y' })];
    const between = render(calls, new Map([['a', ok('1|x')], ['b', ok('no matches')]]), true);
    expect(between).toContain('steps live');
    expect(between).toContain('steps-tick idle');
    const over = render(calls, new Map([['a', ok('1|x')], ['b', ok('no matches')]]), false);
    expect(over).not.toContain('steps live');
    expect(over).not.toContain('steps-tick');
  });
});
