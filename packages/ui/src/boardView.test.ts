import { describe, expect, it } from 'vitest';
import type { Card } from '@atlas/shared';
import { columnsFor, filterCount, matches, parseView, showAfterLabel, whyLine } from './boardView.ts';

const card = (p: Partial<Card>): Card =>
  ({ id: 'c', number: 1, title: 't', body: '', status: 'ready', assignee: 'atlas', priority: 0, board: 'main', parents: [], block: null, waiting: null, ...p }) as Card;
const any = { agent: null, priority: null };

describe('board view', () => {
  it('tabs: All cards shows every column but archived, Needs you = blocked + review, Running = running', () => {
    expect(columnsFor('all')).not.toContain('archived');
    expect(columnsFor('all')).toContain('closed');
    expect(columnsFor('needs')).toEqual(['blocked', 'review']);
    expect(matches(card({ status: 'review' }), 'needs', any)).toBe(true);
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
});
