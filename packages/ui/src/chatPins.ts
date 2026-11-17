import type { Card } from '@atlas/shared';
import { pillStatus } from './cardModal.ts';

/**
 * Pure helpers for the pinned ticket cards at the top-left of a direct chat (mockup `mockups/workflow.html`,
 * scenarios 1–3): which cards of the chat are pinned, what each pin says, and the system lines that open a card.
 */

/** How long a done / closed / deleted pin stays before it fades out (hover pauses it). */
export const FADE_MS = 30_000;

export type PinKind = 'running' | 'waiting' | 'blocked' | 'review' | 'stopped' | 'done' | 'closed' | 'deleted';

export interface Pin {
  id: string;
  title: string;
  kind: PinKind;
  /** When the card started the current run state (ms), for "running · 2:14"; null when unknown. */
  since: number | null;
  /** When it finished (done / closed / deleted, ms); null while it isn't. */
  finishedAt: number | null;
}

/** Pins that fade out on their own; the others stay until the card moves (or the user unpins them). */
export const fades = (k: PinKind) => k === 'done' || k === 'closed' || k === 'deleted';

/** What a card looks like as a pin. */
export function pinKind(card: Pick<Card, 'status' | 'block'>): PinKind {
  const s = pillStatus(card, null);
  if (s === 'archived') return 'closed';
  if (s === 'triage' || s === 'todo' || s === 'ready') return 'waiting';
  return s;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

/** The pin's live state: "Working · 2:14", "done", "stopped by you", "needs your OK"… */
export function pinLabel(pin: Pick<Pin, 'kind' | 'since'>, now: number): string {
  switch (pin.kind) {
    case 'running':
      return pin.since === null ? 'Working' : `Working · ${clock(now - pin.since)}`;
    case 'waiting':
      return 'waiting';
    case 'blocked':
      return 'needs your OK';
    case 'review':
      return 'ready for review';
    case 'stopped':
      return 'stopped by you';
    default:
      return pin.kind;
  }
}

/** Key of a pin the user unpinned (or that faded): the same card comes back if it moves to another state. */
export const dismissKey = (p: Pick<Pin, 'id' | 'kind'>) => `${p.id}:${p.kind}`;

/**
 * The chat's pins after `cards` changed, newest first. A finished card is pinned only if it finished while the chat
 * was open (or less than FADE_MS ago); a pinned card that disappears from `cards` turns into a "deleted" pin.
 */
export function nextPins(prev: Pin[], cards: Card[], chatId: string, now: number, dismissed: ReadonlySet<string>): Pin[] {
  const mine = cards.filter((c) => c.originCard === chatId);
  const byId = new Map(prev.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: Pin[] = [];
  for (const c of mine) {
    seen.add(c.id);
    const kind = pinKind(c);
    const old = byId.get(c.id);
    const updated = Date.parse(c.updatedAt);
    let finishedAt: number | null = null;
    if (fades(kind)) {
      if (old && old.kind === kind && old.finishedAt !== null) finishedAt = old.finishedAt;
      else if (old) finishedAt = now;
      else if (now - updated < FADE_MS) finishedAt = Math.min(now, updated);
      else continue;
    }
    const since = kind !== 'running' ? null : old?.kind === 'running' && old.since !== null ? old.since : Math.min(now, updated);
    const pin: Pin = { id: c.id, title: c.title, kind, since, finishedAt };
    if (!dismissed.has(dismissKey(pin))) out.push(pin);
  }
  for (const p of prev) {
    if (seen.has(p.id)) continue;
    const gone: Pin = p.kind === 'deleted' ? p : { ...p, kind: 'deleted', since: null, finishedAt: now };
    if (!dismissed.has(dismissKey(gone))) out.push(gone);
  }
  // Newest first; pins already shown keep their place relative to each other.
  const order = new Map(prev.map((p, i) => [p.id, i]));
  const created = new Map(mine.map((c) => [c.id, c.createdAt]));
  return out.sort((a, b) => {
    const ia = order.get(a.id);
    const ib = order.get(b.id);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return 1;
    if (ib !== undefined) return -1;
    return (created.get(b.id) ?? '').localeCompare(created.get(a.id) ?? '');
  });
}

/**
 * A report-back line from the engine ("✓ Card “X” (#12) finished: …", or c_1a2b3c4d in older ones): the card it is about, and the text
 * without the id in brackets, so the whole line can open the card.
 */
export function sysLine(text: string): { card: string | null; text: string } {
  const m = /^(.*?“.*?”) \((#\d+|c_[0-9a-f]{8})\)/s.exec(text);
  if (!m) return { card: null, text };
  return { card: m[2]!, text: m[1]! + text.slice(m[0].length) };
}
