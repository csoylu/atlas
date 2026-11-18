import { describe, expect, it } from 'vitest';
import type { Memory, MemoryChange } from '@atlas/shared';
import {
  chipCounts,
  digestChanges,
  digestItem,
  digestLine,
  focusSeqFor,
  groupForSeq,
  memoryHref,
  parseMarks,
  parseMemoryRoute,
  parseMemView,
  scopeLabel,
  shownMemories,
  sourceLink,
  undoable,
  withDigest,
} from './memoryView.ts';

const mem = (p: Partial<Memory>): Memory => ({
  id: 1, kind: 'fact', scope: 'agent:atlas', projectId: 'atlas', text: 't', sourceConversationId: null, sourceSeq: null, sourceCardId: null, cardId: null,
  status: 'active', pinned: false, createdAt: '2026-11-16T10:00:00Z', confirmedAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:00:00Z', updatedBy: 'atlas', ...p,
});
const ch = (p: Partial<MemoryChange>): MemoryChange => ({ id: 1, memoryId: 1, at: '2026-11-17T08:00:00Z', by: 'atlas', action: 'add', before: null, undoneBy: null, ...p });

describe('memory page', () => {
  const list = [
    mem({ id: 1, kind: 'rule', updatedAt: '2026-11-16T09:00:00Z' }),
    mem({ id: 2, kind: 'fact', updatedAt: '2026-11-16T12:00:00Z' }),
    mem({ id: 3, kind: 'project', status: 'stale', updatedAt: '2026-11-16T13:00:00Z' }),
    mem({ id: 4, kind: 'fact', status: 'archived' }),
    mem({ id: 5, kind: 'preference', pinned: true, updatedAt: '2026-11-01T00:00:00Z' }),
  ];
  it('shows active and stale by default: pinned first, stale last, newest change first', () => {
    expect(shownMemories(list, { kind: 'all', status: 'live' }).map((m) => m.id)).toEqual([5, 2, 1, 3]);
    expect(shownMemories(list, { kind: 'fact', status: 'live' }).map((m) => m.id)).toEqual([2]);
    expect(shownMemories(list, { kind: 'all', status: 'archived' }).map((m) => m.id)).toEqual([4]);
  });
  it('counts each chip', () => {
    expect(chipCounts(list, 'live')).toEqual({ all: 4, rule: 1, preference: 1, fact: 1, project: 1, stale: 1, archived: 1 });
    expect(chipCounts(list, 'archived').fact).toBe(1);
  });
  it('reads the saved view and the route', () => {
    expect(parseMemView('{"kind":"fact","status":"stale","scope":"shared"}')).toEqual({ kind: 'fact', status: 'stale', scope: 'shared' });
    expect(parseMemView('{bad')).toEqual({ kind: 'all', status: 'live', scope: null });
    expect(parseMemView('{"kind":"x","scope":"agent:BAD"}')).toEqual({ kind: 'all', status: 'live', scope: null });
    expect(parseMemoryRoute('agent:atlas')).toEqual({ scope: 'agent:atlas', focus: null });
    expect(parseMemoryRoute('m12')).toEqual({ scope: null, focus: 12 });
    expect(parseMemoryRoute('')).toEqual({ scope: null, focus: null });
    expect(memoryHref()).toBe('#/settings/memory');
    expect(memoryHref(12)).toBe('#/settings/memory/m12');
    expect(memoryHref('shared')).toBe('#/settings/memory/shared');
    expect(scopeLabel('agent:atlas')).toBe('@atlas');
    expect(scopeLabel('shared')).toBe('shared');
  });
  it('links the source: the chat message, the board card ticket, or the project card', () => {
    const chats = [{ id: 'c_chat' }];
    expect(sourceLink(mem({ sourceCardId: 'c_chat', sourceSeq: 12 }), chats, '#/settings/memory')).toEqual({ href: '#/chat/c_chat?msg=12', chat: true, cardId: 'c_chat' });
    expect(sourceLink(mem({ sourceCardId: 'c_b', sourceSeq: 4 }), chats, '#/settings/memory')).toEqual({ href: '#/settings/memory?card=c_b&msg=4', chat: false, cardId: 'c_b' });
    expect(sourceLink(mem({ cardId: 'c_p' }), chats, '#/settings/memory')?.href).toBe('#/settings/memory?card=c_p');
    expect(sourceLink(mem({}), chats, '#/settings/memory')).toBeNull();
  });
  it('knows which conversation should show the message', () => {
    expect(focusSeqFor('#/chat/c_1?msg=12', 'c_1')).toBe(12);
    expect(focusSeqFor('#/chat/c_1?msg=12', 'c_2')).toBeNull();
    expect(focusSeqFor('#/settings/memory?card=c_2&msg=4', 'c_2')).toBe(4);
    expect(focusSeqFor('#/chat/c_1?card=c_2&msg=4', 'c_1')).toBeNull(); // the ticket over the chat shows it, not the chat
    expect(focusSeqFor('#/chat/c_1', 'c_1')).toBeNull();
    expect(focusSeqFor('#/chat/c_1?msg=x', 'c_1')).toBeNull();
    expect(groupForSeq([1, 3, 9], 5)).toBe(1);
    expect(groupForSeq([1, 3, 9], 9)).toBe(2);
    expect(groupForSeq([4], 2)).toBe(-1);
  });
});

describe('memory digest', () => {
  const changes = [
    ch({ id: 1, memoryId: 1, action: 'add' }),
    ch({ id: 2, memoryId: 1, action: 'update', before: { text: 'old', kind: 'fact', scope: 'shared', projectId: 'atlas', status: 'active', pinned: false }, at: '2026-11-17T09:00:00Z' }),
    ch({ id: 3, memoryId: 2, action: 'add', by: 'scout' }),
    ch({ id: 4, memoryId: 2, action: 'confirm' }),
    ch({ id: 5, memoryId: 3, action: 'update', by: 'user' }),
    ch({ id: 6, memoryId: 4, action: 'stale', by: 'user', at: '2026-11-17T10:00:00Z' }),
  ];
  it('reports agent changes and stale marks, not yours or confirmations', () => {
    expect(digestChanges(changes, { seen: null, archived: null }).map((c) => c.id)).toEqual([6, 3, 2, 1]);
    expect(digestChanges(changes, { seen: null, archived: '2026-11-17T08:30:00Z' }).map((c) => c.id)).toEqual([6, 2]);
    expect(digestLine(digestChanges(changes, { seen: null, archived: null }))).toBe('2 added, 1 changed, 1 went stale · by @scout, @atlas');
  });
  it('undo only applies to the latest change of a memory', () => {
    expect([...undoable(changes)].sort()).toEqual([2, 3, 5, 6]);
    expect([...undoable([ch({ id: 1 }), ch({ id: 2, action: 'update', undoneBy: 7 })])]).toEqual([1]);
  });
  it('is one Inbox row, read once seen past its newest change, gone when archived', () => {
    const none = { seen: null, archived: null };
    const it = digestItem(changes, none)!;
    expect(it).toMatchObject({ id: -1, kind: 'memory.digest', at: '2026-11-17T10:00:00Z', readAt: null, title: 'Memory: 3 memories changed in the last day' });
    expect(digestItem(changes, { seen: '2026-11-17T10:00:00Z', archived: null })!.readAt).toBe('2026-11-17T10:00:00Z');
    expect(digestItem(changes, { seen: null, archived: '2026-11-17T10:00:00Z' })).toBeNull();
    expect(digestItem([], none)).toBeNull();
    expect(parseMarks('{"seen":"2026-11-17T10:00:00Z","archived":"nope"}')).toEqual({ seen: '2026-11-17T10:00:00Z', archived: null });
    expect(parseMarks('{')).toEqual({ seen: null, archived: null });
  });
  it('sits among the Inbox updates by time and counts in the badge while unread', () => {
    const n = (id: number, at: string) => ({ id, at, kind: 'card.done', title: 't', body: '', cardId: null, readAt: null, archivedAt: null, projectId: null });
    const inbox = { needsYou: [], updates: [n(1, '2026-11-17T11:00:00Z'), n(2, '2026-11-17T09:00:00Z')], badge: 2 };
    const d = digestItem(changes, { seen: null, archived: null });
    const out = withDigest(inbox, d);
    expect(out.updates.map((u) => u.id)).toEqual([1, -1, 2]);
    expect(out.badge).toBe(3);
    expect(withDigest(inbox, { ...d!, readAt: d!.at }).badge).toBe(2);
    expect(withDigest(inbox, null)).toBe(inbox);
  });
});
