import { describe, expect, it } from 'vitest';
import { isAttachedLine, pastedImages, refuse, TASK } from './Images.tsx';

describe('composer images', () => {
  it('refuses a 6th image, other types and files over 10 MB, saying why', () => {
    expect(refuse({ name: 'a.png', type: 'image/png', size: 1000 }, 0)).toBeNull();
    expect(refuse({ name: 'a.webp', type: 'image/webp', size: 1000 }, 4)).toBeNull();
    expect(refuse({ name: 'a.png', type: 'image/png', size: 1000 }, 5)).toMatch(/5 images per message/);
    expect(refuse({ name: 'doc.pdf', type: 'application/pdf', size: 1000 }, 0)).toMatch(/doc\.pdf: only png, jpeg, gif or webp/);
    expect(refuse({ name: 'x.svg', type: 'image/svg+xml', size: 1000 }, 0)).toMatch(/only png/);
    expect(refuse({ name: 'big.jpg', type: 'image/jpeg', size: 12 * 1024 * 1024 }, 0)).toMatch(/big\.jpg is 12\.0 MB: images over 10 MB are refused/);
  });
  it('a task takes 5 images in all, counting the ones it has (#119)', () => {
    expect(refuse({ name: 'a.png', type: 'image/png', size: 1000 }, 4, TASK)).toBeNull();
    expect(refuse({ name: 'a.png', type: 'image/png', size: 1000 }, 5, TASK)).toBe('5 images per task at most');
  });
  it('a paste with text stays a text paste; a screenshot alone is an image paste (#119)', () => {
    const png = { kind: 'file', type: 'image/png', getAsFile: () => ({ name: 'shot.png', type: 'image/png', size: 10 }) };
    const clip = (text: string, items: unknown[]) => ({ getData: (t: string) => (t === 'text/plain' ? text : ''), items }) as unknown as DataTransfer;
    expect(pastedImages(clip('copied text', [png]))).toEqual([]);
    expect(pastedImages(clip('', [png])).map((f) => f.name)).toEqual(['shot.png']);
  });
  it('hides only the engine’s attached line', () => {
    expect(isAttachedLine('[attached: uploads/2026-11-18-shot.png]')).toBe(true);
    expect(isAttachedLine('see [attached: x]')).toBe(false);
  });
});
