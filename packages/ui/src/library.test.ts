import { describe, expect, it } from 'vitest';
import type { Doc } from '@atlas/shared';
import { filterCount, groupDocs, matches, parseLibView, relAgo } from './library.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const doc = (id: string, patch: Partial<Doc> = {}): Doc => ({
  id, agentId: 'atlas', path: `docs/${id}.md`, canvasId: null, kind: 'markdown', title: id, cardId: null, version: 1,
  updatedBy: 'atlas', updatedAt: ago(1), pinned: false, chatId: null, ...patch,
});

describe('library view', () => {
  it('groups pinned, this week, earlier, latest first, without empty groups', () => {
    const g = groupDocs([doc('old', { updatedAt: ago(24 * 9) }), doc('a', { updatedAt: ago(2) }), doc('pin', { pinned: true, updatedAt: ago(24 * 30) }), doc('b', { updatedAt: ago(1) })], NOW);
    expect(g.map((x) => [x.id, x.docs.map((d) => d.id)])).toEqual([['pinned', ['pin']], ['week', ['b', 'a']], ['earlier', ['old']]]);
    expect(groupDocs([doc('a')], NOW).map((x) => x.id)).toEqual(['week']);
  });

  it('filters by type tab, agent, card and chat', () => {
    const wb = doc('w', { kind: 'whiteboard', path: null, canvasId: 'cv', agentId: 'user', chatId: 'c_chat' });
    const md = doc('m', { cardId: 'c_1' });
    expect([wb, md].filter((d) => matches(d, 'whiteboards', { agent: null, card: null, chat: null }))).toEqual([wb]);
    expect([wb, md].filter((d) => matches(d, 'all', { agent: 'atlas', card: null, chat: null }))).toEqual([md]);
    expect([wb, md].filter((d) => matches(d, 'all', { agent: null, card: 'c_1', chat: null }))).toEqual([md]);
    expect([wb, md].filter((d) => matches(d, 'all', { agent: null, card: null, chat: 'c_chat' }))).toEqual([wb]);
    expect(filterCount({ agent: 'a', card: null, chat: 'c' })).toBe(2);
  });

  it('parses a saved view and falls back on anything odd', () => {
    expect(parseLibView(null)).toEqual({ tab: 'all', filter: { agent: null, card: null, chat: null } });
    expect(parseLibView('{"tab":"pages","filter":{"agent":"scout","card":3}}')).toEqual({ tab: 'pages', filter: { agent: 'scout', card: null, chat: null } });
    expect(parseLibView('{"tab":"nope"}').tab).toBe('all');
    expect(parseLibView('not json').tab).toBe('all');
  });

  it('says how long ago', () => {
    expect(relAgo(ago(0), NOW)).toBe('just now');
    expect(relAgo(new Date(NOW - 2 * 60_000).toISOString(), NOW)).toBe('2 min ago');
    expect(relAgo(ago(3), NOW)).toBe('3 h ago');
    expect(relAgo(ago(30), NOW)).toBe('yesterday');
    expect(relAgo(ago(24 * 5), NOW)).toBe('8 Nov');
  });
});
