import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CARET, NO_DRAFT, addDelta, draftMarkdown, openFence, rehypeCaret } from './streamDraft.ts';

const html = (draft: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeCaret] }, draftMarkdown(draft)));
const CARET_HTML = '<span class="caret" aria-hidden="true"></span>';

describe('openFence', () => {
  it('finds an unclosed fence, ignores closed ones', () => {
    expect(openFence('text')).toBeNull();
    expect(openFence('```ts\nconst a = 1;')).toBe('```');
    expect(openFence('```ts\na\n```\nmore')).toBeNull();
    expect(openFence('~~~~\nx\n```')).toBe('~~~~'); // a ``` doesn't close a ~~~~ fence
    expect(openFence('````\nx\n```')).toBe('````'); // nor a shorter one
    expect(openFence('  ```\nx')).toBe('  ```');
    expect(openFence('```a`b')).toBeNull(); // not a fence
  });
});

describe('draftMarkdown + rehypeCaret', () => {
  it('puts the caret inline at the end of the last block', () => {
    expect(html('Hello **world**')).toBe(`<p>Hello <strong>world</strong>${CARET_HTML}</p>`);
    expect(html('- a\n- b')).toBe(`<ul>\n<li>a</li>\n<li>b${CARET_HTML}</li>\n</ul>`);
    expect(html('# Title')).toBe(`<h1>Title${CARET_HTML}</h1>`);
  });

  it('shows an unclosed code fence as a code block, caret inside', () => {
    const out = html('Look:\n```ts\nconst a = 1;');
    expect(out).toContain('<pre><code class="language-ts">const a = 1;' + CARET_HTML);
    expect(out).not.toContain('```');
  });

  it('formats a table while it streams', () => {
    const out = html('| a | b |\n|---|---|\n| 1 | 2');
    expect(out).toContain('<table>');
    expect(out).toContain(CARET_HTML);
  });

  it('partial syntax renders as text without throwing, the marker never leaks', () => {
    for (const d of ['**bold', '[link](http://exa', '| a |\n|--', '`code', '1. ', '> quote\n', 'a\n\n', '~~~']) {
      const out = html(d);
      expect(out).not.toContain(CARET);
      expect(out).toContain(CARET_HTML);
    }
  });

  it('only the caret differs from the finished message', () => {
    const md = '## Plan\n\n1. **One**: [x](https://x.y)\n2. Two\n\n| k | v |\n|---|---|\n| a | 1 |\n\n```js\nf()\n```\n\nDone.';
    const final = renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, md));
    expect(html(md).replace(CARET_HTML, '')).toBe(final);
  });
});

describe('addDelta (#80)', () => {
  it('keeps the stream order: thinking, then text; same-kind deltas extend the last part', () => {
    let d = NO_DRAFT;
    d = addDelta(d, 'thinking', 'Let me ', 't0');
    d = addDelta(d, 'thinking', 'see.', 't1');
    d = addDelta(d, 'text', '', 't2'); // empty deltas are ignored
    d = addDelta(d, 'text', 'Hi ', 't3');
    d = addDelta(d, 'text', 'there.', 't4');
    expect(d).toEqual([
      { kind: 'thinking', text: 'Let me see.', at: 't0' },
      { kind: 'text', text: 'Hi there.', at: 't3' },
    ]);
    expect(NO_DRAFT).toEqual([]); // never mutated
  });

  it('interleaved thinking starts a new part', () => {
    const d = ['thinking', 'text', 'thinking'].reduce((acc, k) => addDelta(acc, k as 'text' | 'thinking', k, 't'), NO_DRAFT);
    expect(d.map((p) => p.kind)).toEqual(['thinking', 'text', 'thinking']);
  });
});
