import { USER, type PanelTab } from '@atlas/shared';

/** Side by side above 960px, an overlay over the chat down to 760px, full screen below (phones). */
export type PanelMode = 'side' | 'overlay' | 'full';
export const panelMode = (viewport: number): PanelMode => (viewport > 960 ? 'side' : viewport > 760 ? 'overlay' : 'full');

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
