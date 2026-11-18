import { describe, expect, it } from 'vitest';
import type { SideEffect } from '@atlas/shared';
import { effectsLine, filesLine, outcomeLine } from './rewindText.ts';

const fx = (kind: SideEffect['kind'], outcome: SideEffect['outcome'], action = outcome === 'kept' ? 'stays' : 'closed'): SideEffect => ({
  kind,
  label: 'x',
  cardId: null,
  outcome,
  action,
  why: null,
});

describe('rewind wording', () => {
  it('counts files restored, never claims more', () => {
    expect(filesLine([])).toBe('no files changed');
    expect(filesLine([{ path: 'a', change: 'deleted' }])).toBe('1 file restored');
    expect(filesLine([{ path: 'a', change: 'restored' }, { path: 'b', change: 'recreated' }])).toBe('2 files restored');
  });

  it('says what else was undone and kept (#138); « no files changed » never stands alone then', () => {
    expect(effectsLine([])).toBe('');
    expect(outcomeLine('no files changed', [])).toBe('no files changed');
    expect(outcomeLine('no files changed', [fx('task', 'undone')])).toBe('no files changed · 1 task closed');
    expect(effectsLine([fx('task', 'undone'), fx('task', 'undone'), fx('message', 'undone', 'withdrawn'), fx('push', 'kept')])).toBe('2 tasks closed · 1 message withdrawn · 1 kept');
    expect(
      effectsLine([fx('task', 'undone'), fx('message', 'undone', 'withdrawn'), fx('memory', 'undone', 'archived'), fx('schedule', 'undone', 'turned off'), fx('artifact', 'kept')]),
    ).toBe('1 task closed · 3 more undone · 1 kept');
    expect(effectsLine([fx('memory', 'undone', 'archived'), fx('memory', 'undone', 'archived')])).toBe('2 memories archived');
  });
});
