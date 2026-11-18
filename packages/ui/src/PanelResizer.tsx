import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { PANEL_WIDTH_KEY, panelBounds, panelKey, panelWidth, parsePanelWidth, type PanelMode } from './docPanel.ts';

/** What a side panel needs to be resizable: its width in px and the handle to draw on its left edge. */
export interface PanelResize {
  width: number;
  handle: ReactNode;
}

/**
 * The width of the panel beside a chat (#211): dragged, arrow keys or double-click (default), kept in localStorage,
 * clamped to the chat view `view` (measured live, so a smaller window never pushes the panel off-screen).
 * No resize on a phone (full screen).
 */
export function usePanelResize(view: RefObject<HTMLElement | null>, mode: PanelMode): PanelResize | undefined {
  const [stored, setStored] = useState(() => parsePanelWidth(localStorage.getItem(PANEL_WIDTH_KEY)));
  const [viewWidth, setViewWidth] = useState(0);
  useLayoutEffect(() => {
    const el = view.current;
    if (!el) return;
    setViewWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setViewWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);
  const drag = useRef<{ x: number; w: number } | null>(null);
  if (mode === 'full' || !viewWidth) return undefined;
  const bounds = panelBounds(viewWidth, mode);
  const width = panelWidth(stored, viewWidth, mode);
  const save = (w: number | null) => {
    setStored(w);
    if (w === null) localStorage.removeItem(PANEL_WIDTH_KEY);
    else localStorage.setItem(PANEL_WIDTH_KEY, String(w));
  };
  const clamp = (w: number) => Math.round(Math.min(bounds.max, Math.max(bounds.min, w)));
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove('panel-resizing');
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    save(stored);
  };
  const handle = (
    <div
      className="sd-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      title="Drag to resize · double-click: default width"
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        // Pointer capture keeps the drag going over the html page (an iframe) in the panel; the body class also
        // turns the iframes' pointer events off while dragging, for browsers that hand the events to the frame.
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: width };
        document.body.classList.add('panel-resizing');
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        setStored(clamp(drag.current.w + (drag.current.x - e.clientX)));
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => save(null)}
      onKeyDown={(e) => {
        const w = panelKey(e.key, e.shiftKey, width, bounds);
        if (w === null) return;
        e.preventDefault();
        save(w);
      }}
    />
  );
  return { width, handle };
}
