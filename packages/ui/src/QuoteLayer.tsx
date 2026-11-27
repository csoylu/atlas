// Quotes (#367, mockup #364): select a passage, press Quote (or Q), write a note, add it to the composer as a chip or
// send it now. The layer knows nothing about chat messages: a surface passes `resolve`, which says what a selection is
// (a QuoteSource, « crosses two places », or nothing to quote), as #304's comment kinds say what is under a click.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { boxOf, isTyping, type Box, type Comments, type QuoteSource } from './comments.ts';
import { isQuoteKey, oneLine } from './quoteMarks.ts';
import { useMedia } from './Inbox.tsx';

export function QuoteIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M3 9.2C3 6.6 4.4 4.7 6.6 4l.5 1c-1.2.6-1.9 1.5-2 2.6.9 0 1.7.7 1.7 1.7S6 11 5 11 3 10.4 3 9.2Zm6 0C9 6.6 10.4 4.7 12.6 4l.5 1c-1.2.6-1.9 1.5-2 2.6.9 0 1.7.7 1.7 1.7S12 11 11 11s-2-.6-2-1.8Z" />
    </svg>
  );
}

/** What a surface makes of a selection: a passage to quote, one that crosses two places, or nothing (null). */
export type QuoteResolve = (range: Range) => QuoteSource | 'cross' | null;

type Sel = { kind: 'one'; source: QuoteSource; rect: Box } | { kind: 'cross'; rect: Box };

/** The selection now, as the surface reads it; null when it is empty or outside `root`. */
function readSelection(root: HTMLElement | null, resolve: QuoteResolve): Sel | null {
  const sel = window.getSelection();
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount || !sel.toString().trim()) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const what = resolve(range);
  if (!what) return null;
  // The pill sits above the start, the box under the end.
  const rects = [...range.getClientRects()].filter((r) => r.width > 0);
  const first = rects[0] ?? range.getBoundingClientRect();
  return what === 'cross' ? { kind: 'cross', rect: boxOf(first) } : { kind: 'one', source: what, rect: boxOf(first) };
}

/** The open note box: a new quote, or a chip's (to edit its note). */
type Open = { source: QuoteSource; n: number; rect: Box; id: string | null; note: string };

export function QuoteLayer({ root, resolve, comments, within }: { root: RefObject<HTMLElement | null>; resolve: QuoteResolve; comments: Comments; within?: RefObject<HTMLElement | null> }) {
  const touch = useMedia('(pointer: coarse)');
  const [sel, setSel] = useState<Sel | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const read = useCallback(() => readSelection(root.current, resolve), [root, resolve]);
  const start = useCallback(
    (s: Sel | null) => {
      if (s?.kind !== 'one') return;
      setOpen({ source: s.source, n: comments.list.length + 1, rect: s.rect, id: null, note: '' });
      setSel(null);
    },
    [comments.list.length],
  );
  // Desktop: the pill when the mouse lets go; gone once the selection is. Phone: the dock follows the selection.
  useEffect(() => {
    const up = (e: MouseEvent) => {
      if ((e.target as Element | null)?.closest?.('.qt-pop, .qt-box')) return;
      requestAnimationFrame(() => setSel(read()));
    };
    const change = () => {
      const now = read();
      if (touch) setSel(now);
      else if (!now) setSel(null);
    };
    if (!touch) document.addEventListener('mouseup', up);
    document.addEventListener('selectionchange', change);
    return () => {
      document.removeEventListener('mouseup', up);
      document.removeEventListener('selectionchange', change);
    };
  }, [read, touch]);
  // Q opens the box, Esc drops the pill (before the chat's Esc rewind: capture).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (open || isTyping(e.target) || isTyping(document.activeElement)) return;
      if (e.key === 'Escape' && sel) {
        e.preventDefault();
        e.stopPropagation();
        setSel(null);
        window.getSelection()?.removeAllRanges();
      } else if (isQuoteKey(e)) {
        const now = read();
        if (now?.kind !== 'one') return;
        e.preventDefault();
        e.stopPropagation();
        start(now);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, sel, read, start]);
  // A chip was clicked: its box, over the chip.
  const { picked, unpick } = comments;
  useEffect(() => {
    if (!picked) return;
    const c = comments.list.find((x) => x.id === picked.id);
    unpick();
    if (!c || !('quote' in c)) return;
    setOpen({ source: c.quote, n: c.n, rect: picked.rect, id: c.id, note: c.text });
  }, [picked, unpick, comments.list]);

  const close = () => {
    setOpen(null);
    window.getSelection()?.removeAllRanges();
  };
  const save = (note: string, now: boolean) => {
    if (!open) return;
    if (open.id) comments.setNote(open.id, note);
    else comments.addQuote(open.source, note);
    if (now) comments.send();
    close();
  };
  return (
    <>
      {sel && !touch && !open && <QuotePill sel={sel} onQuote={() => start(sel)} />}
      {sel?.kind === 'one' && touch && !open && (
        <div className="qt-dock">
          <button
            type="button"
            className="qt-pop dock"
            onPointerDown={(e) => e.preventDefault()} // keep the selection
            onClick={() => start(sel)}
          >
            <QuoteIcon />
            <span>Quote selection</span>
          </button>
        </div>
      )}
      {open && <QuoteBox key={open.id ?? 'new'} open={open} sheet={touch} within={within?.current ?? null} onSave={save} onCancel={close} />}
    </>
  );
}

function QuotePill({ sel, onQuote }: { sel: Sel; onQuote(): void }) {
  const style = { position: 'fixed' as const, left: Math.max(8, sel.rect.x), top: Math.max(8, sel.rect.y - 42), bottom: 'auto' };
  return createPortal(
    sel.kind === 'cross' ? (
      <span className="qt-pop off" role="status" style={style}>
        Select inside one message to quote it
      </span>
    ) : (
      <button type="button" className="qt-pop" style={style} onMouseDown={(e) => e.preventDefault()} onClick={onQuote} title="Quote this passage (Q)">
        <QuoteIcon />
        <span>Quote</span>
        <span className="kbd">Q</span>
      </button>
    ),
    document.body,
  );
}

/** The pane's comment box with a quote head: number, who, « passage »; an optional note; Send now and Add. */
function QuoteBox({ open, sheet, within, onSave, onCancel }: { open: Open; sheet: boolean; within: HTMLElement | null; onSave(note: string, now: boolean): void; onCancel(): void }) {
  const [note, setNote] = useState(open.note);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (sheet || !box.current) return;
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    const lim = within ? boxOf(within.getBoundingClientRect()) : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const r = open.rect;
    const left = Math.max(lim.x + 8, Math.min(r.x, lim.x + lim.w - w - 8));
    let top = r.y + r.h + 8;
    if (top + h > lim.y + lim.h - 8) top = Math.max(lim.y + 8, r.y - h - 8);
    setPos({ left, top });
  }, [open.rect, within, sheet]);
  // A click outside the box cancels it, like Esc.
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) onCancel();
    };
    document.addEventListener('pointerdown', down, true);
    return () => document.removeEventListener('pointerdown', down, true);
  }, [onCancel]);
  const who = `${open.source.who} · « ${oneLine(open.source.passage)} »`;
  return createPortal(
    <div
      ref={box}
      className={'cm-box qt-box' + (sheet ? ' sheet' : '')}
      role="dialog"
      aria-label={`Quote ${open.n}`}
      style={sheet ? undefined : pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }}
    >
      <div className="cm-box-head">
        <span className="cm-num">{open.n}</span>
        <span className="cm-kind qt-kind">
          <QuoteIcon />
        </span>
        <span className="cm-box-what" title={open.source.passage}>
          {who}
        </span>
      </div>
      <textarea
        autoFocus
        rows={2}
        value={note}
        placeholder="Your note (optional)…"
        aria-label="Your note"
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter' && !e.altKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSave(note.trim(), e.shiftKey);
          } else if (e.key === 'Enter' && e.altKey) {
            // ⌥↵: a new line in the note (the browser adds none for Alt+Enter everywhere).
            e.preventDefault();
            const t = e.currentTarget;
            const at = t.selectionStart;
            setNote(note.slice(0, at) + '\n' + note.slice(t.selectionEnd));
            requestAnimationFrame(() => t.setSelectionRange(at + 1, at + 1));
          }
        }}
      />
      <div className="cm-box-foot">
        <button type="button" className="btn ghost small" onClick={() => onSave(note.trim(), true)}>
          Send now{!sheet && <span className="kbd">⇧↵</span>}
        </button>
        <button type="button" className="btn primary small" onClick={() => onSave(note.trim(), false)}>
          Add{!sheet && <span className="kbd">↵</span>}
        </button>
      </div>
    </div>,
    document.body,
  );
}
