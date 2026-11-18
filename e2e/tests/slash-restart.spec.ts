import { test, expect, openSurface, SURFACES } from '../harness/fixtures.ts';

/** Step 6: the clear point survives an engine restart. */
for (const surface of SURFACES) {
  test.describe(`restart · ${surface}`, () => {
    test('after a /clear the engine restarts: the row, the fold and the agent view are the same', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic', 'beta topic');
      expect(await c.command('/clear')).toBe(200);
      await expect(c.clearRow).toBeVisible();
      const before = await atlas.clears(c.id);

      await atlas.restart();
      await page.goto(page.url().replace(/^http:\/\/[^/]+/, atlas.url));
      await expect(c.box).toBeVisible();

      expect(await atlas.clears(c.id)).toEqual(before);
      await expect(c.clearRow).toBeVisible();
      await expect(c.msg('alpha topic')).toHaveCount(0);
      await c.open(c.clearRow);
      await c.clearRow.getByRole('button', { name: /Show \d+ earlier messages/ }).click();
      await expect(c.msg('alpha topic')).toBeVisible();

      // The agent still starts fresh.
      await c.send('after restart');
      await expect(c.msg(/Reply \d+ to: after restart/)).toBeVisible();
      const view = atlas.model.lastMain.text;
      expect(view).toContain('after restart');
      expect(view).not.toContain('alpha topic');
      expect(view).not.toContain('beta topic');
    });

    test('Undo clear still works after a restart (while nothing was sent since)', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      expect(await c.command('/clear')).toBe(200);
      await atlas.restart();
      await page.goto(page.url().replace(/^http:\/\/[^/]+/, atlas.url));
      await expect(c.clearRow).toBeVisible();
      await c.open(c.clearRow);
      await c.clearRow.getByRole('button', { name: 'Undo clear' }).click();
      await expect(c.clearRow).toHaveCount(0);
      await expect(c.msg('alpha topic')).toBeVisible();
    });

    test('a /compact summary survives a restart too, and a clear after it hides it', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      expect(await c.command('/compact')).toBe(200);
      await atlas.restart();
      await page.goto(page.url().replace(/^http:\/\/[^/]+/, atlas.url));
      await expect(c.compactRow).toBeVisible();
      await atlas.converse(c.id, 'beta topic');
      expect(atlas.model.lastMain.text).toContain('SUMMARY1');
      expect(await c.command('/clear')).toBe(200);
      await atlas.restart();
      await atlas.converse(c.id, 'gamma topic');
      expect(atlas.model.lastMain.text).not.toContain('SUMMARY1');
      expect(atlas.model.lastMain.text).not.toContain('beta topic');
    });
  });
}
