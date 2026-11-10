import type { SketchElement } from '@atlas/shared';

// Dark mode inverts colours, so draw in Excalidraw's default dark ink; it renders light on the dark theme.
export const STROKE = '#1e1e1e';

/**
 * The dark theme renders with invert + hue-rotate, which keeps hue but flips lightness. Agents pick colours for how
 * they should look on dark, so flip their lightness first: after the theme's inversion they come out as intended.
 */
export function forDarkTheme(color: string | undefined): string | undefined {
  const m = color?.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return color;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const L = 1 - l;
  const c = (1 - Math.abs(2 * L - 1)) * s, x = c * (1 - Math.abs((h % 2) - 1)), o = L - c / 2;
  const [R, G, B] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return '#' + [R, G, B].map((v) => Math.round(((v ?? 0) + o) * 255).toString(16).padStart(2, '0')).join('');
}

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
    const stroke = forDarkTheme(e.color) ?? STROKE;
    const common = { id: e.id, x: e.x, y: e.y, strokeColor: stroke, backgroundColor: forDarkTheme(e.background) };
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

