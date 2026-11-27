// Chat messages as a quote surface (#367): what a selection is in (a message's text block, by data-qseq on it), the
// passages waiting as chips, and the jump back that lights a passage for 2 s. The generic part is QuoteLayer.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Message, ParsedQuote } from '@atlas/shared';
import { isQuote, type Comments, type QuoteSource } from './comments.ts';
import type { QuoteResolve } from './QuoteLayer.tsx';
import type { QuoteMark } from './quoteMarks.ts';
import type { QuoteJump } from './CommentCards.tsx';

const elOf = (n: Node) => (n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement);

/** What a range of the chat is: a passage of one message's text, one that crosses two messages, or nothing to quote. */
export const messageResolve: QuoteResolve = (r) => {
  const a = elOf(r.startContainer)?.closest<HTMLElement>('[data-qseq]') ?? null;
  const b = elOf(r.endContainer)?.closest<HTMLElement>('[data-qseq]') ?? null;
  if (!a || !b) {
    // Into a tool row, a system row or the summary: nothing, unless it also crosses into another message.
    const ma = elOf(r.startContainer)?.closest('.msg');
    const mb = elOf(r.endContainer)?.closest('.msg');
    return (a || b) && ma !== mb ? 'cross' : null;
  }
  if (a.dataset.qseq !== b.dataset.qseq) return 'cross';
  const pre = elOf(r.startContainer)?.closest('pre');
  const code = !!pre && pre === elOf(r.endContainer)?.closest('pre');
  // The selection's own text (line breaks where blocks end), not the range's.
  const raw = window.getSelection()?.toString() ?? r.toString();
  const passage = code ? raw.replace(/^\n+|\s+$/g, '') : raw.trim();
  if (!passage) return null;
  const source: QuoteSource = { at: { kind: 'message', seq: Number(a.dataset.qseq), block: a === b ? Number(a.dataset.qblock) : null }, who: a.dataset.qwho ?? '', passage, code };
  return source;
};

type Flash = { seq: number; block: number | null; passage: string; t: number };

export function useQuoteSurface(messages: Message[], comments: Comments | undefined, anchor: RefObject<HTMLElement | null>, fold: number, expanded: boolean, expand: (x: boolean) => void) {
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
  // A quote chip clicked in the composer: light its passage too.
  const picked = comments?.picked;
  const list = comments?.list;
  const last = useRef<number | null>(null);
  useEffect(() => {
    if (!picked || last.current === picked.t) return;
    last.current = picked.t;
    const c = list?.find((x) => x.id === picked.id);
    if (c && isQuote(c)) jump(c.quote.at.seq, c.quote.at.block, c.quote.passage);
  }, [picked, list, jump]);
  // The number after an underlined passage: light it.
  useEffect(() => {
    const box = root.current;
    if (!box) return;
    const click = (e: MouseEvent) => {
      const n = (e.target as Element | null)?.closest?.<HTMLElement>('[data-qn]')?.dataset.qn;
      const c = n ? list?.find((x) => x.n === Number(n)) : undefined;
      if (c && isQuote(c)) jump(c.quote.at.seq, c.quote.at.block, c.quote.passage);
    };
    box.addEventListener('click', click);
    return () => box.removeEventListener('click', click);
  }, [root, list, jump]);
  const marks = (seq: number, block: number): QuoteMark[] => {
    const out: QuoteMark[] = [];
    for (const c of list ?? []) if (isQuote(c) && c.quote.at.seq === seq && (c.quote.at.block === null || c.quote.at.block === block)) out.push({ n: c.n, passage: c.quote.passage });
    if (flash && flash.seq === seq && (flash.block === null || flash.block === block)) out.push({ n: null, passage: flash.passage, flash: true });
    return out;
  };
  const jumper: QuoteJump = useMemo(() => ({ has: (seq) => seqs.has(seq), jump: (q: ParsedQuote) => jump(q.seq, null, q.passage) }), [seqs, jump]);
  return { byId, root, resolve: messageResolve, marks, jumper };
}
