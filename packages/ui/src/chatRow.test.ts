import { describe, expect, it } from 'vitest';
import { parseReport, rowTime } from './chatRow.ts';

// The exact lines the engine writes (packages/engine/src/kanban.ts reportText).
describe('parseReport', () => {
  it('reads every report-back transition', () => {
    expect(parseReport('✓ Card “Board: columns” (#57) finished: Done.\n\nChecked with ui:check.')).toEqual({
      card: '#57',
      title: 'Board: columns',
      icon: 'done',
      verb: 'finished',
      tone: 'plain',
      body: 'Done.\n\nChecked with ui:check.',
    });
    expect(parseReport('Card “Inbox” (#56) is ready for your review: look at it')).toMatchObject({ icon: 'review', verb: 'needs your review', tone: 'warn', body: 'look at it' });
    expect(parseReport('Card “Digest” (#55) needs your OK: which day?')).toMatchObject({ icon: 'blocked', verb: 'needs you', tone: 'warn', body: 'which day?' });
    expect(parseReport('Card “Keys” (#5) is blocked: no API key')).toMatchObject({ icon: 'blocked', verb: 'blocked', tone: 'bad', body: 'no API key' });
    expect(parseReport('Card “Old” (#54) closed by you. Nothing more will be done on it.')).toMatchObject({ icon: 'closed', verb: 'closed by you', body: 'Nothing more will be done on it.' });
    expect(parseReport('Card “Old” (#54) closed by @atlas. Nothing more will be done on it.')).toMatchObject({ verb: 'closed by @atlas' });
    expect(parseReport('You stopped “Bench” (#53). Its run and commands were killed; writing on the card resumes it.')).toMatchObject({
      card: '#53',
      title: 'Bench',
      icon: 'failed',
      verb: 'stopped',
      tone: 'bad',
      body: 'Its run and commands were killed; writing on the card resumes it.',
    });
  });
  it('has no body when the line is all there is', () => {
    expect(parseReport('✓ Card “X” (#1) finished')).toMatchObject({ body: '' });
  });
  it('keeps quotes in titles and old c_ ids', () => {
    expect(parseReport('✓ Card “Say “hi”” (c_1a2b3c4d) finished: ok')).toMatchObject({ card: 'c_1a2b3c4d', title: 'Say “hi”' });
  });
  it('leaves other system lines alone', () => {
    expect(parseReport('Model changed to x')).toBeNull();
  });
});

describe('rowTime', () => {
  it('shows the day only when it is not today', () => {
    const now = new Date(2026, 10, 14, 15, 0);
    const today = new Date(2026, 10, 14, 14, 32);
    expect(rowTime(today.toISOString(), now)).toBe(today.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    expect(rowTime(new Date(2026, 10, 13, 9, 5).toISOString(), now)).toMatch(/13/);
    expect(rowTime(new Date(2026, 10, 13, 9, 5).toISOString(), now)).not.toBe(rowTime(new Date(2026, 10, 14, 9, 5).toISOString(), now));
  });
});
