import { describe, expect, it } from 'vitest';
import { SETTINGS_PAGES, settingsLabel, settingsPageOf } from './settingsPages.ts';

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
});
