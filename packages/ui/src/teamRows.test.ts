import { describe, expect, it } from 'vitest';
import { humanTimes, memoryFoot, scheduleCreated, scheduleList, whenText } from './teamRows.ts';

describe('team rows', () => {
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
    // 11:35 UTC is Thursday from UTC−11 to UTC+12 and Friday at UTC+13/+14: the test holds in every timezone.
    expect(whenText('2026-11-12T11:35:00Z')).toMatch(/^(Thu 12|Fri 13) Nov \d\d:\d\d$/);
    expect(whenText('tomorrow')).toBe('tomorrow');
    expect(humanTimes('once at 2026-11-12T11:35:00.000Z, ok')).toMatch(/^once at (Thu 12|Fri 13) Nov \d\d:\d\d, ok$/);
  });
});
