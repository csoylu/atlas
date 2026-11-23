import { describe, expect, it } from 'vitest';
import type { Card, Inbox, InboxNeed, Notification } from '@atlas/shared';
import { dayLabel, groupsOf, rowTime, inboxKey, taskEntry, taskKey, itemsOf, kindOf, lineOf, parseTab, refOf, shortAgo, shownItem, step, systemTitle, toRead, unreadOf } from './inboxView.ts';

const card = (p: Partial<Card>): Card =>
  ({ id: 'c', number: 1, title: 't', body: '', status: 'blocked', assignee: 'scout', priority: 0, board: 'main', parents: [], block: null, waiting: null, ...p }) as Card;
const need = (p: Partial<InboxNeed> & { card: Card }): InboxNeed => ({ since: '2026-11-13T10:00:00Z', failed: false, notificationId: 1, unread: true, summary: null, ...p });
const upd = (p: Partial<Notification>): Notification => ({ id: 9, at: '2026-11-13T09:00:00Z', kind: 'card.done', title: 'Palette', body: 'ok', cardId: null, readAt: null, archivedAt: null, projectId: null, link: null, ...p });
const ask = card({ id: 'c_ask', number: 39, block: { kind: 'needs_input', reason: '**Paid feed** or CoinGecko?\nmore', options: ['Paid feed', 'CoinGecko'], until: null } });
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
    expect(lineOf(a!)).toBe('Paid feed or CoinGecko?');
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

  it('groups: Needs you first, then the updates by local day; rows show waiting time or clock time', () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString(); // local time
    const now = new Date(2026, 10, 19, 12, 0).getTime();
    expect(dayLabel(at(19, 0, 5), now)).toBe('Today');
    expect(dayLabel(at(18, 23, 40), now)).toBe('Yesterday');
    expect(dayLabel(at(16, 9), now)).toBe('Monday 16 Nov');
    expect(dayLabel(new Date(2025, 11, 31, 9).toISOString(), now)).toBe('Wednesday 31 Dec 2025');
    const box: Inbox = {
      needsYou: [need({ card: ask, since: at(17, 9) })],
      updates: [upd({ id: 1, at: at(19, 1, 42) }), upd({ id: 2, at: at(19, 1, 30) }), upd({ id: 3, at: at(18, 23, 40) }), upd({ id: 4, at: at(16, 9) })],
      badge: 0,
    };
    const groups = groupsOf(itemsOf(box, 'all'), now);
    expect(groups.map((g) => [g.label, g.items.map((i) => i.key)])).toEqual([
      ['Needs you', ['c_ask']],
      ['Today', ['n1', 'n2']],
      ['Yesterday', ['n3']],
      ['Monday 16 Nov', ['n4']],
    ]);
    expect(groupsOf(itemsOf(box, 'needs'), now).map((g) => g.label)).toEqual(['Needs you']);
    expect(rowTime(groups[1]!.items[0]!, now)).toBe('01:42');
    expect(rowTime({ key: 'x', need: need({ card: ask, since: new Date(now - 4 * 60_000).toISOString() }) }, now)).toBe('4 min');
    expect(rowTime({ key: 'x', need: need({ card: ask, since: new Date(now - 3 * 3600_000).toISOString() }) }, now)).toBe('3 h');
    expect(rowTime({ key: 'x', need: need({ card: ask, since: at(17, 9) }) }, now)).toBe('2 d');
  });
});
