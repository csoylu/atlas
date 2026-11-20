import { describe, expect, it } from 'vitest';
import { formatComment, PANE_HELPER, withPaneHelper, type Message } from '@atlas/shared';
import { containRect, hintFor, isTyping, readComments, renumber, svgSpace, toDoc, toScreen, writeComments, type CommentDraft } from './comments.ts';
import { splitComments } from './CommentCards.tsx';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const draft = (n: number): CommentDraft => ({
  id: 'c' + n,
  n,
  target: { kind: 'doc', docId: 'doc_1', version: 2 },
  anchor: { type: 'spot', x: 1, y: 1, of: { w: 10, h: 10 }, unit: 'px', under: null },
  text: 'note ' + n,
  title: 'T',
  kind: 'html',
  mark: { style: 'pin', box: { x: 1, y: 1, w: 0, h: 0 } },
  thumb: null,
});

describe('comment mode helpers (#304)', () => {
  it('maps a box on screen to the document’s own units and back', () => {
    const shown = { x: 100, y: 50, w: 200, h: 100 };
    const of = { w: 800, h: 400 };
    const origin = { x: -10, y: 5 }; // an svg viewBox that does not start at 0 0
    const d = toDoc({ x: 150, y: 75, w: 50, h: 25 }, shown, of, origin);
    expect(d).toEqual({ x: 190, y: 105, w: 200, h: 100 });
    expect(toScreen(d, shown, of, origin)).toEqual({ x: 150, y: 75, w: 50, h: 25 });
  });

  it('finds the picture inside an object-fit: contain box', () => {
    expect(containRect({ x: 0, y: 0, w: 400, h: 400 }, { w: 200, h: 100 })).toEqual({ x: 0, y: 100, w: 400, h: 200 });
  });

  it('reads an svg’s coordinate space from its viewBox, else its size', () => {
    expect(svgSpace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-20 10 640 480"><rect/></svg>')).toEqual({ of: { w: 640, h: 480 }, origin: { x: -20, y: 10 } });
    expect(svgSpace('<svg width="300px" height="200"></svg>')).toEqual({ of: { w: 300, h: 200 }, origin: { x: 0, y: 0 } });
    expect(svgSpace('<svg></svg>')).toBeNull();
  });

  it('C typed in a field is a letter, not the shortcut', () => {
    expect(isTyping({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTyping({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTyping({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTyping({ tagName: 'BUTTON', isContentEditable: false } as unknown as EventTarget)).toBe(false);
    expect(isTyping(null)).toBe(false);
  });

  it('keeps the waiting comments per chat, renumbered after a removal', () => {
    const store = mem();
    writeComments('ch1', [draft(1), draft(2), draft(3)], store);
    expect(readComments('ch1', store).map((c) => c.n)).toEqual([1, 2, 3]);
    expect(readComments('ch2', store)).toEqual([]);
    expect(renumber([draft(1), draft(3)]).map((c) => [c.id, c.n])).toEqual([['c1', 1], ['c3', 2]]);
    writeComments('ch1', [], store);
    expect(store.getItem('atlas.comments.ch1')).toBeNull();
  });

  it('says what to do per kind', () => {
    expect(hintFor('markdown')).toMatch(/Select text/);
    expect(hintFor('html')).toMatch(/element/);
    expect(hintFor('diagram')).toMatch(/shape/);
    expect(hintFor('url')).toMatch(/spot/);
  });
});

describe('sent comments: the cards of a message (#304)', () => {
  it('pairs each comment with the picture sent right after it; other images stay as images', () => {
    const c1 = formatComment(1, { title: 'Plan', what: 'markdown docs/plan.md, doc_ab v3' }, { type: 'text', quote: 'hello', section: 'intro', lines: [3, 3] }, 'Shorter', { source: { from: 3, lines: ['hello world'] } });
    const c2 = formatComment(2, { title: 'Map', what: 'diagram diagrams/m.svg, doc_cd v1' }, { type: 'area', box: { x: 0, y: 0, w: 50, h: 50 }, of: { w: 100, h: 100 }, unit: 'svg', inside: [] }, 'Bigger', { picture: 'uploads/a.png' });
    const img = (path: string) => ({ type: 'image' as const, path, mediaType: 'image/png' as const, width: 10, height: 10 });
    const content = [{ type: 'text', text: 'two things' }, img('uploads/mine.png'), { type: 'text', text: c1 }, { type: 'text', text: c2 }, img('uploads/a.png')] as Message['content'];
    const { comments, rest } = splitComments(content);
    expect(comments.map((c) => [c.c.n, c.c.docId, c.c.version, c.picture?.path ?? null])).toEqual([
      [1, 'doc_ab', 3, null],
      [2, 'doc_cd', 1, 'uploads/a.png'],
    ]);
    expect(comments[0]!.c.quoted).toEqual(['hello world']);
    expect(comments[0]!.c.section).toBe('intro');
    expect(rest.map((r) => r.block.type)).toEqual(['text', 'image']);
  });
});

describe('the page helper (#304)', () => {
  it('is valid script, added before </body> (or at the end)', () => {
    expect(() => new Function(PANE_HELPER)).not.toThrow();
    expect(withPaneHelper('<html><body><p>x</p></body></html>')).toMatch(/<p>x<\/p><script>[\s\S]*<\/script><\/body><\/html>$/);
    expect(withPaneHelper('<p>x</p>')).toMatch(/^<p>x<\/p><script>/);
  });
});
