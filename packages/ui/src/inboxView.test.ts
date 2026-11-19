import { describe, expect, it } from 'vitest';
import type { Card, Inbox, InboxNeed, Notification } from '@atlas/shared';
import { inboxKey, taskEntry, taskKey, itemsOf, kindOf, lineOf, parseTab, refOf, shortAgo, shownItem, step, systemTitle, toRead, unreadOf } from './inboxView.ts';

const card = (p: Partial<Card>): Card =>
  ({ id: 'c', number: 1, title: 't', body: '', status: 'blocked', assignee: 'scout', priority: 0, board: 'main', parents: [], block: null, waiting: null, ...p }) as Card;
const need = (p: Partial<InboxNeed> & { card: Card }): InboxNeed => ({ since: '2026-11-13T10:00:00Z', failed: false, notificationId: 1, unread: true, summary: null, ...p });
const upd = (p: Partial<Notification>): Notification => ({ id: 9, at: '2026-11-13T09:00:00Z', kind: 'card.done', title: 'Palette', body: 'ok', cardId: null, readAt: null, archivedAt: null, projectId: null, ...p });
const ask = card({ id: 'c_ask', number: 39, block: { kind: 'needs_input', reason: '**Kaiko** or CoinGecko?\nmore', options: ['Kaiko', 'CoinGecko'], until: null } });
const inbox: Inbox = {
  needsYou: [need({ card: ask }), need({ card: card({ id: 'c_rev', number: 40, status: 'review' }), summary: '2 400 words', unread: false, notificationId: 2 })],
  updates: [upd({ id: 5, cardId: 'c_done' }), upd({ id: 6, kind: 'plan.switched', title: 'Claude plan limit reached', readAt: '2026-11-13T09:30:00Z' })],
  badge: 3,
};

describe('inbox view', () => {
  it('lists needs you first, then updates; the Needs you tab only the first', () => {
    expect(itemsOf(inbox, 'all').map((i) => i.key)).toEqual(['c_ask', 'c_rev', 'n5', 'n6']);
    expect(itemsOf(inbox, 'needs').map((i) => i.key)).toEqual(['c_ask', 'c_rev']);
  });

  it('shows the selected item; one that left gives its place to the next; wide shows the first by default', () => {
    const items = itemsOf(inbox, 'all');
    expect(shownItem(items, 'n5', 0, true)?.key).toBe('n5');
    expect(shownItem(items, 'c_gone', 1, false)?.key).toBe('c_rev'); // answered #39: the next one at its place
    expect(shownItem(items, 'c_gone', 9, true)?.key).toBe('n6'); // was last: the new last
    expect(shownItem(items, null, 0, true)?.key).toBe('c_ask');
    expect(shownItem(items, null, 0, false)).toBeNull(); // one column: the list until you pick
    expect(shownItem([], 'x', 0, true)).toBeNull();
  });

  it('a task link from the chat (#143) finds the task in Needs you, else its latest update, else nothing', () => {
    expect(taskKey('c_ask')).toBe('task:c_ask');
    expect(taskEntry(inbox, 'c_ask')).toEqual({ key: 'c_ask', tab: null });
    expect(taskEntry(inbox, 'c_done')).toEqual({ key: 'n5', tab: 'all' });
    expect(taskEntry(inbox, 'c_none')).toBeNull();
  });

  it('J/K step and stop at the ends', () => {
    const items = itemsOf(inbox, 'all');
    expect(step(items, 'c_ask', 1)).toBe('c_rev');
    expect(step(items, 'c_ask', -1)).toBe('c_ask');
    expect(step(items, 'n6', 1)).toBe('n6');
    expect(step(items, null, 1)).toBe('c_ask');
    expect(step([], null, 1)).toBeNull();
  });

  it('keys: J/K/E/R/1–4, never while typing or with a modifier', () => {
    const k = (key: string, more: Partial<KeyboardEvent> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, repeat: false, ...more });
    expect(inboxKey(k('j'), null)).toEqual({ kind: 'next' });
    expect(inboxKey(k('K'), null)).toEqual({ kind: 'prev' });
    expect(inboxKey(k('e'), null)).toEqual({ kind: 'archive' });
    expect(inboxKey(k('r'), null)).toEqual({ kind: 'reply' });
    expect(inboxKey(k('2'), null)).toEqual({ kind: 'option', index: 1 });
    expect(inboxKey(k('5'), null)).toBeNull();
    expect(inboxKey(k('e', { metaKey: true }), null)).toBeNull();
    expect(inboxKey(k('e', { repeat: true }), null)).toBeNull(); // held E doesn't archive the whole list
    expect(inboxKey(k('e'), { tagName: 'TEXTAREA', isContentEditable: false } as unknown as EventTarget)).toBeNull();
  });

  it('kind, line, unread, ref and what opening reads', () => {
    const [a, r, d, s] = itemsOf(inbox, 'all');
    expect([a, r, d, s].map((i) => kindOf(i!).label)).toEqual(['asked', 'review', 'done', 'system']);
    expect(kindOf({ key: 'x', need: need({ card: ask, failed: true }) }).icon).toBe('failed');
    expect(kindOf({ key: 'y', update: { ...s!.update!, kind: 'card.stalled' } }).label).toBe('stuck');
    expect(lineOf(a!)).toBe('Kaiko or CoinGecko?');
    expect(lineOf(r!)).toBe('2 400 words');
    expect([a, r, d, s].map((i) => unreadOf(i!))).toEqual([true, false, true, false]);
    expect([a, r, d, s].map((i) => toRead(i!))).toEqual([1, null, 5, null]);
    expect(refOf(a!, new Map())).toBe('#39');
    expect(refOf(d!, new Map([['c_done', 43]]))).toBe('#43');
    expect(refOf(s!, new Map())).toBe('');
  });

  it('short times, system notification titles, saved tab', () => {
    const now = Date.parse('2026-11-13T12:00:00Z');
    expect(shortAgo('2026-11-13T11:48:00Z', now)).toBe('12m');
    expect(shortAgo('2026-11-13T09:00:00Z', now)).toBe('3h');
    expect(shortAgo('2026-11-01T09:00:00Z', now)).toBe('Nov 1');
    expect(systemTitle({ kind: 'card.blocked', title: 'Pick a source' })).toBe('Needs you · Pick a source');
    expect(systemTitle({ kind: 'plan.switched', title: 'Claude plan limit reached' })).toBe('Claude plan limit reached');
    expect(parseTab('needs')).toBe('needs');
    expect(parseTab('junk')).toBe('all');
  });
});
