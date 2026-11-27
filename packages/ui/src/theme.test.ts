import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCENTS, parseAccent, parseTheme } from './theme.ts';

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

describe('parseAccent (#369)', () => {
  it('keeps the four accents', () => {
    for (const a of ['lime', 'signal', 'ice', 'ultra']) expect(parseAccent(a)).toBe(a);
  });
  it('falls back to Lime for anything else, Bone included', () => {
    expect(parseAccent(null)).toBe('lime');
    expect(parseAccent('bone')).toBe('lime');
  });
  it('index.html applies the same list before the first paint', () => {
    const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
    expect(html).toContain(JSON.stringify(ACCENTS.map((a) => a.id)).replace(/"/g, "'").replace(/,/g, ', '));
  });
});
