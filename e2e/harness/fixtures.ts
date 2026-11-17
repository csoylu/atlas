import { test as base, expect, type Page } from '@playwright/test';
import { TestAtlas } from './engine.ts';
import { Conv } from './conv.ts';

export { expect };

export type Surface = 'direct chat' | 'task chat';
export const SURFACES: Surface[] = ['direct chat', 'task chat'];

/** `atlas`: a fresh engine per test (stopped and its data removed afterwards). */
export const test = base.extend<{ atlas: TestAtlas }>({
  // eslint-disable-next-line no-empty-pattern
  atlas: async ({}, use) => {
    const atlas = await TestAtlas.start();
    await use(atlas);
    await atlas.stop();
  },
});

/**
 * Opens a conversation as the user sees it: a direct chat (#/chat/<id>) or a task's chat (the ticket modal on the board).
 * A task starts with one scripted turn that ends by asking the user, so it waits for the user's messages like a chat.
 */
export async function openSurface(atlas: TestAtlas, page: Page, surface: Surface): Promise<Conv> {
  if (surface === 'direct chat') {
    const chat = await atlas.chat();
    await page.goto(`${atlas.url}/#/chat/${chat.id}`);
    const conv = new Conv(page, atlas, chat, surface);
    await expect(conv.box).toBeVisible();
    return conv;
  }
  atlas.model.next([{ type: 'text', text: 'Which part first?' }]);
  const task = await atlas.task('E2E task');
  await expect.poll(async () => (await atlas.card(task.id)).status).toBe('blocked');
  await atlas.idle(task.id);
  await page.goto(`${atlas.url}/#/board?card=${task.id}`);
  const conv = new Conv(page, atlas, task, surface);
  await expect(conv.box).toBeVisible();
  return conv;
}
