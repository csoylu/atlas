import { cardRef, type Card, type CardStatus } from '@atlas/shared';

/** One toast: its text and the task « Open » opens in the side panel. `key` tells two toasts apart. */
export interface ToastMsg {
  key: string;
  cardId: string;
  text: string;
}

/**
 * The only toast today (#265, atlas's ruling in the task): a task's PR merged, seen live. It fires when a card update
 * from the stream moves a card from In review to Done with a merged PR. `prev` is the status the app knew before that
 * update: undefined after a first load or a reconnect (the app does not know what changed while it was away), so a
 * move that happened while the app was closed or offline never toasts.
 */
export function mergedToast(prev: CardStatus | undefined, next: Card): ToastMsg | null {
  if (prev !== 'review' || next.status !== 'done') return null;
  const pr = next.prs.find((p) => p.state === 'merged');
  if (!pr) return null;
  return { key: `${next.id}:${pr.number}`, cardId: next.id, text: `${cardRef(next)} merged · PR #${pr.number}` };
}

/**
 * What the app knows of each card's status, to compare a live update with: filled by a full load, cleared when the
 * stream drops (what arrives before the next load cannot be compared, so it never toasts).
 */
export class StatusMemory {
  private known = new Map<string, CardStatus>();
  /** A full load (first load, or reload after a reconnect). */
  load(cards: Card[]) {
    this.known = new Map(cards.map((c) => [c.id, c.status]));
  }
  /** The stream dropped: forget everything until the next load. */
  forget() {
    this.known.clear();
  }
  /** A live update: the toast it gives, if any, and remember the new status. */
  update(card: Card): ToastMsg | null {
    const t = mergedToast(this.known.get(card.id), card);
    this.known.set(card.id, card.status);
    return t;
  }
}
