// Comment mode (#304, mockup « the right pane as a workbench »): the parts every kind of tab shares. A kind only says
// what is under a point or in an area (a PanePick); the pins, the drag rectangle, the comment box and the hint are here.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { anchorLabel, cssPath, type CommentAnchor } from '@atlas/shared';
import { boxOf, cleanText, contains, DRAG_MIN, textOf, toDoc, toScreen, within, type Box, type PaneMark, type PanePick } from './comments.ts';

/** What the pane gives a tab's body while comments exist or comment mode is on. */
export interface PaneComment {
  on: boolean;
  /** This tab's comments (and the one being written), with their number. */
  marks: { n: number; mark: PaneMark }[];
  /** `version`: the version shown when it was picked (the comment is about that one). */
  onPick(p: PanePick, version: number): void;
  /** Esc or C typed inside a page's frame (the frame has the focus, not the app). */
  onKey(key: 'Escape' | 'c'): void;
}

/** Pins, areas and outlines, in px relative to their positioned parent. */
export function Marks({ items }: { items: { n: number | ''; style: PaneMark['style']; box: Box }[] }) {
  return (
    <>
      {items.map((m, i) => (
        <div key={i} className="cm-marks" aria-hidden="true">
          {m.style !== 'pin' && <div className={m.style === 'area' ? 'cm-area' : 'cm-hl'} style={{ left: m.box.x, top: m.box.y, width: m.box.w, height: m.box.h }} />}
          {m.n !== '' && (
            <div className="cm-pin" style={{ left: m.box.x, top: m.box.y }}>
              {m.n}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/** A transparent layer over a picture or a frame: a click (a spot) or a drag (an area), in client px. */
export function PickOverlay({ onPick, label }: { onPick(b: Box, click: boolean): void; label: string }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<Box | null>(null);
  const area = (e: React.PointerEvent) => {
    const s = start.current!;
    return { x: Math.min(s.x, e.clientX), y: Math.min(s.y, e.clientY), w: Math.abs(e.clientX - s.x), h: Math.abs(e.clientY - s.y) };
  };
  return (
    <div
      className="cm-catch"
      aria-label={label}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const a = area(e);
        if (a.w + a.h > DRAG_MIN || drag) {
          const r = e.currentTarget.getBoundingClientRect();
          setDrag({ x: a.x - r.left, y: a.y - r.top, w: a.w, h: a.h });
        }
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const a = area(e);
        start.current = null;
        setDrag(null);
        if (a.w + a.h > DRAG_MIN) onPick(a, false);
        else onPick({ x: e.clientX, y: e.clientY, w: 0, h: 0 }, true);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDrag(null);
      }}
    >
      {drag && <div className="cm-area" style={{ left: drag.x, top: drag.y, width: drag.w, height: drag.h }} />}
    </div>
  );
}

/** Re-render when an element changes size (marks are placed from live layout). */
export function useSizeTick(ref: RefObject<Element | null>, on: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || !on) return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, on]);
  return tick;
}

/* ── Pictures: an image (its own pixels) or an svg diagram (its own units) ─────────────────── */

export interface PictureSpace {
  /** The picture on screen, client px. */
  shown: Box;
  /** The document's size in its units, and the top-left of its coordinates (an svg's viewBox). */
  of: { w: number; h: number };
  origin: { x: number; y: number };
  unit: 'px' | 'svg';
}

/** A small picture of a box of an <img> (data: URL), for the chip; null when it can't be drawn (another site's image). */
export function thumbOf(img: HTMLImageElement, b: Box, s: PictureSpace): string | null {
  try {
    const nw = img.naturalWidth || s.of.w;
    const nh = img.naturalHeight || s.of.h;
    const kx = nw / s.of.w;
    const ky = nh / s.of.h;
    const sw = Math.max(1, b.w * kx);
    const sh = Math.max(1, b.h * ky);
    const k = Math.min(1, 96 / sw, 64 / sh) * 2;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k));
    c.height = Math.max(1, Math.round(sh * k));
    c.getContext('2d')!.drawImage(img, (b.x - s.origin.x) * kx, (b.y - s.origin.y) * ky, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  } catch {
    return null; // a tainted canvas (an image from another site): the chip shows the kind instead
  }
}

/** A click or a drag on a picture → a spot or an area in its units (an svg adds what is under it, see svgShapes). */
export function picturePick(b: Box, click: boolean, s: PictureSpace, img: HTMLImageElement | null, svg?: SvgHits | null): PanePick | null {
  if (click && !contains(s.shown, b.x, b.y)) return null;
  const d = toDoc(click ? { ...b, w: 0, h: 0 } : b, s.shown, s.of, s.origin);
  if (click) {
    const hit = svg?.at(b.x, b.y) ?? null;
    if (hit) {
      const r = hit.rect;
      return { anchor: { type: 'element', selector: hit.selector, text: hit.text, tag: hit.tag }, rect: r, mark: { style: 'hl', box: toDoc(r, s.shown, s.of, s.origin) } };
    }
    return { anchor: { type: 'spot', x: d.x, y: d.y, of: s.of, unit: s.unit, under: null }, rect: { x: b.x, y: b.y, w: 0, h: 0 }, mark: { style: 'pin', box: { ...d, w: 0, h: 0 } } };
  }
  if (d.w < 1 || d.h < 1) return null;
  const inside = svg?.inside(b) ?? [];
  return { anchor: { type: 'area', box: d, of: s.of, unit: s.unit, inside }, rect: b, mark: { style: 'area', box: d }, thumb: img ? thumbOf(img, d, s) : null };
}

/** Marks of a picture, in px relative to the picture's element box (`el`). */
export function pictureMarks(marks: { n: number; mark: PaneMark }[], s: PictureSpace, el: Box) {
  return marks.flatMap((m) => {
    if (!m.mark.box) return [];
    const c = toScreen(m.mark.box, s.shown, s.of, s.origin);
    return [{ n: m.n, style: m.mark.style, box: { ...c, x: c.x - el.x, y: c.y - el.y } }];
  });
}

/* ── Svg: what is under a point, which shapes are in an area ──────────────────────────────── */

export interface SvgHits {
  at(x: number, y: number): { selector: string; text: string; tag: string; rect: Box } | null;
  inside(b: Box): { selector: string; text: string }[];
}

const SHAPES = 'rect,circle,ellipse,path,polygon,polyline,line,text,image,use';

/**
 * The svg made inert (no scripts, handlers, outside links or embedded html), for hit tests only: it is laid exactly over
 * the picture, invisible, inside a shadow root so its <style> stays out of the app.
 */
export function inertSvg(svg: string): SVGSVGElement | null {
  const d = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = d.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg' || d.querySelector('parsererror')) return null;
  root.querySelectorAll('script, foreignObject, iframe, object, embed, audio, video').forEach((e) => e.remove());
  for (const el of [root, ...root.querySelectorAll('*')])
    for (const a of [...el.attributes]) if (/^on/i.test(a.name) || (/href$/i.test(a.name) && !a.value.trim().startsWith('#'))) el.removeAttribute(a.name);
  root.querySelectorAll('style').forEach((s) => (s.textContent = (s.textContent ?? '').replace(/@import[^;]*;?/g, '')));
  return document.importNode(root, true) as unknown as SVGSVGElement;
}

/** The text that names a shape: its own, else its group's (a box's label). */
function shapeText(el: Element): string {
  const own = cleanText(el.textContent, 200);
  if (own) return own;
  const g = el.closest('g');
  return g ? cleanText(g.textContent, 200) : '';
}

export function svgHits(root: SVGSVGElement): SvgHits {
  const shapes = () => [...root.querySelectorAll(SHAPES)].map((el) => ({ el, r: boxOf(el.getBoundingClientRect()) })).filter((s) => s.r.w > 0 || s.r.h > 0);
  const path = (el: Element) => cssPath(el, root);
  return {
    at(x, y) {
      // The smallest shape under the point (a label over its box wins; a background rect loses).
      const hit = shapes()
        .filter((s) => contains(s.r, x, y))
        .sort((a, b) => a.r.w * a.r.h - b.r.w * b.r.h)[0];
      if (!hit) return null;
      const full = boxOf(root.getBoundingClientRect());
      if (hit.r.w * hit.r.h > full.w * full.h * 0.9) return null; // the background: a spot, not « the background rect »
      return { selector: path(hit.el), text: shapeText(hit.el), tag: hit.el.tagName.toLowerCase(), rect: hit.r };
    },
    inside(b) {
      const out: { el: Element; selector: string; text: string }[] = [];
      const cands = [...root.querySelectorAll('g[id], g, ' + SHAPES)];
      for (const el of cands) {
        if (out.length >= 12 || out.some((o) => o.el.contains(el))) continue;
        const r = boxOf(el.getBoundingClientRect());
        if (!r.w || !r.h || !within(r, b)) continue;
        const text = el.tagName.toLowerCase() === 'g' ? cleanText(el.textContent, 120) : shapeText(el).slice(0, 120);
        if (el.tagName.toLowerCase() === 'g' && !text && !el.id) continue;
        out.push({ el, selector: path(el), text });
      }
      return out.map(({ selector, text }) => ({ selector, text }));
    },
  };
}

/** The inert svg laid over the picture (invisible), and its hit tests; null until it is in place. */
export function SvgHitLayer({ svg, onReady }: { svg: string; onReady(h: SvgHits | null): void }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    shadow.textContent = '';
    const root = inertSvg(svg);
    if (!root) return void onReady(null);
    root.setAttribute('width', '100%');
    root.setAttribute('height', '100%');
    root.style.display = 'block';
    shadow.appendChild(root);
    onReady(svgHits(root));
    return () => {
      shadow.textContent = '';
      onReady(null);
    };
  }, [svg, onReady]);
  return <div ref={host} className="cm-svg-hits" aria-hidden="true" />;
}

/* ── Markdown: selected text or a clicked block, with its source lines ─────────────────────── */

/** A selection or a click in a markdown article → a text anchor (quote, section, lines of the file). */
export function markdownPick(article: HTMLElement, target: EventTarget | null, sectionOf: (el: Element) => string | null): PanePick | null {
  const sel = window.getSelection();
  const lines = (els: (Element | null)[]): [number, number] | null => {
    const ls = els.flatMap((e) => (e ? [Number((e as HTMLElement).dataset.l1), Number((e as HTMLElement).dataset.l2)] : [])).filter((n) => n > 0);
    return ls.length ? [Math.min(...ls), Math.max(...ls)] : null;
  };
  const blockOf = (n: Node | null) => (n ? (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest('[data-l1]') ?? null : null);
  if (sel && !sel.isCollapsed && sel.rangeCount && article.contains(sel.anchorNode) && article.contains(sel.focusNode)) {
    const quote = cleanText(sel.toString(), 4000);
    if (!quote) return null;
    const a = blockOf(sel.anchorNode);
    const b = blockOf(sel.focusNode);
    const ls = lines([a, b]);
    const sec = a ? sectionOf(a) : null;
    const rect = boxOf(sel.getRangeAt(0).getBoundingClientRect());
    return { anchor: { type: 'text', quote, section: sec, lines: ls }, rect, mark: { style: 'hl', lines: ls ?? undefined } };
  }
  const block = target instanceof Element ? target.closest('[data-l1]') : null;
  if (!block || !article.contains(block)) return null;
  const quote = textOf(block, 4000);
  if (!quote) return null;
  const ls = lines([block]);
  return { anchor: { type: 'text', quote, section: sectionOf(block), lines: ls }, rect: boxOf(block.getBoundingClientRect()), mark: { style: 'hl', lines: ls ?? undefined } };
}

/** Marks of markdown comments: the blocks of their lines, in px relative to the article. */
export function markdownMarks(article: HTMLElement, marks: { n: number; mark: PaneMark }[]) {
  const a = article.getBoundingClientRect();
  const blocks = [...article.querySelectorAll<HTMLElement>('[data-l1]')];
  return marks.flatMap((m) => {
    const ls = m.mark.lines;
    if (!ls) return [];
    // The outermost blocks inside the range (a list item's paragraph is inside the item).
    const hit = blocks.filter((b) => Number(b.dataset.l1) <= ls[1] && Number(b.dataset.l2) >= ls[0]);
    const top = hit.filter((b) => !hit.some((o) => o !== b && o.contains(b)));
    if (!top.length) return [];
    const rs = top.map((b) => b.getBoundingClientRect());
    const x = Math.min(...rs.map((r) => r.left)) - a.left - 6;
    const y = Math.min(...rs.map((r) => r.top)) - a.top - 4;
    const w = Math.max(...rs.map((r) => r.right)) - a.left + 6 - x;
    const h = Math.max(...rs.map((r) => r.bottom)) - a.top + 4 - y;
    return [{ n: m.n, style: 'hl' as const, box: { x, y, w, h } }];
  });
}

/* ── A page in a frame: the helper inside it answers (shared/paneHelper.ts) ───────────────── */

interface FrameMsg {
  atlasPane?: 1;
  ready?: 1;
  pick?: { anchor: CommentAnchor; rect: Box; mark: PaneMark };
  key?: 'Escape' | 'c';
}

/** Talks to the helper of the page in `frame`: comment mode on/off, the marks to draw; its picks and keys come back. */
export function useFrameComments(frame: RefObject<HTMLIFrameElement | null>, c: PaneComment | undefined, version: number) {
  const on = !!c?.on;
  const marks = JSON.stringify(c?.marks.map((m) => ({ n: m.n, style: m.mark.style, box: m.mark.box })).filter((m) => m.box) ?? []);
  const [ready, setReady] = useState(0);
  const cb = useRef({ c, version });
  cb.current = { c, version };
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const f = frame.current;
      if (!f || e.source !== f.contentWindow) return;
      const d = e.data as FrameMsg;
      if (!d || d.atlasPane !== 1) return;
      if (d.ready) setReady((n) => n + 1);
      if (d.key) cb.current.c?.onKey(d.key);
      if (d.pick) {
        const r = f.getBoundingClientRect();
        cb.current.c?.onPick({ anchor: d.pick.anchor, rect: { ...d.pick.rect, x: d.pick.rect.x + r.left, y: d.pick.rect.y + r.top }, mark: d.pick.mark, thumb: null }, cb.current.version);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [frame]);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ atlasPane: 1, on, marks: JSON.parse(marks) as unknown }, '*');
  }, [frame, on, marks, ready]);
}

/* ── The comment box, the hint, the chips ─────────────────────────────────────────────────── */

/** The box under the picked place (a bottom sheet on a phone): Add with ⌘↵, Cancel with Esc. */
export function CommentBox(props: { n: number; anchor: CommentAnchor; within: Box | null; rect: Box; sheet: boolean; onAdd(text: string): void; onCancel(): void }) {
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (props.sheet || !box.current) return;
    const w = box.current.offsetWidth;
    const h = box.current.offsetHeight;
    const lim = props.within ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const left = Math.max(lim.x + 8, Math.min(props.rect.x, lim.x + lim.w - w - 8));
    // Under the place; above it when there is no room below.
    let top = props.rect.y + props.rect.h + 8;
    if (top + h > lim.y + lim.h - 8) top = Math.max(lim.y + 8, props.rect.y - h - 8);
    setPos({ left, top });
  }, [props.rect, props.within, props.sheet]);
  const add = () => text.trim() && props.onAdd(text.trim());
  return createPortal(
    <div
      ref={box}
      className={'cm-box' + (props.sheet ? ' sheet' : '')}
      role="dialog"
      aria-label={`Comment ${props.n}`}
      style={props.sheet ? undefined : pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }}
    >
      <div className="cm-box-head">
        <span className="cm-num">{props.n}</span>
        <span className="cm-box-what">{anchorWords(props.anchor)}</span>
      </div>
      <textarea
        autoFocus
        rows={2}
        value={text}
        placeholder="Your comment…"
        aria-label="Your comment"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            props.onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            add();
          }
        }}
      />
      <div className="cm-box-foot">
        {!props.sheet && <span className="kbd">⌘↵</span>}
        <span className="sd-sp" />
        <button type="button" className="btn ghost small" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary small" disabled={!text.trim()} onClick={add}>
          Add
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** « Element: « Network » row (div.setting-row) », « « with a changelog… » · intro », « Area around « … » ». */
export function anchorWords(a: CommentAnchor): string {
  switch (a.type) {
    case 'element':
      return `Element: ${anchorLabel(a)}`;
    case 'text':
      return anchorLabel(a) + (a.section ? ` · ${a.section}` : '');
    case 'area':
      return a.inside.length ? `Area: ${a.inside.length} shape${a.inside.length > 1 ? 's' : ''} inside` : 'Area';
    case 'spot':
      return 'Spot: ' + anchorLabel(a);
    case 'lines':
      return anchorLabel(a);
  }
}

/** The pill at the bottom of the pane: what to do, how many wait, Done (Esc). */
export function CommentHint({ text, waiting, onDone }: { text: string; waiting: number; onDone(): void }) {
  return (
    <div className="cm-hint" role="status">
      <span>{text}</span>
      <span className="cm-hint-n">· {waiting} waiting</span>
      <button type="button" className="sd-btn" onClick={onDone}>
        Done <span className="kbd">Esc</span>
      </button>
    </div>
  );
}

export const CommentIcon = () => (
  <svg className="icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 3.5h11v7.5H7l-3 2.5v-2.5H2.5z" />
    <path d="M5.5 6.5h5M5.5 8.5h3" />
  </svg>
);

export type { ReactNode };
