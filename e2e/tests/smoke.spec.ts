import { test, expect } from '@playwright/test';
import { TestAtlas } from '../harness/engine.ts';

test('harness boots: a chat opens and answers', async ({ page }) => {
  const atlas = await TestAtlas.start();
  try {
    const chat = await atlas.chat();
    await page.goto(`${atlas.url}/#/chat/${chat.id}`);
    const box = page.getByPlaceholder(/Message @atlas/);
    await box.fill('hello');
    await box.press('Enter');
    await expect(page.getByText('Reply 1 to: hello')).toBeVisible();
  } finally {
    await atlas.stop();
  }
});
