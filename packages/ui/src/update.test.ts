import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from '@atlas/shared';
import { aboutLine, ago, badgeLabel, noteHeading, percent, workingLine } from './update.ts';

const base: UpdateStatus = {
  current: '0.14.0',
  cannotInstall: null,
  checking: false,
  checkedAt: '2026-11-18T10:00:00Z',
  checkError: null,
  releases: [],
  phase: 'idle',
  target: null,
  received: 0,
  total: null,
  error: null,
  lastUpdate: null,
  working: [],
};
const rel = { version: '0.15.0', notes: '## Added · #130 · New thing\n\nDetails.', publishedAt: '2026-11-18T09:00:00Z' };
const now = Date.parse('2026-11-18T10:05:00Z');

describe('update words', () => {
  it('badge: none when up to date, available, progress, failed', () => {
    expect(badgeLabel(null)).toBeNull();
    expect(badgeLabel(base)).toBeNull();
    expect(badgeLabel({ ...base, releases: [rel] })).toBe('Update available');
    expect(badgeLabel({ ...base, releases: [rel], phase: 'downloading', received: 50, total: 200 })).toBe('Downloading update… 25%');
    expect(badgeLabel({ ...base, releases: [rel], phase: 'downloading' })).toBe('Downloading update…');
    expect(badgeLabel({ ...base, releases: [rel], phase: 'installing' })).toBe('Restarting to update…');
    expect(badgeLabel({ ...base, releases: [rel], phase: 'failed' })).toBe('Update failed');
    expect(percent({ ...base, received: 300, total: 200 })).toBe(100);
  });
  it('about line', () => {
    expect(aboutLine(base, now)).toBe('Up to date (checked 5 min ago).');
    expect(aboutLine({ ...base, checkedAt: null }, now)).toBe('Not checked yet.');
    expect(aboutLine({ ...base, releases: [rel] }, now)).toBe('Atlas 0.15.0 is available (checked 5 min ago).');
    expect(aboutLine({ ...base, checkError: 'Could not reach GitHub: ECONNREFUSED' }, now)).toBe('The last check failed (5 min ago): Could not reach GitHub: ECONNREFUSED');
    expect(aboutLine({ ...base, checking: true }, now)).toBe('Checking for updates…');
    expect(ago('2026-11-18T10:04:40Z', now)).toBe('just now');
    expect(ago('2026-11-18T07:05:00Z', now)).toBe('3 h ago');
  });
  it('who is working', () => {
    expect(workingLine(base)).toBe('No agent is working now.');
    expect(workingLine({ ...base, working: [{ agent: 'munih', card: 123, title: 'x' }] })).toBe('1 agent is working now: it stops for the restart and resumes after it.');
    expect(workingLine({ ...base, working: [{ agent: 'a', card: 1, title: 'x' }, { agent: 'b', card: null, title: 'y' }] })).toMatch(/^2 agents are working now: they/);
  });
  it('reads a changelog entry heading', () => {
    expect(noteHeading(rel.notes)).toEqual({ kind: 'Added', task: '#130', title: 'New thing', body: 'Details.' });
    expect(noteHeading('## Fixed · No task')).toEqual({ kind: 'Fixed', task: null, title: 'No task', body: '' });
    expect(noteHeading('free text')).toBeNull();
  });
});
