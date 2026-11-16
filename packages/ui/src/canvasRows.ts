/**
 * Canvas, memory and schedule tools in the chat (#64, mockup pages/chat-activity.html §5): the pure part. Reads the
 * engine's tool outputs (canvasTools.ts, teamTools.ts) and lays out a canvas thumbnail.
 */

export interface CanvasLine {
  id: string;
  name: string;
  version: number;
  by: string;
}

/** canvas_list output: « cv_x "name" v3 (by atlas) » per line. */
export function canvasList(out: string): CanvasLine[] {
  return out.split('\n').flatMap((l) => {
    const m = /^(cv_\w+) "(.*)" v(\d+)(?: \(by (.*)\))?$/.exec(l.trim());
    return m ? [{ id: m[1]!, name: m[2]!, version: Number(m[3]), by: m[4] ?? '' }] : [];
  });
}

/** The canvas a canvas tool is about: its input id, or the id canvas_create returned. */
export function canvasIdOf(name: string, input: unknown, out: string | null): string | null {
  if (name === 'canvas_create') return out ? (/created (cv_\w+)/.exec(out)?.[1] ?? null) : null;
  const id = (input as { id?: unknown } | null)?.id;
  return (name === 'canvas_write' || name === 'canvas_read') && typeof id === 'string' && id ? id : null;
}

export interface ThumbBox {
  id: string;
  kind: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Nodes as boxes in a viewBox that fits them all, with a margin (empty canvas: null). */
export function thumbLayout(nodes: ThumbBox[]): { viewBox: string; boxes: ThumbBox[] } | null {
  if (!nodes.length) return null;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const w = Math.max(...nodes.map((n) => n.x + n.w)) - minX;
  const h = Math.max(...nodes.map((n) => n.y + n.h)) - minY;
  // A margin of 6% of the larger side, and a 2:1 frame so a single tall node doesn't fill the thumbnail edge to edge.
  const pad = Math.max(w, h) * 0.06;
  let vw = w + 2 * pad;
  let vh = h + 2 * pad;
  if (vw < vh * 2) vw = vh * 2;
  else vh = Math.max(vh, vw / 2);
  const x0 = minX - (vw - w) / 2;
  const y0 = minY - (vh - h) / 2;
  return { viewBox: `${round(x0)} ${round(y0)} ${round(vw)} ${round(vh)}`, boxes: nodes };
}
const round = (n: number) => Math.round(n * 10) / 10;

/** memory_edit: what it did, for the quote's footer: « appended · own memory ». */
export function memoryFoot(input: unknown): string {
  const o = (input ?? {}) as { mode?: unknown; scope?: unknown };
  return `${o.mode === 'replace' ? 'replaced' : 'appended'} · ${o.scope === 'shared' ? 'shared memory' : 'own memory'}`;
}

export interface ScheduleLine {
  id: string;
  agent: string;
  title: string;
  when: string;
  /** « next 2026-… · own card #12 · LAST RUN FAILED: … » */
  more: string;
  failed: boolean;
}

/** schedule_list output: « sch_x @atlas "title": when · next … · … » per line. */
export function scheduleList(out: string): ScheduleLine[] {
  return out.split('\n').flatMap((l) => {
    const m = /^(sch_\w+) @(\S+) "(.*)": (.*)$/.exec(l.trim());
    if (!m) return [];
    const [when, ...more] = m[4]!.split(' · ');
    return [{ id: m[1]!, agent: m[2]!, title: m[3]!, when: when!, more: more.join(' · '), failed: more.some((p) => p.startsWith('LAST RUN FAILED')) }];
  });
}

/** schedule_create output: « scheduled sch_x "title" for @atlas: when, first run ISO ». */
export function scheduleCreated(out: string): { id: string; title: string; agent: string; when: string; first: string } | null {
  const m = /^scheduled (sch_\w+) "(.*)" for @(\S+): (.*), first run (\S+)$/.exec(out.trim());
  return m ? { id: m[1]!, title: m[2]!, agent: m[3]!, when: m[4]!, first: m[5]! } : null;
}

/** "2026-11-12T00:35:00+01:00" → "Thu 12 Nov 00:35" (local time); anything else as is. */
export function whenText(iso: string): string {
  const d = new Date(iso);
  if (!/^\d{4}-\d\d-\d\dT/.test(iso) || Number.isNaN(d.getTime())) return iso;
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  return `${day} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** Every ISO time in a line made readable: « once at 2026-11-12T00:35:00.000Z » → « once at Thu 12 Nov 01:35 ». */
export const humanTimes = (s: string) => s.replace(/\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)?/g, whenText);
