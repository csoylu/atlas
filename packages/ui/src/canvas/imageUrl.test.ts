import { describe, expect, it } from 'vitest';
import { isImageUrl } from './imageUrl.ts';

describe('isImageUrl', () => {
  it('detects image files, ignoring query and hash', () => {
    expect(isImageUrl('/api/files/atlas/shots/a.png')).toBe(true);
    expect(isImageUrl('/api/files/atlas/shots/A.JPG?v=2#x')).toBe(true);
    expect(isImageUrl('http://localhost:3000/img/logo.webp')).toBe(true);
    expect(isImageUrl('diagrams/flow.svg')).toBe(true);
    expect(isImageUrl('data:image/png;base64,AAAA')).toBe(true);
  });
  it('leaves pages and apps in an iframe', () => {
    expect(isImageUrl('http://localhost:5174')).toBe(false);
    expect(isImageUrl('/api/files/atlas/pages/a.html')).toBe(false);
    expect(isImageUrl('/api/files/atlas/view.html?img=a.png')).toBe(false);
    expect(isImageUrl('')).toBe(false);
  });
});
