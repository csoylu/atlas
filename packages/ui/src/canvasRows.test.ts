import { describe, expect, it } from 'vitest';
import { canvasIdOf, canvasList, humanTimes, memoryFoot, scheduleCreated, scheduleList, thumbLayout, whenText } from './canvasRows.ts';

describe('canvas rows', () => {
  it('reads canvas_list output', () => {
    expect(canvasList('cv_b8f5fc78 "#59 Chat activity" v3 (by atlas)\ncv_2 "a "quoted" name" v1 (by user)\n(junk)')).toEqual([
      { id: 'cv_b8f5fc78', name: '#59 Chat activity', version: 3, by: 'atlas' },
      { id: 'cv_2', name: 'a "quoted" name', version: 1, by: 'user' },
    ]);
    expect(canvasList('(no canvases)')).toEqual([]);
  });

  it('finds the canvas a tool is about', () => {
    expect(canvasIdOf('canvas_create', { name: 'x' }, 'created cv_ab12')).toBe('cv_ab12');
    expect(canvasIdOf('canvas_create', { name: 'x' }, null)).toBeNull();
    expect(canvasIdOf('canvas_write', { id: 'cv_1', show: [] }, 'ok')).toBe('cv_1');
    expect(canvasIdOf('canvas_read', { id: 'cv_1' }, '{}')).toBe('cv_1');
    expect(canvasIdOf('canvas_list', {}, '')).toBeNull();
  });

  it('fits every node in a 2:1 thumbnail with a margin', () => {
    expect(thumbLayout([])).toBeNull();
    const wide = thumbLayout([
      { id: 'a', kind: 'drawing', title: '', x: 0, y: 0, w: 400, h: 100 },
      { id: 'b', kind: 'html', title: '', x: 500, y: 0, w: 500, h: 100 },
    ])!;
    const [x, y, w, h] = wide.viewBox.split(' ').map(Number) as [number, number, number, number];
    expect(w / h).toBeCloseTo(2);
    expect(x).toBeLessThan(0);
    expect(x + w).toBeGreaterThan(1000);
    expect(y).toBeLessThan(0);
    // A single tall node: the frame widens, it stays centred.
    const [tx, , tw, th] = thumbLayout([{ id: 'c', kind: 'markdown', title: '', x: 0, y: 0, w: 100, h: 400 }])!.viewBox.split(' ').map(Number) as [number, number, number, number];
    expect(tw / th).toBeCloseTo(2);
    expect(tx + tw / 2).toBeCloseTo(50);
  });

  it('says what a memory edit did', () => {
    expect(memoryFoot({ text: 'x' })).toBe('appended · own memory');
    expect(memoryFoot({ text: 'x', mode: 'replace', scope: 'shared' })).toBe('replaced · shared memory');
  });

  it('reads schedule outputs', () => {
    expect(scheduleCreated('scheduled sch_07cbcde1 "Test: push" for @atlas: once at 2026-11-12T00:35:00.000Z, first run 2026-11-12T00:35:00.000Z')).toEqual({
      id: 'sch_07cbcde1', title: 'Test: push', agent: 'atlas', when: 'once at 2026-11-12T00:35:00.000Z', first: '2026-11-12T00:35:00.000Z',
    });
    expect(scheduleCreated('scheduled')).toBeNull();
    const list = scheduleList('sch_1 @atlas "Digest": cron "0 9 * * 1-5" (Europe/Paris) · next 2026-11-16T08:00:00.000Z · new card each time\nsch_2 @atlas "Old": once at 2026-11-01T00:00:00.000Z · disabled · own card #12 · LAST RUN FAILED: boom');
    expect(list).toMatchObject([
      { id: 'sch_1', agent: 'atlas', title: 'Digest', when: 'cron "0 9 * * 1-5" (Europe/Paris)', more: 'next 2026-11-16T08:00:00.000Z · new card each time', failed: false },
      { id: 'sch_2', title: 'Old', failed: true },
    ]);
    expect(scheduleList('(no schedules)')).toEqual([]);
  });

  it('makes times readable', () => {
    expect(whenText('2026-11-12T00:35:00+01:00')).toMatch(/^Thu 12 Nov \d\d:35$/);
    expect(whenText('tomorrow')).toBe('tomorrow');
    expect(humanTimes('once at 2026-11-12T00:35:00.000Z, ok')).toMatch(/^once at Thu 12 Nov \d\d:35, ok$/);
  });
});
