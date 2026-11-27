// Chat messages as a quote surface (#367): what a selection is in (a message's text block, by data-qseq on it), the
// passages waiting as chips, and the jump back that lights a passage for 2 s. The generic part is QuoteLayer.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { CommentTarget, Message, ParsedQuote } from '@atlas/shared';
import { flashPassage, openStep } from './quoteFlash.ts';
import { isQuote, type Comments, type QuoteSource } from './comments.ts';
import type { QuoteResolve } from './QuoteLayer.tsx';
import type { QuoteMark } from './quoteMarks.ts';
import type { QuoteJump } from './CommentCards.tsx';

const elOf = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);

/** The selection's own text (line breaks where blocks end), not the range's; code keeps its indent. */
export function selectedText(r: Range, code: boolean): string {
  const raw = window.getSelection()?.toString() ?? r.toString();
  return code ? raw.replace(/^\n+|\s+$/g, '') : raw.trim();
}

/**
 * What a range of the chat is: a passage of one message's text, of one tool call's input or output (#368), one that
 * crosses two of them, or nothing to quote (a system row, the summary).
 */
export const messageResolve: QuoteResolve = (r) => {
  const place = (n: Node) => elOf(n)?.closest<HTMLElement>('[data-qseq], [data-qtool]') ?? null;
  const a = place(r.startContainer);
  const b = place(r.endContainer);
  if (!a || !b) {
    // Into a system row or the summary: nothing, unless it also crosses into another message.
    const ma = elOf(r.startContainer)?.closest('.msg');
    const mb = elOf(r.endContainer)?.closest('.msg');
    return (a || b) && ma !== mb ? 'cross' : null;
  }
  const pre = elOf(r.startContainer)?.closest('pre');
  const code = !!pre && pre === elOf(r.endContainer)?.closest('pre');
  if (a.dataset.qtool !== undefined || b.dataset.qtool !== undefined) {
    if (a !== b) return 'cross';
    const passage = selectedText(r, code);
    if (!passage) return null;
    return { at: { kind: 'tool', seq: Number(a.dataset.qtseq), call: a.dataset.qtool! }, who: a.dataset.qwho ?? '', passage, code } satisfies QuoteSource;
  }
  if (a.dataset.qseq !== b.dataset.qseq) return 'cross';
  const passage = selectedText(r, code);
  if (!passage) return null;
  const source: QuoteSource = { at: { kind: 'message', seq: Number(a.dataset.qseq), block: a === b ? Number(a.dataset.qblock) : null }, who: a.dataset.qwho ?? '', passage, code };
  return source;
};

/** The task's description (#368): one place, its text. */
export const taskResolve: QuoteResolve = (r) => {
  const a = elOf(r.startContainer)?.closest('[data-qtask]');
  const b = elOf(r.endContainer)?.closest('[data-qtask]');
  if (!a || !b) return a || b ? 'cross' : null;
  const pre = elOf(r.startContainer)?.closest('pre');
  const code = !!pre && pre === elOf(r.endContainer)?.closest('pre');
  const passage = selectedText(r, code);
  return passage ? { at: { kind: 'task' }, who: 'Description', passage, code } : null;
};

/** Light a tool row's passage: its row (and group) open first, then the text is found in it. */
function jumpTool(root: HTMLElement | null, call: string, passage: string) {
  openStep(call);
  let tries = 0;
  const look = () => {
    const el = root?.querySelector(`[data-qtool="${CSS.escape(call)}"]`);
    if (el) return void flashPassage(el, passage);
    if (++tries < 10) requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}
/** Light a passage of the task's description (the sheet's, wherever it is on screen). */
const jumpTask = (passage: string) => {
  const el = document.querySelector('[data-qtask]');
  if (el) flashPassage(el, passage);
};

type Flash = { seq: number; block: number | null; passage: string; t: number };

/** Open a pane tab for a jump back (#368) and light the passage there once it shows. */
export type OpenPane = (target: CommentTarget, at: { passage: string; lines: [number, number] | null; selector: string | null }) => void;

export function useQuoteSurface(
  messages: Message[],
  comments: Comments | undefined,
  anchor: RefObject<HTMLElement | null>,
  fold: number,
  expanded: boolean,
  expand: (x: boolean) => void,
  openPane?: OpenPane,
) {
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const seqs = useMemo(() => new Set(messages.map((m) => m.seq)), [messages]);
  // The chat's scroll box: the parent of the hidden anchor span the conversation starts with.
  const root = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return anchor.current?.parentElement ?? null;
      },
    }),
    [anchor],
  );
  const [flash, setFlash] = useState<Flash | null>(null);
  const jump = useCallback(
    (seq: number, block: number | null, passage: string) => {
      if (!seqs.has(seq)) return; // rewound away: the card is no link
      if (seq <= fold && !expanded) expand(true); // folded by a /clear: show the earlier messages first
      setFlash({ seq, block, passage, t: Date.now() });
    },
    [seqs, fold, expanded, expand],
  );
  // Scroll to the lit passage (the whole text block when the passage can't be found in it), then let it go after 2 s.
  useEffect(() => {
    if (!flash) return;
    const box = root.current;
    const el = box?.querySelector('mark.qt-flash') ?? box?.querySelector(`[data-qseq="${flash.seq}"]`);
    el?.scrollIntoView({ block: 'center' });
    const t = setTimeout(() => setFlash(null), 2000);
    return () => clearTimeout(t);
  }, [flash, root]);
  // Any waiting quote's passage, wherever it is: a message, a tool row, the description, a pane tab.
  const jumpTo = useCallback(
    (q: QuoteSource) => {
      const at = q.at;
      if (at.kind === 'message') jump(at.seq, at.block, q.passage);
      else if (at.kind === 'tool') jumpTool(root.current, at.call, q.passage);
      else if (at.kind === 'task') jumpTask(q.passage);
      else openPane?.(at.target, { passage: q.passage, lines: at.anchor.lines, selector: at.anchor.selector });
    },
    [jump, root, openPane],
  );
  // A quote chip clicked in the composer: light its passage too.
  const picked = comments?.picked;
  const list = comments?.list;
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!picked || last.current === picked.t) return;
    last.current = picked.t;
    const c = list?.find((x) => x.id === picked.id);
    if (c && isQuote(c)) jumpTo(c.quote);
  }, [picked, list, jumpTo]);
  // The number after an underlined passage: light it.
  useEffect(() => {
    const box = root.current;
    if (!box) return;
    const click = (e: MouseEvent) => {
      const n = (e.target as Element | null)?.closest?.<HTMLElement>('[data-qn]')?.dataset.qn;
      const c = n ? list?.find((x) => x.n === Number(n)) : undefined;
      if (c && isQuote(c)) jumpTo(c.quote);
    };
    box.addEventListener('click', click);
    return () => box.removeEventListener('click', click);
  }, [root, list, jumpTo]);
  const marks = (seq: number, block: number): QuoteMark[] => {
    const out: QuoteMark[] = [];
    for (const c of list ?? []) {
      if (!isQuote(c)) continue;
      const at = c.quote.at;
      if (at.kind === 'message' && at.seq === seq && (at.block === null || at.block === block)) out.push({ n: c.n, passage: c.quote.passage });
    }
    if (flash && flash.seq === seq && (flash.block === null || flash.block === block)) out.push({ n: null, passage: flash.passage, flash: true });
    return out;
  };
  const jumper: QuoteJump = useMemo(
    () => ({
      has: (q) => q.on.kind === 'task' || seqs.has(q.seq),
      jump: (q: ParsedQuote) =>
        q.on.kind === 'tool' ? jumpTool(root.current, q.on.call, q.passage) : q.on.kind === 'task' ? jumpTask(q.passage) : jump(q.seq, null, q.passage),
      pane: openPane,
    }),
    [seqs, jump, root, openPane],
  );
  return { byId, root, resolve: messageResolve, marks, jumper };
}
