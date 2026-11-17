import { describe, expect, it } from 'vitest';
import type { Card } from '@atlas/shared';
import { FADE_MS, dismissKey, nextPins, pinKind, pinLabel, sysLine } from './chatPins.ts';

const T0 = Date.parse('2026-11-12T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const card = (id: string, patch: Partial<Card> = {}): Card =>
  ({
    id,
    title: 'Card ' + id,
    body: '',
    status: 'running',
    assignee: 'atlas',
    priority: 0,
    board: 'main',
    parents: [],
    block: null,
    waiting: null,
    conversationId: 'conv_' + id,
    createdBy: 'atlas',
    createdAt: iso(T0),
    updatedAt: iso(T0),
    modelId: null,
    effort: null,
    naming: false,
    working: false,
    originCard: 'c_chat',
    ...patch,
  }) as Card;
const none = new Set<string>();

describe('pinKind / pinLabel', () => {
  it('maps card states to pin states', () => {
    expect(pinKind(card('a'))).toBe('running');
    expect(pinKind(card('a', { status: 'ready' }))).toBe('waiting');
    expect(pinKind(card('a', { status: 'blocked', block: { kind: 'needs_input', reason: 'OK?', options: [], until: null } }))).toBe('blocked');
    expect(pinKind(card('a', { status: 'blocked', block: { kind: 'needs_input', reason: 'Stopped by you', options: [], until: null } }))).toBe('stopped');
    expect(pinKind(card('a', { status: 'closed' }))).toBe('closed');
  });
  it('says how long it has been running', () => {
    expect(pinLabel({ kind: 'running', since: T0 }, T0 + 134_000)).toBe('Working · 2:14');
    expect(pinLabel({ kind: 'running', since: T0 }, T0 + 3_725_000)).toBe('Working · 1:02:05');
    expect(pinLabel({ kind: 'running', since: null }, T0)).toBe('Working');
    expect(pinLabel({ kind: 'stopped', since: null }, T0)).toBe('stopped by you');
    expect(pinLabel({ kind: 'blocked', since: null }, T0)).toBe('needs your OK');
    expect(pinLabel({ kind: 'done', since: null }, T0)).toBe('done');
  });
});

describe('nextPins', () => {
  it('pins only cards from this chat, newest first', () => {
    const pins = nextPins([], [card('a'), card('b', { createdAt: iso(T0 + 1000) }), card('x', { originCard: 'c_other' })], 'c_chat', T0, none);
    expect(pins.map((p) => p.id)).toEqual(['b', 'a']);
  });
  it('skips cards that finished long ago, keeps recent ones', () => {
    const old = card('a', { status: 'done', updatedAt: iso(T0 - FADE_MS - 1) });
    const recent = card('b', { status: 'done', updatedAt: iso(T0 - 5000) });
    const pins = nextPins([], [old, recent], 'c_chat', T0, none);
    expect(pins.map((p) => [p.id, p.finishedAt])).toEqual([['b', T0 - 5000]]);
  });
  it('a card that finishes while pinned starts its fade timer then, and keeps it', () => {
    let pins = nextPins([], [card('a')], 'c_chat', T0, none);
    pins = nextPins(pins, [card('a', { status: 'done', updatedAt: iso(T0 - 999_999) })], 'c_chat', T0 + 10, none);
    expect(pins[0]).toMatchObject({ kind: 'done', finishedAt: T0 + 10 });
    pins = nextPins(pins, [card('a', { status: 'done' })], 'c_chat', T0 + 500, none);
    expect(pins[0]!.finishedAt).toBe(T0 + 10);
  });
  it('a pinned card that disappears becomes a deleted pin', () => {
    let pins = nextPins([], [card('a')], 'c_chat', T0, none);
    pins = nextPins(pins, [], 'c_chat', T0 + 10, none);
    expect(pins[0]).toMatchObject({ id: 'a', kind: 'deleted', finishedAt: T0 + 10 });
    expect(nextPins(pins, [], 'c_chat', T0 + 20, none)[0]!.finishedAt).toBe(T0 + 10);
  });
  it('unpinned stays unpinned until the card moves to another state', () => {
    const stopped = card('a', { status: 'blocked', block: { kind: 'needs_input', reason: 'Stopped by you', options: [], until: null } });
    const pins = nextPins([], [stopped], 'c_chat', T0, none);
    const dismissed = new Set([dismissKey(pins[0]!)]);
    expect(nextPins(pins, [stopped], 'c_chat', T0, dismissed)).toEqual([]);
    expect(nextPins([], [card('a')], 'c_chat', T0, dismissed)[0]!.kind).toBe('running');
  });
  it('keeps the running start across updates', () => {
    let pins = nextPins([], [card('a', { updatedAt: iso(T0 - 60_000) })], 'c_chat', T0, none);
    pins = nextPins(pins, [card('a', { title: 'Renamed', updatedAt: iso(T0 + 5000) })], 'c_chat', T0 + 5000, none);
    expect(pins[0]).toMatchObject({ title: 'Renamed', since: T0 - 60_000 });
  });
});

describe('sysLine', () => {
  it('pulls the card out of a report-back line', () => {
    expect(sysLine('✓ Card “Add web_fetch” (c_1a2b3c4d) finished: tests pass')).toEqual({ card: 'c_1a2b3c4d', text: '✓ Card “Add web_fetch” finished: tests pass' });
    expect(sysLine('You stopped “Clean up” (c_00ff00aa). Its run was killed.')).toEqual({ card: 'c_00ff00aa', text: 'You stopped “Clean up”. Its run was killed.' });
  });
  it('reads #N references too', () => {
    expect(sysLine('Card “Theme” (#12) needs your OK: blue?')).toEqual({ card: '#12', text: 'Card “Theme” needs your OK: blue?' });
  });
  it('leaves other lines alone', () => {
    expect(sysLine('Model changed to x')).toEqual({ card: null, text: 'Model changed to x' });
  });
});
