import { describe, expect, it } from 'vitest';
import { findSettings, SETTINGS_GROUPS, SETTINGS_PAGES, settingsLabel, settingsPageOf, settingsRoute } from './settingsPages.ts';

describe('settings routes', () => {
  it('has the merged navigation of the redesign (#272): Team, Models, App', () => {
    expect(SETTINGS_GROUPS.map((g) => [g.title, g.pages.map((p) => p.id)])).toEqual([
      ['Team', ['projects', 'agents', 'memory', 'board', 'secrets']],
      ['Models', ['models']],
      ['App', ['profile', 'appearance', 'voice', 'usage', 'about']],
    ]);
  });
  it('opens every page at #/settings/<id>', () => {
    for (const p of SETTINGS_PAGES) {
      expect(settingsPageOf('settings', p.id)).toBe(p.id);
      expect(settingsRoute('#/settings/' + p.id)).toEqual({ page: p.id, rest: '', path: '#/settings/' + p.id });
    }
  });
  it('#/settings alone is the list of pages', () => {
    expect(settingsRoute('#/settings')).toEqual({ page: 'agents', rest: '', path: '#/settings', index: true });
  });
  it('redirects the old hashes to the matching page', () => {
    expect(settingsPageOf('agents', undefined)).toBe('agents');
    expect(settingsPageOf('models', undefined)).toBe('models');
    expect(settingsPageOf('settings', 'board')).toBe('board');
    expect(settingsPageOf('settings', 'canvas')).toBe('appearance');
    expect(settingsPageOf('settings', 'nope')).toBe('agents');
    expect(settingsRoute('#/settings/canvas')).toEqual({ page: 'appearance', rest: '', path: '#/settings/appearance' });
    expect(settingsRoute('#/settings/nope')).toEqual({ page: 'agents', rest: '', path: '#/settings/agents' });
    expect(settingsRoute('#/agents')).toEqual({ page: 'agents', rest: '', path: '#/settings/agents' });
  });
  it('sends each of the four old model pages to its section of Models & accounts (#272)', () => {
    expect(settingsRoute('#/settings/subscriptions')).toEqual({ page: 'models', rest: '', path: '#/settings/models' });
    expect(settingsRoute('#/settings/api-keys')).toEqual({ page: 'models', rest: 'api-keys', path: '#/settings/models/api-keys' });
    expect(settingsRoute('#/settings/local')).toEqual({ page: 'models', rest: 'local', path: '#/settings/models/local' });
    expect(settingsRoute('#/settings/model-list')).toEqual({ page: 'models', rest: 'model-list', path: '#/settings/models/model-list' });
    expect(settingsRoute('#/models')).toEqual({ page: 'models', rest: '', path: '#/settings/models' });
    expect(settingsRoute('#/settings/models/api-keys')).toEqual({ page: 'models', rest: 'api-keys', path: '#/settings/models/api-keys' });
    expect(settingsRoute('#/settings/models/subscriptions')).toEqual({ page: 'models', rest: '', path: '#/settings/models' });
    expect(settingsRoute('#/settings/models/nope')).toEqual({ page: 'models', rest: '', path: '#/settings/models' });
  });
  it('labels an unknown page as Agents instead of throwing', () => {
    expect(settingsLabel('models')).toBe('Models & accounts');
    expect(settingsLabel('canvas')).toBe('Agents');
  });
  it('opens a project page at #/settings/projects/<id> (#217) and an agent page at #/settings/agents/<id> (#272)', () => {
    expect(settingsRoute('#/settings/projects')).toEqual({ page: 'projects', rest: '', path: '#/settings/projects' });
    expect(settingsRoute('#/settings/projects/datinel')).toEqual({ page: 'projects', rest: 'datinel', path: '#/settings/projects/datinel' });
    expect(settingsRoute('#/settings/projects/new')).toEqual({ page: 'projects', rest: 'new', path: '#/settings/projects/new' });
    expect(settingsRoute('#/settings/agents/munih')).toEqual({ page: 'agents', rest: 'munih', path: '#/settings/agents/munih' });
  });
  it('leaves other views alone', () => {
    expect(settingsPageOf('board', undefined)).toBeNull();
    expect(settingsPageOf('canvas', 'cv_1')).toBeNull();
    expect(settingsRoute('#/board')).toBeNull();
  });
  it('keeps a scope or memory id on Settings → Memory, and moves old Library memory links there (#87)', () => {
    expect(settingsRoute('#/settings/memory')).toEqual({ page: 'memory', rest: '', path: '#/settings/memory' });
    expect(settingsRoute('#/settings/memory/agent:atlas')).toEqual({ page: 'memory', rest: 'agent:atlas', path: '#/settings/memory/agent:atlas' });
    expect(settingsRoute('#/settings/memory/m12')).toEqual({ page: 'memory', rest: 'm12', path: '#/settings/memory/m12' });
    expect(settingsRoute('#/library/memory')).toEqual({ page: 'memory', rest: '', path: '#/settings/memory' });
    expect(settingsRoute('#/library/memory/m12')).toEqual({ page: 'memory', rest: 'm12', path: '#/settings/memory/m12' });
    expect(settingsRoute('#/library/memory/agent%3Aatlas')).toEqual({ page: 'memory', rest: 'agent:atlas', path: '#/settings/memory/agent%3Aatlas' });
    expect(settingsRoute('#/library/doc_1')).toBeNull();
    expect(settingsRoute('#/library')).toBeNull();
  });
});

describe('find a setting', () => {
  it('matches page names and the fixed keywords only', () => {
    expect(findSettings('')).toEqual(SETTINGS_PAGES.map((p) => p.id));
    expect(findSettings('memory')).toEqual(['memory']);
    expect(findSettings('Theme')).toEqual(['appearance']);
    expect(findSettings('api key')).toEqual(['models']);
    expect(findSettings('ollama')).toEqual(['models']);
    expect(findSettings('triage')).toEqual(['board']);
    expect(findSettings('version')).toEqual(['about']);
  });
  it('finds nothing for a word it does not know', () => {
    expect(findSettings('zzz')).toEqual([]);
  });
});
