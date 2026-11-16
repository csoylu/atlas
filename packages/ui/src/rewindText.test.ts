import { describe, expect, it } from 'vitest';
import { filesLine } from './rewindText.ts';

describe('rewind wording', () => {
  it('counts files restored, never claims more', () => {
    expect(filesLine([])).toBe('no files changed');
    expect(filesLine([{ path: 'a', change: 'deleted' }])).toBe('1 file restored');
    expect(filesLine([{ path: 'a', change: 'restored' }, { path: 'b', change: 'recreated' }])).toBe('2 files restored');
  });
});
