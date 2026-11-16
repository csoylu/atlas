import { createRequire } from 'node:module';
import { BREATH, type Rgb } from './icons.ts';

/** What breathe.mm's attach() takes: the colour (0…255) and BREATH's sizes (points) and period (seconds). */
export interface BreathLayer {
  r: number;
  g: number;
  b: number;
  base: number;
  swell: number;
  glow: number;
  period: number;
}

export const breathLayer = (color: Rgb): BreathLayer => ({ r: color[0], g: color[1], b: color[2], ...BREATH });

interface Native {
  /** true, or why the layer couldn't be added. */
  attach(o: BreathLayer): true | string;
  detach(): void;
}

let native: Native | undefined;

/**
 * The native breathing layer (macOS). Built by build.mjs into dist/native/breathe.node, next to the bundled
 * dist/main.mjs (import.meta.url). Throws if it is missing: the caller logs it and keeps the still disc.
 */
export function breather(): Native {
  if (process.platform !== 'darwin') throw new Error('the breathing layer is macOS only');
  native ??= createRequire(import.meta.url)('./native/breathe.node') as Native;
  return native;
}
