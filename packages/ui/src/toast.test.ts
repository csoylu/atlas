import { describe, expect, it } from 'vitest';
import type { Card, CardPr } from '@atlas/shared';
import { mergedToast, StatusMemory } from './toast.ts';

const pr = (p: Partial<CardPr> = {}) => ({ number: 76, state: 'merged', ...p }) as CardPr;
const card = (p: Partial<Card> = {}) => ({ id: 'c1', number: 241, status: 'done', prs: [pr()], ...p }) as Card;

describe('mergedToast', () => {
  it('fires for In review → Done with a merged PR', () => {
    expect(mergedToast('review', card())).toEqual({ key: 'c1:76', cardId: 'c1', text: '#241 merged · PR #76' });
  });
  it('stays quiet for any other move, or without a merged PR', () => {
    expect(mergedToast(undefined, card())).toBeNull();
    expect(mergedToast('done', card())).toBeNull();
    expect(mergedToast('running', card())).toBeNull();
    expect(mergedToast('blocked', card())).toBeNull();
    expect(mergedToast('review', card({ status: 'ready' }))).toBeNull();
    expect(mergedToast('review', card({ prs: [] }))).toBeNull();
    expect(mergedToast('review', card({ prs: [pr({ state: 'closed' })] }))).toBeNull();
  });
});

describe('StatusMemory: live events only', () => {
  it('toasts a merge that arrives live after the first load', () => {
    const m = new StatusMemory();
    m.load([card({ status: 'review' })]);
    expect(m.update(card())?.text).toBe('#241 merged · PR #76');
    // The same card again (another update while Done): nothing more.
    expect(m.update(card())).toBeNull();
  });
  it('never toasts on first load: a card already merged is only loaded', () => {
    const m = new StatusMemory();
    m.load([card()]);
    expect(m.update(card())).toBeNull();
  });
  it('never toasts an update that arrives before the first load', () => {
    const m = new StatusMemory();
    expect(m.update(card())).toBeNull();
  });
  it('never toasts a move that happened while the stream was down', () => {
    const m = new StatusMemory();
    m.load([card({ status: 'review' })]);
    m.forget(); // disconnected; merged meanwhile
    expect(m.update(card())).toBeNull(); // an event between reconnect and reload
    m.load([card()]); // the reload after the reconnect
    expect(m.update(card())).toBeNull();
  });
  it('a card seen live in review then merged toasts, even if it was new', () => {
    const m = new StatusMemory();
    m.load([]);
    expect(m.update(card({ status: 'review' }))).toBeNull();
    expect(m.update(card())).not.toBeNull();
  });
});
