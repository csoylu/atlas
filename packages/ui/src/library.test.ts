import { describe, expect, it } from 'vitest';
import type { Doc } from '@atlas/shared';
import { filterCount, folderCounts, folderLabel, groupDocs, inFolder, matches, orderFolders, parseLibView, recentDocs, relAgo } from './library.ts';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const doc = (id: string, patch: Partial<Doc> = {}): Doc => ({
  id, agentId: 'atlas', path: `docs/${id}.md`, kind: 'markdown', title: id, cardId: null, version: 1,
  updatedBy: 'atlas', updatedAt: ago(1), pinned: false, folderId: null, chatId: null, projectId: 'atlas', filesRoot: 'atlas', ...patch,
});

describe('library view', () => {
  it('groups pinned, this week, earlier, latest first, without empty groups', () => {
    const g = groupDocs([doc('old', { updatedAt: ago(24 * 9) }), doc('a', { updatedAt: ago(2) }), doc('pin', { pinned: true, updatedAt: ago(24 * 30) }), doc('b', { updatedAt: ago(1) })], NOW);
    expect(g.map((x) => [x.id, x.docs.map((d) => d.id)])).toEqual([['pinned', ['pin']], ['week', ['b', 'a']], ['earlier', ['old']]]);
    expect(groupDocs([doc('a')], NOW).map((x) => x.id)).toEqual(['week']);
  });

  it('filters by type tab, agent, card and chat', () => {
    const wb = doc('w', { kind: 'url', path: 'links/w.url', agentId: 'user', chatId: 'c_chat' });
    const md = doc('m', { cardId: 'c_1' });
    expect([wb, md].filter((d) => matches(d, 'links', { agent: null, card: null, chat: null }))).toEqual([wb]);
    expect([wb, md].filter((d) => matches(d, 'all', { agent: 'atlas', card: null, chat: null }))).toEqual([md]);
    expect([wb, md].filter((d) => matches(d, 'all', { agent: null, card: 'c_1', chat: null }))).toEqual([md]);
    expect([wb, md].filter((d) => matches(d, 'all', { agent: null, card: null, chat: 'c_chat' }))).toEqual([wb]);
    expect(filterCount({ agent: 'a', card: null, chat: 'c' })).toBe(2);
  });

  it('parses a saved view and falls back on anything odd', () => {
    expect(parseLibView(null)).toEqual({ tab: 'all', folder: 'all', filter: { agent: null, card: null, chat: null } });
    expect(parseLibView('{"tab":"pages","filter":{"agent":"scout","card":3}}')).toEqual({ tab: 'pages', folder: 'all', filter: { agent: 'scout', card: null, chat: null } });
    expect(parseLibView('{"tab":"whiteboards","folder":"fld_1"}')).toMatchObject({ tab: 'all', folder: 'fld_1' });
    expect(parseLibView('{"tab":"nope"}').tab).toBe('all');
    expect(parseLibView('not json').tab).toBe('all');
  });

  it('folders: counts, membership, and the 3 recent ones', () => {
    const ds = [doc('a', { folderId: 'f1', updatedAt: ago(5) }), doc('b', { updatedAt: ago(1) }), doc('c', { folderId: 'f1', updatedAt: ago(3) }), doc('d', { updatedAt: ago(9) }), doc('e', { updatedAt: ago(2) })];
    expect(Object.fromEntries(folderCounts(ds))).toEqual({ all: 5, unfiled: 3, f1: 2 });
    expect(ds.filter((d) => inFolder(d, 'f1')).map((d) => d.id)).toEqual(['a', 'c']);
    expect(ds.filter((d) => inFolder(d, 'unfiled')).map((d) => d.id)).toEqual(['b', 'd', 'e']);
    expect(recentDocs(ds).map((d) => d.id)).toEqual(['b', 'e', 'c']);
  });

  it('puts the old canvases folder last, as « Canvases (old) »', () => {
    const fs = [{ name: 'Canvases' }, { name: 'QA' }, { name: 'Designs' }];
    expect(orderFolders(fs).map(folderLabel)).toEqual(['QA', 'Designs', 'Canvases (old)']);
  });

  it('says how long ago', () => {
    expect(relAgo(ago(0), NOW)).toBe('just now');
    expect(relAgo(new Date(NOW - 2 * 60_000).toISOString(), NOW)).toBe('2 min ago');
    expect(relAgo(ago(3), NOW)).toBe('3 h ago');
    expect(relAgo(ago(30), NOW)).toBe('yesterday');
    expect(relAgo(ago(24 * 5), NOW)).toBe('8 Nov');
  });
});
