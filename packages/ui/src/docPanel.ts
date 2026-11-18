import { USER, type PanelTab } from '@atlas/shared';

/** Side by side above 960px, an overlay over the chat down to 760px, full screen below (phones). */
export type PanelMode = 'side' | 'overlay' | 'full';
export const panelMode = (viewport: number): PanelMode => (viewport > 960 ? 'side' : viewport > 760 ? 'overlay' : 'full');

/** localStorage key of the panel width the user dragged to (#211): one width wherever the panel opens. */
export const PANEL_WIDTH_KEY = 'atlas.panel.width';
/** Narrowest panel (tabs, version, tools in one head row) and narrowest chat beside it (composer, pins). */
export const PANEL_MIN = 360;
export const CHAT_MIN = 380;
/** Narrowest two-pane screen (inbox list + item, Library, workflows, settings) beside the task panel (#222). */
export const SCREEN_MIN = 640;

/**
 * The task panel's mode beside a screen `view` px wide that needs `screenMin` px (#222): side by side when both fit,
 * else over the screen from the right (still a side panel, no backdrop); phones keep the full-screen panel.
 */
export function taskPanelMode(window: PanelMode, view: number, screenMin: number): PanelMode {
  if (window !== 'side' || !view) return window;
  return view >= screenMin + PANEL_MIN ? 'side' : 'overlay';
}

/**
 * Width range of the panel in a chat view `view` px wide: side by side, the chat keeps CHAT_MIN; over the chat
 * (overlay), a sliver of the chat stays visible. `def` is the width before any drag (the old CSS default).
 */
export function panelBounds(view: number, mode: 'side' | 'overlay', screenMin = CHAT_MIN): { min: number; max: number; def: number } {
  const max = Math.min(view, Math.max(PANEL_MIN, mode === 'side' ? view - screenMin : Math.floor(view * 0.94)));
  const def = mode === 'side' ? Math.min(760, Math.max(380, Math.round(view * 0.48))) : Math.min(560, Math.floor(view * 0.94));
  const min = Math.min(PANEL_MIN, max);
  return { min, max, def: Math.min(max, Math.max(min, def)) };
}

/** The width to draw: the stored one (or the default) kept inside the bounds, so a smaller window never pushes it off-screen. */
export function panelWidth(stored: number | null, view: number, mode: 'side' | 'overlay', screenMin = CHAT_MIN): number {
  const b = panelBounds(view, mode, screenMin);
  return Math.round(Math.min(b.max, Math.max(b.min, stored ?? b.def)));
}

/** A stored width: a positive number of px, else none (the default). */
export function parsePanelWidth(raw: string | null): number | null {
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Arrow keys on the separator: ← widens the panel, → narrows it (Shift: bigger steps), Home / End = max / min. */
export function panelKey(key: string, shift: boolean, width: number, b: { min: number; max: number }): number | null {
  const step = shift ? 64 : 16;
  const w = key === 'ArrowLeft' ? width + step : key === 'ArrowRight' ? width - step : key === 'Home' ? b.max : key === 'End' ? b.min : null;
  return w === null ? null : Math.min(b.max, Math.max(b.min, w));
}

/** Smallest text a diagram may be shrunk to; below that it keeps its width and scrolls sideways. */
export const MIN_DIAGRAM_TEXT = 11;

/**
 * Size of an svg diagram in a box `box` px wide: fit to the width, unless that would draw its smallest text under
 * MIN_DIAGRAM_TEXT px; then the width that keeps the text readable (the box scrolls). Unknown sizes fit the box.
 */
export function diagramWidth(svg: string, box: number): number {
  const root = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)/i.exec(root);
  const w = vb ? Number(vb[1]) : Number(/\swidth\s*=\s*["']([\d.]+)(px)?["']/i.exec(root)?.[1] ?? NaN);
  const sizes = [...svg.matchAll(/font-size\s*[:=]\s*["']?\s*([\d.]+)/gi)].map((m) => Number(m[1])).filter((n) => n > 0);
  // Text without an explicit size renders at 16 user units (the CSS default).
  const smallest = sizes.length ? Math.min(...sizes) : /<text\b/i.test(svg) ? 16 : 0;
  if (!(w > 0) || !smallest) return box;
  const readable = (w * MIN_DIAGRAM_TEXT) / smallest;
  return Math.max(box, Math.ceil(readable));
}

/** « Opened by @atlas · attached to card “X” ». */
export function byline(tab: Pick<PanelTab, 'openedBy' | 'cardTitle'>, userName: string | null): string {
  const who = tab.openedBy === USER ? (userName ?? 'you') : '@' + tab.openedBy;
  return `Opened by ${who}` + (tab.cardTitle ? ` · attached to card “${tab.cardTitle}”` : '');
}

/** The tab to show: the active one, or the last. */
export const activeTab = (tabs: PanelTab[]): PanelTab | undefined => tabs.find((t) => t.active) ?? tabs.at(-1);
