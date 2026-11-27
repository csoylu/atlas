import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import Markdown from 'react-markdown';
import { describe, expect, it } from 'vitest';
import { formatComment, formatQuote, type Message } from '@atlas/shared';
import { isQuote, readComments, renumber, toPost, toQuote, withQuote, writeComments, type ChipDraft, type CommentDraft, type QuoteSource } from './comments.ts';
import { UserContent } from './CommentCards.tsx';
import { codeLines, isQuoteKey, rehypeQuoteMarks, type QuoteMark } from './quoteMarks.ts';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const src = (seq: number, passage: string): QuoteSource => ({ at: { kind: 'message', seq, block: 0 }, who: 'atlas', passage, code: false });
const comment = (n: number): CommentDraft => ({
  id: 'c' + n,
  n,
  target: { kind: 'doc', docId: 'doc_1', version: 2 },
  anchor: { type: 'lines', from: 1, to: 2 },
  text: 'note',
  title: 'T',
  kind: 'markdown',
  mark: { style: 'hl', lines: [1, 2] },
  thumb: null,
});

describe('quote chips (#367)', () => {
  it('share one numbering with comments, in the order added; the same passage twice adds nothing; × renumbers; kept per chat', () => {
    let l: ChipDraft[] = [comment(1)];
    l = withQuote(l, src(4, 'quotes reuse the chips'), 'Yes');
    l = withQuote(l, src(4, 'quotes reuse the chips'), 'again');
    l = withQuote(l, src(6, 'Tool output is left out'), '');
    expect(l.map((c) => [c.n, isQuote(c) ? c.quote.passage : 'comment'])).toEqual([
      [1, 'comment'],
      [2, 'quotes reuse the chips'],
      [3, 'Tool output is left out'],
    ]);
    const after = renumber(l.slice(1));
    expect(after.map((c) => c.n)).toEqual([1, 2]);
    expect(toQuote(after[1] as Extract<ChipDraft, { quote: unknown }>)).toEqual({ n: 2, on: { kind: 'message', seq: 6 }, passage: 'Tool output is left out', code: false, note: '' });
    expect(toPost(comment(3))).toMatchObject({ n: 3, text: 'note' });
    const store = mem();
    writeComments('ch1', l, store);
    expect(readComments('ch1', store)).toEqual(l);
  });

  it('Q is the shortcut only without a modifier', () => {
    const k = (key: string, o: Partial<KeyboardEvent> = {}) => isQuoteKey({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, ...o });
    expect(k('q')).toBe(true);
    expect(k('q', { metaKey: true })).toBe(false);
    expect(k('c')).toBe(false);
  });
});

describe('quote marks in a message (#367)', () => {
  const render = (md: string, marks: QuoteMark[]) => renderToString(createElement(Markdown, { rehypePlugins: [[rehypeQuoteMarks, marks]] }, md));
  it('underlines a waiting passage across inline parts with its number after it; lights a jumped-to one', () => {
    const html = render('The brief: **same family** as comments.', [{ n: 2, passage: 'brief: same family as' }]);
    expect(html).toBe(
      '<p>The <mark class="qt-mark">brief: </mark><strong><mark class="qt-mark">same family</mark></strong><mark class="qt-mark"> as</mark><span class="cm-num qt-n" data-qn="2" title="Quote 2: show its chip" role="button">2</span> comments.</p>',
    );
    expect(render('one\n\ntwo three', [{ n: null, passage: 'one\ntwo', flash: true }])).toBe('<p><mark class="qt-flash">one</mark></p>\n<p><mark class="qt-flash">two</mark> three</p>');
    expect(render('nothing here', [{ n: 1, passage: 'absent' }])).toBe('<p>nothing here</p>');
  });
  it('cuts a code passage to 3 lines for its card', () => {
    expect(codeLines('a\nb\nc\nd\n')).toBe('a\nb\nc\n…');
    expect(codeLines('a\nb')).toBe('a\nb');
  });
});

describe('a sent message with quotes and comments (#367)', () => {
  it('shows one card list in number order above the text; a quote of a message gone is no link', () => {
    const message: Message = {
      id: 'm9',
      conversationId: 'c',
      seq: 9,
      role: 'user',
      author: 'user',
      at: '2026-11-26T20:30:00.000Z',
      content: [
        { type: 'text', text: formatComment(2, { title: 'Plan', what: 'markdown docs/plan.md, doc_a v1' }, { type: 'lines', from: 1, to: 1 }, 'Fix it') },
        { type: 'text', text: formatQuote({ n: 1, on: { kind: 'message', seq: 4 }, passage: 'quotes reuse the chips', code: false, note: 'Yes, one family' }, 'atlas', '26 Nov 2026, 21:28') },
        { type: 'text', text: formatQuote({ n: 3, on: { kind: 'message', seq: 2 }, passage: 'gone', code: false, note: '' }, 'atlas', '26 Nov 2026, 21:00') },
        { type: 'text', text: 'My reply' },
      ],
    };
    const html = renderToString(createElement(UserContent, { message, cardId: 'c', text: (t: string, k: string) => createElement('p', { key: k }, t), quoteJump: { has: (s: number) => s === 4, jump: () => {} } }));
    const at = (s: string) => html.indexOf(s);
    expect(at('Yes, one family')).toBeGreaterThan(-1);
    expect(at('Yes, one family')).toBeLessThan(at('Fix it'));
    expect(at('Fix it')).toBeLessThan(at('gone'));
    expect(at('gone')).toBeLessThan(at('My reply'));
    expect(html).toContain('<button type="button" class="cm-sref qt-card" title="Show it in the chat">');
    expect(html).toContain('<div class="cm-sref qt-card" title="No longer in this chat">');
    expect(html).toContain('atlas · 26 Nov 2026, 21:28');
  });
});
