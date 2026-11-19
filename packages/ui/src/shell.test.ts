import { describe, expect, it } from 'vitest';
import { backOf, tabOf } from './shell.ts';

describe('narrow shell (#264)', () => {
  it('lights the tab a screen belongs to', () => {
    expect(tabOf('inbox')).toBe('inbox');
    expect(tabOf('board')).toBe('tasks');
    expect(tabOf('chat')).toBe('chats');
    expect(tabOf('chats')).toBe('chats');
    expect(tabOf('library')).toBe('library');
    expect(tabOf('workflows')).toBe('more');
    expect(tabOf('settings')).toBe('more');
    expect(tabOf('more')).toBe('more');
  });
  it('gives every pushed screen a way back, and none to a tab', () => {
    expect(backOf('chat', 'c_1')?.hash).toBe('#/chats');
    expect(backOf('settings', null)?.hash).toBe('#/more');
    expect(backOf('settings', 'agents')?.hash).toBe('#/settings');
    expect(backOf('settings', 'memory', 'm12')?.hash).toBe('#/settings');
    expect(backOf('settings', 'agents', 'munih')?.hash).toBe('#/settings/agents');
    expect(backOf('settings', 'projects', 'datinel')?.hash).toBe('#/settings/projects');
    expect(backOf('workflows', null)?.hash).toBe('#/more');
    expect(backOf('workflows', 'wf_1')?.hash).toBe('#/workflows');
    for (const top of ['inbox', 'board', 'library', 'chats', 'more']) expect(backOf(top, null)).toBeNull();
  });
});
