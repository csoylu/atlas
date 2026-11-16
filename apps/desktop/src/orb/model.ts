/**
 * The voice orb's pure parts, shared by the overlay window (main process) and its page (renderer). No Electron, no DOM:
 * unit-tested in model.test.ts.
 */

export const ORB_STATES = ['idle', 'wake', 'listening', 'thinking', 'speaking'] as const;
export type OrbState = (typeof ORB_STATES)[number];

export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}

/** Core radius of the awake orb, in points (the mockup's 56 px). */
export const ORB_RADIUS = 56;
/** The orb's drawing box (glow and ripples included), centred on the orb. */
export const ORB_BOX = 820;
/** Keep the orb centre this far inside the screen's usable area, so it can't be dragged out of reach. */
export const EDGE_MARGIN = 40;

/** First launch: bottom-right of the usable area (menu bar and Dock excluded), as in the approved mockup. */
export function defaultOrbPosition(workArea: Rect): Point {
  return { x: workArea.x + workArea.width - 118, y: workArea.y + workArea.height - 150 };
}

export function clampToArea(p: Point, area: Rect, margin = EDGE_MARGIN): Point {
  return {
    x: Math.min(area.x + area.width - margin, Math.max(area.x + margin, p.x)),
    y: Math.min(area.y + area.height - margin, Math.max(area.y + margin, p.y)),
  };
}

/**
 * Where the orb was left, relative to its display (absolute pixels mean nothing once the monitors change: the laptop's
 * bottom-right corner is the middle of an ultrawide). x/y: orb centre from the work area's top-left; width/height: that
 * work area's size when it was saved; display: Electron's display id.
 */
export interface OrbPlace {
  display: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  id: number;
  workArea: Rect;
}

/** The place of a point on a display's work area (what is saved after a drag). */
export function placeOf(p: Point, display: DisplayLike): OrbPlace {
  const a = display.workArea;
  return { display: display.id, x: p.x - a.x, y: p.y - a.y, width: a.width, height: a.height };
}

/**
 * One axis of a saved place on a work area of another size: near an edge (outer quarter) the orb keeps its distance
 * from that edge (bottom-right stays bottom-right), in between it keeps its fraction of the width. Same size: exact.
 */
function axis(d: number, saved: number, start: number, size: number): number {
  if (d <= saved / 4) return start + d;
  if (d >= (saved * 3) / 4) return start + size - (saved - d);
  return start + (d / saved) * size;
}

/**
 * Where to show the orb: on its saved display if it is connected, else on the primary display at the same corner (or
 * fraction); first launch: bottom-right of the primary display. Always clamped to the work area.
 */
export function restoreOrb(place: OrbPlace | null, displays: DisplayLike[], primaryId: number): { display: number; pos: Point } {
  const primary = displays.find((d) => d.id === primaryId);
  if (!primary) throw new Error(`primary display ${primaryId} is not in the display list`);
  if (!place) return { display: primary.id, pos: clampToArea(defaultOrbPosition(primary.workArea), primary.workArea) };
  const d = displays.find((x) => x.id === place.display) ?? primary;
  const a = d.workArea;
  const pos = { x: Math.round(axis(place.x, place.width, a.x, a.width)), y: Math.round(axis(place.y, place.height, a.y, a.height)) };
  return { display: d.id, pos: clampToArea(pos, a) };
}

/** The part of the overlay that takes the mouse: the small ember at rest, the core (a bit larger) when awake. */
export function hitRadius(state: OrbState): number {
  return state === 'idle' ? 22 : ORB_RADIUS + 10;
}

export function isOnOrb(mouse: Point, orb: Point, state: OrbState): boolean {
  return Math.hypot(mouse.x - orb.x, mouse.y - orb.y) <= hitRadius(state);
}

/** RMS of an audio frame → 0…1 for the animation: -50 dBFS (room noise) = 0, -10 dBFS (loud voice) = 1. */
export function levelFromRms(rms: number): number {
  if (!(rms > 0)) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(rms) + 50) / 40));
}

export function rms(samples: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(s / samples.length) : 0;
}

/** The caption bubble sits left of the orb (mockup) unless the orb is too close to the left edge for it. */
export function bubbleSide(orbX: number, viewportX = 0): 'left' | 'right' {
  return orbX - viewportX < 520 ? 'right' : 'left';
}

/** Frame-time summary: intervals between animation frames in ms. Long frame = more than two 60 Hz frames (> 33.4 ms). */
export function frameStats(intervals: readonly number[]): { frames: number; p50: number; p95: number; p99: number; max: number; long: number } {
  const s = [...intervals].sort((a, b) => a - b);
  const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! : 0);
  const r = (n: number) => Math.round(n * 100) / 100;
  return { frames: s.length, p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(s.at(-1) ?? 0), long: s.filter((d) => d > 33.4).length };
}

/** Typewriter pacing for a spoken sentence: spread its characters over the audio, 12…60 ms each. */
export function typeDelay(text: string, audioSeconds: number): number {
  return Math.min(60, Math.max(12, (audioSeconds * 1000 * 0.9) / Math.max(1, text.length)));
}

/**
 * The reply line of the caption when the orb enters `state`: '' = cleared, undefined = kept (idle hides the bubble).
 * Wake clears it and types nothing: « Yes, Master? » is typed by speak() while it is heard. Typing it on wake too
 * showed it twice (card #40).
 */
export function replyLineOnEnter(state: OrbState): string | undefined {
  return state === 'idle' ? undefined : '';
}

/** The reply line once `sentence` is spoken: appended to what is shown. */
export function withSentence(line: string, sentence: string): string {
  return (line ? `${line} ` : '') + sentence;
}
