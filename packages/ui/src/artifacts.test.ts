import { describe, expect, it } from 'vitest';
import { isImageUrl, versionLabel, folderName } from './artifacts.ts';

describe('artifacts helpers', () => {
  it('detects image links, ignoring query and hash', () => {
    expect(isImageUrl('/api/files/atlas/shots/a.png')).toBe(true);
    expect(isImageUrl('/api/files/atlas/shots/A.JPG?v=2#x')).toBe(true);
    expect(isImageUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isImageUrl('http://localhost:5174')).toBe(false);
    expect(isImageUrl('/api/files/atlas/view.html?img=a.png')).toBe(false);
    expect(isImageUrl('')).toBe(false);
  });
  it('labels versions and folders', () => {
    expect(versionLabel(3, 3)).toBe('v3');
    expect(versionLabel(1, 3)).toBe('v1 of 3');
    expect(folderName([{ id: 'f1', name: 'Feeds', createdAt: '' }], 'f1')).toBe('Feeds');
    expect(folderName([], null)).toBe('Unfiled');
  });
});
