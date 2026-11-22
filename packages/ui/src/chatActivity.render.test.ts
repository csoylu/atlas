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
