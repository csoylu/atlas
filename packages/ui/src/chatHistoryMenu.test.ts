import { describe, expect, it } from 'vitest';
import { deleteChatQuestion, deletedChatRoute, menuPosition } from './chatHistoryMenu.ts';

describe('chat history menu', () => {
  it('opens at the pointer when there is room', () => {
    expect(menuPosition(30, 50, 172, 48, 900, 700)).toEqual({ left: 30, top: 50 });
  });
  it('clamps the right and bottom edges using measured menu dimensions', () => {
    expect(menuPosition(899, 699, 172, 48, 900, 700)).toEqual({ left: 720, top: 644 });
  });
  it('keeps a margin at the top and left', () => {
    expect(menuPosition(-10, 0, 172, 48, 900, 700)).toEqual({ left: 8, top: 8 });
  });
  it('returns the selected deleted chat to a valid new-chat route', () => {
    expect(deletedChatRoute('#/chat/c_one', 'c_one')).toBe('#/chat/new');
  });
  it.each(['#/chat/c_other', '#/chat/new', '#/board', '#/canvas/c_one'])('preserves a different current route %s', hash => {
    expect(deletedChatRoute(hash, 'c_one')).toBeNull();
  });
  it('says a chat delete is permanent, and names the agent for its main chat (#232)', () => {
    const q = deleteChatQuestion({ title: 'Plan the release', assignee: 'atlas' }, false);
    expect(q).toContain('“Plan the release”');
    expect(q).toContain("can't be undone");
    const main = deleteChatQuestion({ title: '@atlas', assignee: 'atlas' }, true);
    expect(main).toMatch(/^Delete your whole chat with @atlas\?/);
    expect(main).toContain("can't be undone");
    expect(main).toContain('/clear');
  });
});
