import { describe, expect, it } from 'vitest';
import { fileLine } from '@atlas/shared';
import { isAttachedLine, isPicture, pastedFiles, refuse, shownName, TASK } from './Images.tsx';

const MB = 1024 * 1024;
const none = { all: 0, images: 0 };

describe('composer attachments (#348)', () => {
  it('takes any file up to 100 MB; refuses over it, an 11th attachment and a 6th picture, saying why', () => {
    expect(refuse({ name: 'a.png', type: 'image/png', size: 1000 }, none)).toBeNull();
    expect(refuse({ name: 'doc.pdf', type: 'application/pdf', size: 1000 }, none)).toBeNull();
    expect(refuse({ name: 'Makefile', type: '', size: 10 }, none)).toBeNull();
    expect(refuse({ name: 'logs.zip', type: 'application/zip', size: 100 * MB }, none)).toBeNull();
    expect(refuse({ name: 'mainnet.parquet', type: '', size: 140.2 * MB }, none)).toBe('mainnet.parquet is 140.2 MB: files over 100 MB are refused');
    expect(refuse({ name: 'a.png', type: 'image/png', size: 1000 }, { all: 5, images: 5 })).toBe('5 pictures per message at most');
    expect(refuse({ name: 'a.csv', type: 'text/csv', size: 1000 }, { all: 5, images: 5 })).toBeNull(); // files still fit
    expect(refuse({ name: 'a.csv', type: 'text/csv', size: 1000 }, { all: 10, images: 0 })).toBe('10 attachments per message at most');
  });
  it('a task counts what it has (#119)', () => {
    expect(refuse({ name: 'a.png', type: 'image/png', size: 1000 }, { all: 4, images: 4 }, TASK)).toBeNull();
    expect(refuse({ name: 'a.png', type: 'image/png', size: 1000 }, { all: 5, images: 5 }, TASK)).toBe('5 pictures per task at most');
    expect(refuse({ name: 'a.txt', type: 'text/plain', size: 1 }, { all: 10, images: 2 }, TASK)).toBe('10 attachments per task at most');
  });
  it('a picture is a png, jpeg, gif or webp up to 10 MB; the rest (svg, a big photo) goes as a file', () => {
    expect(isPicture({ type: 'image/png', size: 10 * MB })).toBe(true);
    expect(isPicture({ type: 'image/png', size: 10 * MB + 1 })).toBe(false);
    expect(isPicture({ type: 'image/svg+xml', size: 10 })).toBe(false);
    expect(isPicture({ type: 'application/pdf', size: 10 })).toBe(false);
  });
  it('a paste with text stays a text paste, unless it carries a file that is not a picture (a Finder copy)', () => {
    const item = (name: string, type: string) => ({ kind: 'file', type, getAsFile: () => ({ name, type, size: 10 }) });
    const clip = (text: string, items: unknown[]) => ({ getData: (t: string) => (t === 'text/plain' ? text : ''), items }) as unknown as DataTransfer;
    expect(pastedFiles(clip('copied text', [item('shot.png', 'image/png')]))).toEqual([]);
    expect(pastedFiles(clip('', [item('shot.png', 'image/png')])).map((f) => f.name)).toEqual(['shot.png']);
    expect(pastedFiles(clip('report.pdf', [item('report.pdf', 'application/pdf')])).map((f) => f.name)).toEqual(['report.pdf']);
  });
  it('hides only the engine’s lines; a chip shows the name as given', () => {
    expect(isAttachedLine('[attached: uploads/2026-11-18-shot.png]')).toBe(true);
    expect(isAttachedLine(fileLine('uploads/2026-11-23-q3-volumes.csv', 1200))).toBe(true);
    expect(isAttachedLine('see [attached: x]')).toBe(false);
    expect(isAttachedLine('[file attached: oops]')).toBe(false);
    expect(shownName('uploads/2026-11-23-q3-volumes.csv')).toBe('q3-volumes.csv');
    expect(shownName('/x/task-images/2026-11-23-spec.md')).toBe('spec.md');
    expect(shownName('uploads/task-12-2026-11-23-README')).toBe('README');
  });
});
