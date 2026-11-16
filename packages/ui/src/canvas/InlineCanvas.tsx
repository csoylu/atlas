import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Canvas, CanvasNode } from '@atlas/shared';
import { api } from '../api.ts';
import type { MessageStream } from '../useMessages.ts';
import { RENDERERS } from './renderers/index.ts';
import type { Renderer } from './renderers/types.ts';

const PAD = 24;

/** Only one inline canvas is expanded at a time: expanding one tells the others to shrink. */
const expanded = new Set<(id: symbol) => void>();
const announce = (id: symbol) => expanded.forEach((fn) => fn(id));
const rendererOf = (n: CanvasNode) => RENDERERS[n.kind] as unknown as Renderer;

/**
 * Nodes an agent showed with canvas_write({ show }), drawn inside the chat. View only: click to grow or shrink,
 * drag to pan, ctrl/⌘ + wheel or pinch to zoom; « Open canvas » goes to the Canvas page. Live: follows canvas updates.
 */
export function InlineCanvas(props: { canvasId: string; nodeIds: string[]; stream: MessageStream }) {
  const { canvasId, stream } = props;
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const box = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const me = useRef(Symbol('inline-canvas'));

  useEffect(() => {
    const other = (id: symbol) => id !== me.current && setBig(false);
    expanded.add(other);
    return () => void expanded.delete(other);
  }, []);
  // On expand: shrink the others, bring this one fully into view (after the height animation) and focus it for Esc.
  useEffect(() => {
    if (!big) return;
    announce(me.current);
    box.current?.focus({ preventScroll: true });
    const t = setTimeout(() => root.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 200);
    return () => clearTimeout(t);
  }, [big]);

  useEffect(() => {
    api.canvas(canvasId).then(setCanvas, (e) => setError(e instanceof Error ? e.message : String(e)));
    return stream.listen('canvas:' + canvasId, (e) => {
      if (e.type === 'canvas') setCanvas(e.canvas);
    });
  }, [canvasId, stream]);

  const nodes = canvas?.nodes.filter((n) => props.nodeIds.includes(n.id)) ?? [];
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const width = Math.max(...nodes.map((n) => n.x + n.w)) - minX;
  const height = Math.max(...nodes.map((n) => n.y + n.h)) - minY;
  const key = nodes.map((n) => `${n.id}:${n.x},${n.y},${n.w},${n.h}`).join('|');

  // Fit the shown nodes in the box whenever it changes size or they move.
  const fit = () => {
    const el = box.current;
    if (!el || !nodes.length) return;
    const z = Math.min(1, (el.clientWidth - 2 * PAD) / width, (el.clientHeight - 2 * PAD) / height);
    setView({ z, x: (el.clientWidth - width * z) / 2 - minX * z, y: (el.clientHeight - height * z) / 2 - minY * z });
  };
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useLayoutEffect(fit, [big, key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Refit whenever the box changes size: first layout, expand/shrink (animated height), window resize.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fitRef.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Zoom around the pointer; a non-passive listener so the chat doesn't scroll.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && !big) return; // collapsed: plain wheel scrolls the chat
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      setView((v) => {
        if (!e.ctrlKey && !e.metaKey) return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
        const z = Math.min(4, Math.max(0.1, v.z * Math.exp(-e.deltaY / 200)));
        return { z, x: px - ((px - v.x) * z) / v.z, y: py - ((py - v.y) * z) / v.z };
      });
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [big]);

  useEffect(() => {
    if (!big) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); // the ticket modal around it stays open
      setBig(false);
    };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [big]);

  const title = nodes.map((n) => n.title || rendererOf(n).label).join(' · ');
  return (
    <div ref={root} className={'inline-canvas' + (big ? ' big' : '')}>
      <div className="ic-head">
        <span className="ic-title">
          {canvas?.name ?? canvasId}
          {title && <span className="ic-sub"> · {title}</span>}
        </span>
        <button type="button" onClick={fit} title="Fit to view">
          Fit
        </button>
        <button type="button" onClick={() => setBig(!big)}>
          {big ? 'Shrink' : 'Expand'}
        </button>
        <a href={'#/canvas/' + canvasId}>Open in Library ↗</a>
      </div>
      <div
        ref={box}
        tabIndex={-1}
        className="ic-board"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          moved.current = false;
          const sx = e.clientX, sy = e.clientY, start = view;
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const move = (m: PointerEvent) => {
            if (Math.abs(m.clientX - sx) + Math.abs(m.clientY - sy) > 3) moved.current = true;
            setView({ ...start, x: start.x + m.clientX - sx, y: start.y + m.clientY - sy });
          };
          const up = () => {
            el.removeEventListener('pointermove', move);
            el.removeEventListener('pointerup', up);
          };
          el.addEventListener('pointermove', move);
          el.addEventListener('pointerup', up);
        }}
        onClick={() => !moved.current && !big && setBig(true)}
      >
        {big && (
          <button
            type="button"
            className="ic-close"
            title="Close zoomed view (Esc)"
            aria-label="Close zoomed view"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setBig(false);
            }}
          >
            ✕
          </button>
        )}
        {error ? (
          <div className="ic-msg">Canvas unavailable: {error}</div>
        ) : !canvas ? (
          <div className="ic-msg">Loading…</div>
        ) : !nodes.length ? (
          <div className="ic-msg">These nodes are no longer on the canvas.</div>
        ) : (
          <div className="canvas-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
            {nodes.map((n) => {
              const R = rendererOf(n);
              return (
                <div key={n.id} className={'cnode ' + n.kind} style={{ left: n.x, top: n.y, width: n.w, height: n.h }}>
                  <div className="cnode-head">
                    <span className="icon">{R.icon}</span>
                    <span className="cnode-title">{n.title || R.label}</span>
                  </div>
                  <div className="node-body">
                    <R.View node={n} interactive={false} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
