/**
 * The menu bar / tray orb, drawn in code (no image files): a raw BGRA bitmap at 1× and 2×, fed to nativeImage.
 * Pure, so it is tested without Electron. Shapes (card #54, approved mockup):
 *   ring   voice off / starting        hollow circle
 *   pause  listening paused            hollow circle with a pause sign
 *   solid  no voice mode (Windows)     filled circle
 *   breathe ready (« Hi Atlas »)       sea-teal disc; on macOS a native layer makes it breathe (card #56, BREATH)
 *   listen awake, listening            filled circle, soft halo pulsing (frames)
 *   think  thinking                    an arc turning around a dot (frames)
 *   speak  speaking                    filled circle with three equalizer bars cut out (frames)
 *   dot    a menu row status dot (needs you / running)
 */
export type IconKind = 'ring' | 'pause' | 'solid' | 'breathe' | 'listen' | 'think' | 'speak' | 'dot' | 'half';
export type Rgb = readonly [number, number, number];

/** Frames of the awake animations (8 at 8 fps: one turn or pulse a second). */
export const FRAMES = 8;

/** How a kind animates by swapping images: null = a still image. */
export function animation(kind: IconKind): { frames: number; fps: number } | null {
  if (kind === 'listen' || kind === 'think' || kind === 'speak') return { frames: FRAMES, fps: FRAMES };
  return null;
}

/**
 * At rest (ready), card #56: a still sea-teal disc (the image), and on macOS a Core Animation layer over it
 * (breathe.mm) that swells it a little and lets a soft glow come and go, one breath every 4 s. macOS runs that
 * animation itself: swapping images instead cost ~3% of a core at 5 fps. Sizes in points.
 */
export const BREATH = { base: 4.8, swell: 5.5, glow: 2.2, period: 4 } as const;

/** Logical size of the menu bar icon (macOS: 16 pt; 2× bitmaps are 32 px). */
export const ICON_PT = 16;

/** Coverage (0…1) of the shape at a logical point (x, y) in a 16×16 box, frame f. */
function cover(kind: IconKind, x: number, y: number, f: number): number {
  const cx = 8;
  const cy = 8;
  const d = Math.hypot(x - cx, y - cy);
  const t = (f % FRAMES) / FRAMES;
  switch (kind) {
    case 'ring':
      return d <= 6.5 && d >= 5 ? 1 : 0;
    case 'pause': {
      const ring = d <= 6.5 && d >= 5 ? 1 : 0;
      const bars = y >= 5 && y <= 11 && ((x >= 5.5 && x <= 7.25) || (x >= 8.75 && x <= 10.5)) ? 1 : 0;
      return Math.max(ring, bars);
    }
    case 'solid':
      return d <= 6.5 ? 1 : 0;
    case 'breathe':
      // the still disc under the breathing layer (and what other displays' menu bars show)
      return d <= BREATH.base ? 1 : 0;
    case 'listen': {
      if (d <= 4.8) return 1;
      // a halo leaving the core and fading out
      const r = 5.6 + 2.2 * t;
      return Math.abs(d - r) <= 0.6 ? 0.85 * (1 - t) : 0;
    }
    case 'think': {
      if (d <= 2.2) return 1;
      if (d < 5 || d > 6.8) return 0;
      // a 270° arc whose gap turns
      const a = (((Math.atan2(y - cy, x - cx) / (2 * Math.PI) - t) % 1) + 1) % 1;
      return a < 0.75 ? 1 : 0;
    }
    case 'speak': {
      if (d > 6.8) return 0;
      // bars (cut out of the disc) going up and down out of phase
      const heights = [0.45, 0.9, 0.6].map((h, i) => 1.2 + 3.2 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (t + i * 0.3))) * h);
      const xs = [5, 8, 11];
      for (let i = 0; i < 3; i++) if (Math.abs(x - xs[i]!) <= 0.9 && Math.abs(y - cy) <= heights[i]!) return 0;
      return 1;
    }
    case 'dot':
      return d <= 4.5 ? 1 : 0;
    case 'half': {
      // review: a ring half filled (Linear's status chip)
      if (d <= 5 && d >= 3.6) return 1;
      return d < 3.6 && x >= cx ? 1 : 0;
    }
  }
}

/** Windows « needs you » badge: a dot top right, with a transparent gap around it. */
function badgeCover(x: number, y: number): { dot: number; gap: number } {
  const d = Math.hypot(x - 12.5, y - 3.5);
  return { dot: d <= 3 ? 1 : 0, gap: d <= 4.3 ? 1 : 0 };
}

export interface RenderOptions {
  kind: IconKind;
  frame?: number;
  /** Bitmap size in pixels (16 = 1×, 32 = 2×). */
  px: number;
  color: Rgb;
  /** Windows: the badge dot in this colour (macOS shows the count as text next to the icon instead). */
  badge?: Rgb;
}

/** BGRA, premultiplied alpha, `px`×`px`: what nativeImage.addRepresentation / createFromBitmap take. 4×4 supersampled. */
export function renderIcon(o: RenderOptions): Buffer {
  const { px } = o;
  const buf = Buffer.alloc(px * px * 4);
  const s = ICON_PT / px;
  const n = 4;
  for (let j = 0; j < px; j++)
    for (let i = 0; i < px; i++) {
      let a = 0;
      let b = 0;
      let gap = 0;
      for (let sy = 0; sy < n; sy++)
        for (let sx = 0; sx < n; sx++) {
          const x = (i + (sx + 0.5) / n) * s;
          const y = (j + (sy + 0.5) / n) * s;
          a += cover(o.kind, x, y, o.frame ?? 0);
          if (o.badge) {
            const c = badgeCover(x, y);
            b += c.dot;
            gap += c.gap;
          }
        }
      a /= n * n;
      b /= n * n;
      gap /= n * n;
      // the badge sits on top of the orb, with a clear gap around it
      const orb = a * (1 - gap);
      const alpha = Math.min(1, orb + b);
      const mix = (k: 0 | 1 | 2) => (o.badge ? o.color[k] * orb + o.badge[k] * b : o.color[k] * orb);
      const p = (j * px + i) * 4;
      buf[p] = Math.round(Math.min(255, mix(2)));
      buf[p + 1] = Math.round(Math.min(255, mix(1)));
      buf[p + 2] = Math.round(Math.min(255, mix(0)));
      buf[p + 3] = Math.round(alpha * 255);
    }
  return buf;
}

/** '#6cc0d2' → [108, 192, 210]. */
export function hex(c: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) throw new Error(`not a #rrggbb colour: ${c}`);
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
