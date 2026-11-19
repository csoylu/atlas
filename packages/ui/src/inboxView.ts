import { cardRef, type Inbox, type InboxNeed, type Notification } from '@atlas/shared';
import type { IconStatus } from './StatusIcon.tsx';

/** The Inbox (design §16): pure rules, tested in inboxView.test.ts; Inbox.tsx draws them. */
export type InboxTab = 'all' | 'needs';
export type InboxItem = { key: string; need: InboxNeed; update?: undefined } | { key: string; update: Notification; need?: undefined };

/** Keys in the URL (#/inbox/<key>): a card id for « Needs you », n<id> for an update. */
export const needKey = (n: InboxNeed) => n.card.id;
export const updateKey = (u: Notification) => 'n' + u.id;

/** A link from a task note in the chat (#143): #/inbox/task:<card id>, the task's entry whatever its kind. */
export const TASK_KEY = 'task:';
export const taskKey = (cardId: string) => TASK_KEY + cardId;

/**
 * The entry a task link names: the task in « Needs you », else its latest update (a finished task). `tab`: the tab that
 * shows it ('all' for an update). Null when the task has no entry (archived update, never notified).
 */
export function taskEntry(inbox: Inbox, cardId: string): { key: string; tab: InboxTab | null } | null {
  const need = inbox.needsYou.find((n) => n.card.id === cardId);
  if (need) return { key: needKey(need), tab: null };
  const update = inbox.updates.find((u) => u.cardId === cardId);
  return update ? { key: updateKey(update), tab: 'all' } : null;
}

/** In list order: « Needs you » first, then the updates (none on the Needs you tab). */
export function itemsOf(inbox: Inbox, tab: InboxTab): InboxItem[] {
  const needs = inbox.needsYou.map((need) => ({ key: needKey(need), need }));
  return tab === 'needs' ? needs : [...needs, ...inbox.updates.map((update) => ({ key: updateKey(update), update }))];
}

/**
 * The item on screen. A key that left the list (the card moved on, the update was archived) gives its place to the
 * item now at the same position (`lastIndex`), so answering one shows the next. `wide`: list and detail side by side,
 * so something is always shown; one column shows the list until an item is picked.
 */
export function shownItem(items: InboxItem[], key: string | null, lastIndex: number, wide: boolean): InboxItem | null {
  const found = key ? items.find((i) => i.key === key) : undefined;
  if (found) return found;
  if (!items.length) return null;
  if (key) return items[Math.min(Math.max(lastIndex, 0), items.length - 1)]!;
  return wide ? items[0]! : null;
}

/** J / K: the next or previous item (stays at the ends). */
export function step(items: InboxItem[], key: string | null, dir: 1 | -1): string | null {
  if (!items.length) return null;
  const i = items.findIndex((x) => x.key === key);
  if (i < 0) return items[0]!.key;
  return items[Math.min(Math.max(i + dir, 0), items.length - 1)]!.key;
}

export type InboxKey = { kind: 'next' } | { kind: 'prev' } | { kind: 'archive' } | { kind: 'reply' } | { kind: 'option'; index: number };
/** The Inbox keys (J/K move, E archive, R reply, 1–4 pick an option), when no field has the keyboard. */
export function inboxKey(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'defaultPrevented' | 'repeat'>,
  target: EventTarget | null,
): InboxKey | null {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return null;
  const el = target as HTMLElement | null;
  if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return null;
  const k = e.key.toLowerCase();
  if (k === 'j' || e.key === 'ArrowDown') return { kind: 'next' };
  if (k === 'k' || e.key === 'ArrowUp') return { kind: 'prev' };
  if (e.repeat) return null;
  if (k === 'e') return { kind: 'archive' };
  if (k === 'r') return { kind: 'reply' };
  if (/^[1-4]$/.test(e.key)) return { kind: 'option', index: Number(e.key) - 1 };
  return null;
}

/** The word on an item's first line and its status icon. */
export function kindOf(item: InboxItem): { label: string; icon: IconStatus } {
  if (item.need) {
    const { card, failed } = item.need;
    if (card.status === 'review') return { label: 'review', icon: 'review' };
    if (failed) return { label: 'failed', icon: 'failed' };
    if (card.block?.reason.startsWith('Stopped by you')) return { label: 'stopped', icon: 'blocked' };
    if (card.block?.kind === 'needs_input') return { label: 'asked', icon: 'blocked' };
    if (card.block?.kind === 'dependency') return { label: 'waiting', icon: 'blocked' };
    return { label: 'blocked', icon: 'blocked' };
  }
  switch (item.update.kind) {
    case 'card.done':
      return { label: 'done', icon: 'done' };
    case 'schedule.ran':
      return { label: 'schedule', icon: 'done' };
    case 'run.failed':
      return { label: 'failed', icon: 'failed' };
    case 'memory.digest':
    case 'memory.cleanup':
      return { label: 'memory', icon: 'done' };
    case 'plan.exhausted':
      return { label: 'system', icon: 'failed' };
    case 'card.stalled':
      return { label: 'stuck', icon: 'blocked' };
    default:
      return { label: 'system', icon: 'blocked' };
  }
}

/** The item's third line: the first line of the question, summary, error or body (markdown marks removed). */
export function lineOf(item: InboxItem): string {
  const text = item.need
    ? item.need.card.status === 'review'
      ? (item.need.summary ?? 'Ready for your review')
      : (item.need.card.block?.reason ?? '')
    : item.update.body;
  const first = text.split('\n').map((l) => l.trim()).find((l) => l && !/^[-|:#\s]+$/.test(l)) ?? '';
  return first.replace(/^#+\s*/, '').replace(/[*_`]/g, '');
}

export const titleOf = (item: InboxItem) => (item.need ? item.need.card.title : item.update.title);
export const timeOf = (item: InboxItem) => (item.need ? item.need.since : item.update.at);
export const unreadOf = (item: InboxItem) => (item.need ? item.need.unread : !item.update.readAt);
/** The notification row opening this item marks read, if it is unread. */
export const toRead = (item: InboxItem): number | null =>
  item.need ? (item.need.unread ? item.need.notificationId : null) : item.update.readAt ? null : item.update.id;
/** « #12 » for the card the item is about, if it has a number. */
export const refOf = (item: InboxItem, numbers: Map<string, number | null>): string => {
  const id = item.need ? item.need.card.id : item.update.cardId;
  if (!id) return '';
  const n = item.need ? item.need.card.number : numbers.get(id);
  return n ? cardRef({ id, number: n }) : '';
};

/** Short time for the list: 12m, 3h, Mon, Nov 6. */
export function shortAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = new Date(t);
  if (now - t < 6 * 24 * 3600_000) return d.toLocaleDateString('en-GB', { weekday: 'short' });
  return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }).replace(/^(\d+) (\w+)$/, '$2 $1');
}

/** The macOS notification's title for a new row. */
export function systemTitle(n: Pick<Notification, 'kind' | 'title'>): string {
  const lead: Record<string, string> = {
    'card.blocked': 'Needs you',
    'card.review': 'Ready for review',
    'card.done': 'Done',
    'run.failed': 'Failed',
    'schedule.ran': 'Schedule ran',
  };
  return lead[n.kind] ? `${lead[n.kind]} · ${n.title}` : n.title;
}

/** Saved tab, kept across reloads. */
export const parseTab = (raw: string | null): InboxTab => (raw === 'needs' ? 'needs' : 'all');
