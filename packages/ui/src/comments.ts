// Comment mode (#304): the comments waiting in the composer, and the small pure helpers the pane's surfaces share.
import { useCallback, useEffect, useState } from 'react';
import { anchorLabel, type CommentAnchor, type CommentTarget, type DocKind, type PostComment, type PostQuote } from '@atlas/shared';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a comment shows on its tab: a box in the surface's own coordinates, or markdown lines. */
export interface PaneMark {
  style: 'pin' | 'area' | 'hl';
  box?: Box;
  lines?: [number, number];
}

/** What a surface found under the click or in the area: the anchor, where to open the box (client px), its mark. */
export interface PanePick {
  anchor: CommentAnchor;
  rect: Box;
  mark: PaneMark;
  /** A small picture of the area (data: URL), for the chip; null when the surface can't draw it (pages). */
  thumb?: string | null;
}

/** A comment waiting in the composer (numbered as its pin). */
export interface CommentDraft {
  id: string;
  n: number;
  target: CommentTarget;
  anchor: CommentAnchor;
  text: string;
  /** The tab's title and kind (the chip, the pin's tab). */
  title: string;
  kind: DocKind | 'file' | 'browser';
  mark: PaneMark;
  thumb: string | null;
}

/** A passage of a message of this chat (#367), quoted in the composer: numbered with the comments. */
/**
 * What a surface says about a selection to quote (#367): where it is and what it is. The pill, the note box and the
 * chips only use this; a new surface (a document, a file, tool output) adds a kind to `at` and finds its own passages.
 */
export interface QuoteSource {
  /** A message of this chat: its seq, and which text block (its index in the content); null when it spans several. */
  at: { kind: 'message'; seq: number; block: number | null };
  /** Who wrote it: « atlas », or Master's name. */
  who: string;
  passage: string;
  /** Selected inside a code block. */
  code: boolean;
}
export interface QuoteDraft {
  id: string;
  n: number;
  quote: QuoteSource;
  /** The note (may be empty). */
  text: string;
}
/** What waits in the composer: pane comments and quotes, in one numbering. */
export type ChipDraft = CommentDraft | QuoteDraft;
export const isQuote = (c: ChipDraft): c is QuoteDraft => 'quote' in c;
export const isComment = (c: ChipDraft): c is CommentDraft => !('quote' in c);
export const sameQuote = (a: QuoteSource, b: QuoteSource) => JSON.stringify(a.at) === JSON.stringify(b.at) && a.passage === b.passage;
export const toQuote = (c: QuoteDraft): PostQuote => ({ n: c.n, on: { kind: 'message', seq: c.quote.at.seq }, passage: c.quote.passage, code: c.quote.code, note: c.text });

export const draftKey = (target: CommentTarget) => (target.kind === 'doc' ? 'doc:' + target.docId : target.kind === 'file' ? 'file:' + target.path : 'browser:' + target.url);
export const toPost = (c: CommentDraft): PostComment => ({ target: c.target, anchor: c.anchor, text: c.text, n: c.n });
/** The chip's words after the comment: « Settings mockup · « Network » row ». */
export const chipAnchor = (c: CommentDraft) => (c.anchor.type === 'lines' ? c.title : anchorLabel(c.anchor));

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const KEY = (chatId: string) => `atlas.comments.${chatId}`;

export function readComments(chatId: string, store: Store = localStorage): ChipDraft[] {
  try {
    const v = JSON.parse(store.getItem(KEY(chatId)) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as ChipDraft[]) : [];
  } catch {
    return []; // a broken entry is a lost draft, not an error to show
  }
}
export function writeComments(chatId: string, list: ChipDraft[], store: Store = localStorage): void {
  if (list.length) store.setItem(KEY(chatId), JSON.stringify(list));
  else store.removeItem(KEY(chatId));
}

/** Renumber 1…n in order (after a removal), keeping each one's place. */
export const renumber = <T extends ChipDraft>(list: T[]) => list.map((c, i) => (c.n === i + 1 ? c : { ...c, n: i + 1 }));

const newId = () => Math.random().toString(36).slice(2, 10);
/** The list with this quote added at the end; the same passage twice adds nothing (#367). */
export const withQuote = (l: ChipDraft[], quote: QuoteSource, text: string): ChipDraft[] =>
  l.some((c) => isQuote(c) && sameQuote(c.quote, quote)) ? l : [...l, { id: newId(), n: l.length + 1, quote, text }];

/** The chat's waiting comments and quotes, kept per device like the composer's text. */
export function useComments(chatId: string) {
  const [list, setList] = useState<ChipDraft[]>(() => readComments(chatId));
  // « Send now » in a quote's box (#367): the composer sends at the next render, with the list it then has.
  const [sendAsk, setSendAsk] = useState(0);
  useEffect(() => writeComments(chatId, list), [chatId, list]);
  const add = useCallback((c: Omit<CommentDraft, 'n' | 'id'>) => setList((l) => [...l, { ...c, id: newId(), n: l.length + 1 }]), []);
  const addQuote = useCallback((q: QuoteSource, text: string) => setList((l) => withQuote(l, q, text)), []);
  const setNote = useCallback((id: string, text: string) => setList((l) => l.map((c) => (c.id === id && isQuote(c) ? { ...c, text } : c))), []);
  const remove = useCallback((id: string) => setList((l) => renumber(l.filter((c) => c.id !== id))), []);
  const clear = useCallback(() => setList([]), []);
  const restore = useCallback((back: ChipDraft[]) => setList((l) => renumber([...back, ...l.filter((c) => !back.some((b) => b.id === c.id))])), []);
  const send = useCallback(() => setSendAsk((n) => n + 1), []);
  // A quote chip was clicked: the conversation lights its passage and opens its note box there (#367).
  const [picked, setPicked] = useState<{ id: string; rect: Box; t: number } | null>(null);
  const pick = useCallback((id: string, rect: Box) => setPicked({ id, rect, t: Date.now() }), []);
  const unpick = useCallback(() => setPicked(null), []);
  return { list, add, addQuote, setNote, remove, clear, restore, send, sendAsk, picked, pick, unpick };
}
export type Comments = ReturnType<typeof useComments>;

/** C typed where text goes (a field, an editable page part) is a letter, never the shortcut. */
export function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/** The shown picture of an image fit with object-fit: contain inside its element's box. */
export function containRect(el: Box, natural: { w: number; h: number }): Box {
  const k = Math.min(el.w / natural.w, el.h / natural.h);
  const w = natural.w * k;
  const h = natural.h * k;
  return { x: el.x + (el.w - w) / 2, y: el.y + (el.h - h) / 2, w, h };
}

/** A client-px box inside `shown` (the picture on screen) → the document's own units (`of` = its whole size, `origin` its top-left). */
export function toDoc(b: Box, shown: Box, of: { w: number; h: number }, origin = { x: 0, y: 0 }): Box {
  const kx = of.w / shown.w;
  const ky = of.h / shown.h;
  const x = Math.max(0, Math.min(of.w, (b.x - shown.x) * kx));
  const y = Math.max(0, Math.min(of.h, (b.y - shown.y) * ky));
  return { x: origin.x + x, y: origin.y + y, w: Math.min(of.w - x, b.w * kx), h: Math.min(of.h - y, b.h * ky) };
}
/** The inverse: a document box → client px on the picture shown. */
export function toScreen(b: Box, shown: Box, of: { w: number; h: number }, origin = { x: 0, y: 0 }): Box {
  const kx = shown.w / of.w;
  const ky = shown.h / of.h;
  return { x: shown.x + (b.x - origin.x) * kx, y: shown.y + (b.y - origin.y) * ky, w: b.w * kx, h: b.h * ky };
}

/** A drag shorter than this (px) is a click. */
export const DRAG_MIN = 6;
export const boxOf = (r: { left: number; top: number; width: number; height: number }): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height });
export const contains = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
export const within = (inner: Box, outer: Box) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
const clean = (s: string | null | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
export const textOf = (el: Element, n = 400) => clean((el as HTMLElement).innerText ?? el.textContent, n);
export { clean as cleanText };

/** The hint at the bottom of the pane while comment mode is on, per kind (mockup). */
export function hintFor(kind: DocKind | 'file' | 'browser'): string {
  if (kind === 'markdown') return 'Select text, or click a block';
  if (kind === 'file') return 'Click a line number, or drag for a range';
  if (kind === 'html' || kind === 'browser') return 'Click an element or drag an area';
  if (kind === 'diagram') return 'Click a shape or drag an area';
  return 'Click a spot or drag an area';
}

/** An svg's coordinate space: its viewBox (origin and size), else its width and height; null when it has neither. */
export function svgSpace(svg: string): { of: { w: number; h: number }; origin: { x: number; y: number } } | null {
  const head = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const vb = /\bviewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(head);
  if (vb && Number(vb[3]) > 0 && Number(vb[4]) > 0) return { of: { w: Number(vb[3]), h: Number(vb[4]) }, origin: { x: Number(vb[1]), y: Number(vb[2]) } };
  const w = /\bwidth\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i.exec(head);
  const h = /\bheight\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i.exec(head);
  return w && h && Number(w[1]) > 0 && Number(h[1]) > 0 ? { of: { w: Number(w[1]), h: Number(h[1]) }, origin: { x: 0, y: 0 } } : null;
}
