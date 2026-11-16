import { describe, expect, it } from 'vitest';
import { parseTheme } from './theme.ts';

describe('parseTheme', () => {
  it('keeps light, dark and Auto', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('system')).toBe('system');
  });
  it('reads the dropped gray theme as dark', () => expect(parseTheme('gray')).toBe('dark'));
  it('falls back to Auto for anything else', () => {
    expect(parseTheme(null)).toBe('system');
    expect(parseTheme('sepia')).toBe('system');
  });
});
