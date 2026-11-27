// Quoting a passage of a pane tab (#368): what a selection in a markdown document, its source, or a file in the
// editor is. The answer is a QuoteSource of kind « pane », which the composer sends as #304's [comment N] with a text
// anchor (the quote, its section and lines of the file, or the element of a page), so the agent finds the place the
// way it finds a comment's. Html pages and url text report their selection from inside their frame (paneHelper); the
// browser tab from the desktop.
import { EditorView } from '@codemirror/view';
import type { CommentTarget, DocKind } from '@atlas/shared';
import type { QuoteResolve } from './QuoteLayer.tsx';
import type { QuoteSource } from './comments.ts';
import { selectedText } from './useQuoteSurface.ts';

/** The open tab, as a passage of it is quoted. `target` null: nothing to quote (an image, an empty tab). */
export interface PaneQuoteTab {
  target: CommentTarget | null;
  title: string;
  tab: DocKind | 'file' | 'browser';
  /** Comment mode is on: a selection there is a comment (#304), not a quote. */
  commenting: boolean;
}

const elOf = (n: Node): Element | null => (n.nodeType === 1 ? (n as Element) : n.parentElement);
const lineRange = (ls: number[]): [number, number] | null => (ls.length ? [Math.min(...ls), Math.max(...ls)] : null);

/** A pane passage as a quote: the anchor #304 builds for a text comment. */
export function paneSource(t: PaneQuoteTab, target: CommentTarget, passage: string, code: boolean, where: { section?: string | null; lines?: [number, number] | null; selector?: string | null }): QuoteSource {
  return {
    at: { kind: 'pane', target, tab: t.tab, anchor: { type: 'text', quote: passage.slice(0, 4000), section: where.section ?? null, lines: where.lines ?? null, selector: where.selector ?? null } },
    who: t.title,
    passage,
    code,
  };
}

/** The artifact at the version shown (an older one when Master looks at it), else the tab's target. */
function targetAt(t: PaneQuoteTab, place: HTMLElement): CommentTarget | null {
  if (!t.target) return null;
  const v = Number(place.dataset.qver);
  return t.target.kind === 'doc' && v > 0 ? { ...t.target, version: v } : t.target;
}

/** Lines of `pre` from its first character to `node`:`offset` (1-based). */
function lineAt(pre: Element, node: Node, offset: number): number {
  const r = document.createRange();
  r.setStart(pre, 0);
  r.setEnd(node, offset);
  return r.toString().split('\n').length;
}

/**
 * A selection in the pane: a markdown document (`[data-qpane=md]`, blocks with their lines), a source view
 * (`[data-qpane=src]`, a pre of the file) or the Files editor (`[data-qpane=code]`, CodeMirror's own selection).
 * Across two of them, or out of one: « crosses ».
 */
export function paneResolve(t: PaneQuoteTab): QuoteResolve {
  return (r) => {
    if (t.commenting || !t.target) return null;
    const a = elOf(r.startContainer)?.closest<HTMLElement>('[data-qpane]') ?? null;
    const b = elOf(r.endContainer)?.closest<HTMLElement>('[data-qpane]') ?? null;
    if (!a || !b) return a || b ? 'cross' : null;
    if (a !== b) return 'cross';
    const target = targetAt(t, a);
    if (!target) return null;
    const kind = a.dataset.qpane;
    if (kind === 'code') {
      const view = EditorView.findFromDOM(a);
      if (!view) return null;
      const s = view.state.selection.main;
      if (s.empty) return null;
      const passage = view.state.sliceDoc(s.from, s.to).replace(/\s+$/, '');
      if (!passage.trim()) return null;
      const lines: [number, number] = [view.state.doc.lineAt(s.from).number, view.state.doc.lineAt(s.to).number];
      return paneSource(t, target, passage, true, { lines });
    }
    if (kind === 'src') {
      const passage = selectedText(r, true);
      if (!passage.trim()) return null;
      return paneSource(t, target, passage, true, { lines: [lineAt(a, r.startContainer, r.startOffset), lineAt(a, r.endContainer, r.endOffset)] });
    }
    // Markdown: the blocks' lines of the file, the section of the first.
    const passage = selectedText(r, false);
    if (!passage) return null;
    const blockOf = (n: Node) => elOf(n)?.closest<HTMLElement>('[data-l1]') ?? null;
    const blocks = [blockOf(r.startContainer), blockOf(r.endContainer)].filter((x): x is HTMLElement => !!x);
    const lines = lineRange(blocks.flatMap((x) => [Number(x.dataset.l1), Number(x.dataset.l2)]).filter((n) => n > 0));
    const section = (blocks[0]?.closest('[data-sec]') as HTMLElement | null)?.dataset.sec ?? null;
    return paneSource(t, target, passage, false, { section, lines });
  };
}
