import type { SketchElement } from '@atlas/shared';

/**
 * Colours are passed through as written, in Excalidraw's light palette (what models know). The light theme shows them
 * as is; Excalidraw's dark theme derives the dark version itself (invert + hue-rotate), like any Excalidraw drawing.
 */
export const STROKE = '#1e1e1e';

type Box = { x: number; y: number; w: number; h: number };

/** Point where the segment from a box's centre towards (tx, ty) leaves the box, plus a small gap. */
function edge(b: Box, tx: number, ty: number): [number, number] {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
  const len = Math.hypot(dx, dy), gap = 6 / len;
  return [cx + dx * (t + gap), cy + dy * (t + gap)];
}

/** Agent sketch → Excalidraw skeletons (design §11): the model never writes raw Excalidraw JSON. */
export function sketchToSkeletons(sketch: SketchElement[]) {
  const boxes = new Map<string, Box>();
  for (const e of sketch)
    if (e.id && e.type !== 'arrow' && e.type !== 'line') boxes.set(e.id, { x: e.x, y: e.y, w: e.width ?? 160, h: e.height ?? 80 });
  return sketch.map((e) => {
    const stroke = e.color ?? STROKE;
    const common = { id: e.id, x: e.x, y: e.y, strokeColor: stroke, backgroundColor: e.background };
    switch (e.type) {
      case 'text':
        return { ...common, type: 'text' as const, text: e.label ?? '' };
      case 'arrow':
      case 'line': {
        // Connected arrows are laid out from the boxes they join, whatever coordinates the model guessed.
        const a = e.from ? boxes.get(e.from) : undefined, b = e.to ? boxes.get(e.to) : undefined;
        let geo = { x: e.x, y: e.y, width: e.width ?? 100, height: e.height ?? 0 };
        if (a && b) {
          const [sx, sy] = edge(a, b.x + b.w / 2, b.y + b.h / 2);
          const [ex, ey] = edge(b, a.x + a.w / 2, a.y + a.h / 2);
          geo = { x: sx, y: sy, width: ex - sx, height: ey - sy };
        }
        return {
          ...common,
          ...geo,
          type: e.type,
          ...(e.type === 'arrow' && a ? { start: { id: e.from } } : {}),
          ...(e.type === 'arrow' && b ? { end: { id: e.to } } : {}),
          ...(e.label ? { label: { text: e.label, strokeColor: stroke } } : {}),
        };
      }
      default:
        return {
          ...common,
          type: e.type === 'frame' ? ('rectangle' as const) : e.type,
          width: e.width ?? 160,
          height: e.height ?? 80,
          roundness: e.type === 'rectangle' ? { type: 3 } : undefined,
          ...(e.label ? { label: { text: e.label, strokeColor: stroke } } : {}),
        };
    }
  });
}

