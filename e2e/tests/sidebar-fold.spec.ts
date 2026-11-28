import { test, expect } from '../harness/fixtures.ts';

/** #397: the sidebar folds to its icons (footer toggle or ⌘\), and stays folded after a reload. */
test('the footer toggle and ⌘\\ fold the sidebar to 56 px; the state survives a reload', async ({ atlas, page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const chat = await atlas.chat();
  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  const app = page.locator('.app');
  const sidebar = page.locator('aside.sidebar');
  const toggle = page.locator('.side-toggle');
  await expect(toggle).toHaveAttribute('title', 'Fold the sidebar (⌘\\)');
  await expect(app).not.toHaveClass(/folded/);
  expect(Math.round((await sidebar.boundingBox())!.width)).toBeGreaterThan(200);

  await toggle.click();
  await expect(app).toHaveClass(/folded/);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('title', 'Unfold the sidebar (⌘\\)');
  await expect.poll(async () => Math.round((await sidebar.boundingBox())!.width)).toBe(56);
  // Icons only: the names are gone, every icon keeps its tooltip.
  await expect(sidebar.getByText('Library', { exact: true })).toBeHidden();
  await expect(sidebar.locator('.nav-item[title^="Library"]')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('atlas.sidebar'))).toBe('folded');

  await page.reload();
  await expect(app).toHaveClass(/folded/);

  // ⌘\ works while typing in the composer, and types nothing there.
  const box = page.getByPlaceholder(/Message @atlas/);
  await box.fill('hello');
  await box.press('ControlOrMeta+Backslash');
  await expect(app).not.toHaveClass(/folded/);
  await expect(box).toHaveValue('hello');
  expect(await page.evaluate(() => localStorage.getItem('atlas.sidebar'))).toBeNull();
  await page.reload();
  await expect(app).not.toHaveClass(/folded/);
});
