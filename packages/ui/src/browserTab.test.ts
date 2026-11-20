import { describe, expect, it } from 'vitest';
import type { BrowserTab } from '@atlas/shared';
import { browserTitle, hostOf, recentPages, whenText } from './browserTab.ts';
import { draftKey } from './comments.ts';

const tab = (o: Partial<BrowserTab>): BrowserTab => ({
  chatId: 'c1', projectId: 'p', agentId: 'paris', url: null, title: '', owner: 'agent', loading: false, error: null, crashed: false,
  agentUsed: false, needs: null, via: null, action: null, updatedAt: '2026-11-20T10:00:00.000Z', ...o,
});

describe('the browser tab (#306)', () => {
  it('is titled by the page, else its host, else « New tab »', () => {
    expect(browserTitle(tab({ title: ' Tenders ', url: 'http://localhost:5173/tenders' }))).toBe('Tenders');
    expect(browserTitle(tab({ url: 'http://localhost:5173/tenders?q=road' }))).toBe('localhost:5173');
    expect(browserTitle(tab({}))).toBe('New tab');
    expect(hostOf('not an address')).toBe('not an address');
  });

  it('recent pages: the same agent’s other tabs, latest first, each address once, at most 4', () => {
    const list = [
      tab({ chatId: 'c1', url: 'http://localhost:5173/' }),
      tab({ chatId: 'c2', url: 'https://github.com/csoylu/atlas', updatedAt: '2026-11-19T10:00:00.000Z' }),
      tab({ chatId: 'c3', url: 'http://localhost:5173/', updatedAt: '2026-11-20T09:00:00.000Z' }),
      tab({ chatId: 'c4', url: 'http://localhost:5173/', updatedAt: '2026-11-20T08:00:00.000Z' }),
      tab({ chatId: 'c5', agentId: 'munih', url: 'https://other.test' }),
      tab({ chatId: 'c6', url: null }),
    ];
    expect(recentPages(list, 'c1', 'paris').map((t) => t.chatId)).toEqual(['c3', 'c2']);
    const now = Date.parse('2026-11-20T10:00:00.000Z');
    expect(whenText('2026-11-20T09:30:00.000Z', now)).toBe('just now');
    expect(whenText('2026-11-20T02:00:00.000Z', now)).toBe('today');
    expect(whenText('2026-11-19T02:00:00.000Z', now)).toBe('yesterday');
    expect(whenText('2026-11-02T02:00:00.000Z', now)).toBe('2 Nov');
  });

  it('a comment on a page waits under its address: two pages, two groups', () => {
    expect(draftKey({ kind: 'browser', url: 'http://a.test/x', title: 'A' })).toBe('browser:http://a.test/x');
    expect(draftKey({ kind: 'browser', url: 'http://a.test/y', title: 'A' })).not.toBe(draftKey({ kind: 'browser', url: 'http://a.test/x', title: 'A' }));
  });
});
