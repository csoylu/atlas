import { describe, expect, it } from 'vitest';
import type { Project } from '@atlas/shared';
import { effectiveFilter, inFilter, projectForNew, projectsInfo } from './projects.tsx';

const p = (id: string, extra: Partial<Project> = {}): Project => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), repo: null, ciJob: null, network: 'on', allowedHosts: [], lead: null, colour: 212, status: 'active',
  createdAt: '2026-11-18T00:00:00Z', archivedAt: null, members: [], kept: [], isDefault: false, ...extra,
});
const one = projectsInfo([p('atlas', { isDefault: true })]);
const two = projectsInfo([p('atlas', { isDefault: true }), p('datinel'), p('old', { status: 'archived' })]);

describe('projects in the UI (#217)', () => {
  it('with a single project, there is no filter: everything shows', () => {
    expect(one.multi).toBe(false);
    expect(effectiveFilter('datinel', one)).toBe('all');
    expect(inFilter('all', 'atlas', one)).toBe(true);
  });
  it('falls back to all projects for a gone project, and for « Global only » outside Memory and Secrets', () => {
    expect(effectiveFilter('gone', two)).toBe('all');
    expect(effectiveFilter('global', two)).toBe('all');
    expect(effectiveFilter('global', two, true)).toBe('global');
    expect(effectiveFilter('datinel', two)).toBe('datinel');
  });
  it('filters by project; global items show in each project where they apply', () => {
    expect(inFilter('datinel', 'datinel', two)).toBe(true);
    expect(inFilter('datinel', 'atlas', two)).toBe(false);
    expect(inFilter('datinel', null, two)).toBe(false);
    expect(inFilter('datinel', null, two, true)).toBe(true);
    expect(inFilter('global', null, two)).toBe(true);
    expect(inFilter('global', 'atlas', two)).toBe(false);
  });
  it('hides archived projects from all projects; « Archived » shows only them', () => {
    expect(inFilter('all', 'old', two)).toBe(false);
    expect(inFilter('archived', 'old', two)).toBe(true);
    expect(inFilter('archived', 'atlas', two)).toBe(false);
  });
  it("gives a new item the filter's project, else the default one", () => {
    expect(projectForNew('datinel', two)?.id).toBe('datinel');
    expect(projectForNew('all', two)?.id).toBe('atlas');
    expect(projectForNew('old', two)?.id).toBe('atlas');
  });
});
