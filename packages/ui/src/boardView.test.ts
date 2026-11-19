import { describe, expect, it } from 'vitest';
import type { Card } from '@atlas/shared';
import { columnsFor, filterCount, matches, parseView, phoneColumn, showAfterLabel, timeInState, whyLine } from './boardView.ts';

const card = (p: Partial<Card>): Card =>
  ({ id: 'c', number: 1, title: 't', body: '', status: 'ready', assignee: 'atlas', priority: 0, board: 'main', parents: [], block: null, waiting: null, ...p }) as Card;
const any = { agent: null, priority: null };

describe('board view', () => {
  it('tabs: All cards shows every column but archived, Needs you = blocked (in review waits for QA, #189), Running = running', () => {
    expect(columnsFor('all')).not.toContain('archived');
    expect(columnsFor('all')).toContain('closed');
    expect(columnsFor('needs')).toEqual(['blocked']);
    expect(matches(card({ status: 'review' }), 'needs', any)).toBe(false);
    expect(matches(card({ status: 'ready' }), 'needs', any)).toBe(false);
    expect(matches(card({ status: 'running' }), 'running', any)).toBe(true);
  });
  it('filters by agent (« » = unassigned) and priority', () => {
    expect(matches(card({ assignee: 'scout' }), 'all', { agent: 'atlas', priority: null })).toBe(false);
    expect(matches(card({ assignee: null }), 'all', { agent: '', priority: null })).toBe(true);
    expect(matches(card({ priority: 2 }), 'all', { agent: null, priority: 2 })).toBe(true);
    expect(matches(card({ priority: 1 }), 'all', { agent: null, priority: 2 })).toBe(false);
    expect(filterCount({ agent: '', priority: 0 })).toBe(2);
    expect(filterCount(any)).toBe(0);
  });
  it('why line: the block reason first line for blocked cards, else « why not running »', () => {
    expect(whyLine(card({ status: 'blocked', block: { kind: 'needs_input', reason: '## Which source?\nmore', options: [], until: null } }))).toEqual({ text: 'Needs your answer · Which source?', blocked: true });
    expect(whyLine(card({ status: 'blocked', block: { kind: 'capability', reason: '', options: [], until: null } }))).toEqual({ text: 'Missing access', blocked: true });
    expect(whyLine(card({ waiting: 'Waits for #12' }))).toEqual({ text: 'Waits for #12', blocked: false });
    expect(whyLine(card({}))).toBeNull();
  });
  it('time in state (#237): shown for todo, ready, working, blocked and in review; a stuck task says why, in its own style', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    expect(timeInState(card({ status: 'review', statusSince: '2026-11-19T10:00:00Z' }), now)).toBe('2 h');
    expect(timeInState(card({ status: 'running', statusSince: '2026-11-19T11:25:00Z' }), now)).toBe('35 min');
    expect(timeInState(card({ status: 'blocked', statusSince: '2026-11-18T11:00:00Z' }), now)).toBe('1 d');
    for (const status of ['done', 'closed', 'triage', 'archived'] as const) expect(timeInState(card({ status, statusSince: '2026-11-19T10:00:00Z' }), now)).toBeNull();
    expect(timeInState(card({ status: 'ready', statusSince: null }), now)).toBeNull();
    const stall = { rule: 'review' as const, reason: 'CI is green, no review is running', since: '2026-11-19T10:00:00Z', action: 'retry_review' as const };
    expect(whyLine(card({ status: 'review', statusSince: '2026-11-19T10:00:00Z', waiting: 'waiting for @zurich', stall }), now)).toEqual({
      text: 'In review for 2 h: CI is green, no review is running',
      blocked: false,
      stuck: true,
    });
  });
  it('« after #N » label: hidden while the why-line already names every parent, shown otherwise', () => {
    expect(showAfterLabel(card({ status: 'todo', waiting: 'waiting on #61 (running)' }), ['#61'])).toBe(false);
    expect(showAfterLabel(card({ status: 'todo', waiting: 'waiting on #61 (running), #62 (ready)' }), ['#61', '#62'])).toBe(false);
    expect(showAfterLabel(card({ status: 'todo', waiting: 'waiting on #61 (running)' }), ['#61', '#60'])).toBe(true);
    expect(showAfterLabel(card({ status: 'todo', waiting: 'waiting on #610 (running)' }), ['#61'])).toBe(true);
    expect(showAfterLabel(card({ status: 'ready' }), ['#61'])).toBe(true); // parent done, no why-line
    expect(showAfterLabel(card({ status: 'running', waiting: null }), ['#61'])).toBe(true);
    expect(showAfterLabel(card({ status: 'blocked', waiting: 'waiting on #61', block: { kind: 'dependency', reason: 'x', options: [], until: null } }), ['#61'])).toBe(true);
    expect(showAfterLabel(card({ status: 'todo', waiting: 'parked' }), [])).toBe(false);
  });
  it('saved view: unreadable or unknown values fall back to the default', () => {
    expect(parseView(null)).toEqual({ tab: 'all', filter: any, layout: 'board', showEmpty: false });
    expect(parseView('{oops')).toEqual({ tab: 'all', filter: any, layout: 'board', showEmpty: false });
    expect(parseView(JSON.stringify({ tab: 'needs', layout: 'list', showEmpty: true, filter: { agent: 'atlas', priority: 3 } }))).toEqual({ tab: 'needs', filter: { agent: 'atlas', priority: 3 }, layout: 'list', showEmpty: true });
    expect(parseView(JSON.stringify({ tab: 'weird', layout: 7 })).tab).toBe('all');
  });
  it('phone (#229): one column, the saved one if the tab shows it, else the first with tasks, else the first', () => {
    const all = columnsFor('all');
    const n = (m: Partial<Record<string, number>>) => (s: string) => m[s] ?? 0;
    expect(phoneColumn(all, 'ready', n({}))).toBe('ready');
    expect(phoneColumn(all, null, n({ running: 3, done: 9 }))).toBe('running');
    expect(phoneColumn(all, 'nonsense', n({}))).toBe(all[0]);
    expect(phoneColumn(columnsFor('needs'), 'ready', n({}))).toBe('blocked');
  });
});
