import { describe, expect, it } from 'vitest';
import { SETTINGS_PAGES, settingsLabel, settingsPageOf, settingsRoute } from './settingsPages.ts';

describe('settings routes', () => {
  it('opens every page at #/settings/<id>', () => {
    for (const p of SETTINGS_PAGES) expect(settingsPageOf('settings', p.id)).toBe(p.id);
  });
  it('redirects the old hashes to the matching page', () => {
    expect(settingsPageOf('agents', undefined)).toBe('agents');
    expect(settingsPageOf('models', undefined)).toBe('subscriptions');
    expect(settingsPageOf('settings', 'models')).toBe('subscriptions');
    expect(settingsPageOf('settings', 'board')).toBe('board');
    expect(settingsPageOf('settings', 'canvas')).toBe('appearance');
    expect(settingsPageOf('settings', undefined)).toBe('agents');
    expect(settingsPageOf('settings', 'nope')).toBe('agents');
  });
  it('labels an unknown page as the first one instead of throwing', () => {
    expect(settingsLabel('subscriptions')).toBe('Subscriptions');
    expect(settingsLabel('canvas')).toBe('Agents');
  });
  it('leaves other views alone', () => {
    expect(settingsPageOf('board', undefined)).toBeNull();
    expect(settingsPageOf('canvas', 'cv_1')).toBeNull();
  });
  it('keeps a scope or memory id on Settings → Memory, and moves old Library memory links there (#87)', () => {
    expect(settingsRoute('#/settings/memory')).toEqual({ page: 'memory', rest: '', path: '#/settings/memory' });
    expect(settingsRoute('#/settings/memory/agent:atlas')).toEqual({ page: 'memory', rest: 'agent:atlas', path: '#/settings/memory/agent:atlas' });
    expect(settingsRoute('#/settings/memory/m12')).toEqual({ page: 'memory', rest: 'm12', path: '#/settings/memory/m12' });
    expect(settingsRoute('#/library/memory')).toEqual({ page: 'memory', rest: '', path: '#/settings/memory' });
    expect(settingsRoute('#/library/memory/m12')).toEqual({ page: 'memory', rest: 'm12', path: '#/settings/memory/m12' });
    expect(settingsRoute('#/library/memory/agent%3Aatlas')).toEqual({ page: 'memory', rest: 'agent:atlas', path: '#/settings/memory/agent%3Aatlas' });
    expect(settingsRoute('#/settings/models')).toEqual({ page: 'subscriptions', rest: '', path: '#/settings/subscriptions' });
    expect(settingsRoute('#/agents')).toEqual({ page: 'agents', rest: '', path: '#/settings/agents' });
    expect(settingsRoute('#/library/doc_1')).toBeNull();
    expect(settingsRoute('#/library')).toBeNull();
  });
});
