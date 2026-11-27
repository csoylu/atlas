import { describe, expect, it } from 'vitest';
import { splitSections } from '@atlas/shared';
import { isFigure, sectionNumbers } from './Viewer.tsx';

describe('Library document (#372)', () => {
  it('numbers the H2 sections 01, 02… and nothing else', () => {
    const s = splitSections('# T\n\nintro\n\n## One\n\n### Sub\n\n## Two\n');
    expect([...sectionNumbers(s)]).toEqual([
      ['one', '01'],
      ['two', '02'],
    ]);
  });
  it('sets a table cell in mono when it starts with a figure', () => {
    for (const t of ['4', '12 (3 shared)', '$4.20', '−3 %', '-0.5', '~120']) expect(isFigure(t)).toBe(true);
    for (const t of ['Agents', 'v2 notes', '', 'n/a']) expect(isFigure(t)).toBe(false);
  });
});
