import { test, expect, openSurface, SURFACES } from '../harness/fixtures.ts';

/** Step 1: the popup in the composer (design §8 « Slash commands »). */
for (const surface of SURFACES) {
  test.describe(`popup · ${surface}`, () => {
    test('"/" as the first character opens it with /clear and /compact, the first highlighted', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      const before = (await atlas.messages(c.id)).length;
      await expect(c.popup).toBeHidden();
      await c.type('/');
      await expect(c.popup).toBeVisible();
      expect(await c.popupNames()).toEqual(['/clear', '/compact']);
      await expect(c.selected).toHaveText('/clear');
      // Typing is not sending.
      expect(await atlas.messages(c.id)).toHaveLength(before);
    });

    test('filters as you type: "/co" shows only /compact, "/x" nothing, "/CL" is case-blind', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await c.type('/co');
      expect(await c.popupNames()).toEqual(['/compact']);
      await c.type('/cl');
      expect(await c.popupNames()).toEqual(['/clear']);
      await c.type('/CL');
      expect(await c.popupNames()).toEqual(['/clear']);
      await c.type('/x');
      await expect(c.popup).toBeHidden();
      // Backspace brings it back.
      await c.box.press('Backspace');
      await expect(c.popup).toBeVisible();
      expect(await c.popupNames()).toEqual(['/clear', '/compact']);
    });

    test('a "/" anywhere but the first character opens nothing: "a/b", " /clear", "see /clear", paths', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      for (const t of ['a/b', ' /clear', 'see /clear', 'src/app/main.ts', '/ clear', '/clear now']) {
        await c.type(t);
        await expect(c.popup, `popup for "${t}"`).toBeHidden();
      }
    });

    test('↑/↓ move the highlight and wrap around', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await c.type('/');
      await expect(c.selected).toHaveText('/clear');
      await c.box.press('ArrowDown');
      await expect(c.selected).toHaveText('/compact');
      await c.box.press('ArrowDown');
      await expect(c.selected).toHaveText('/clear');
      await c.box.press('ArrowUp');
      await expect(c.selected).toHaveText('/compact');
      await c.box.press('ArrowUp');
      await expect(c.selected).toHaveText('/clear');
      // The arrows moved the highlight, not the text.
      await expect(c.box).toHaveValue('/');
    });

    test('Esc closes it and keeps the text; it opens again when the text changes', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await c.type('/co');
      await expect(c.popup).toBeVisible();
      await c.box.press('Escape');
      await expect(c.popup).toBeHidden();
      await expect(c.box).toHaveValue('/co');
      await c.box.pressSequentially('m');
      await expect(c.popup).toBeVisible();
    });

    test('Enter runs the highlighted command (and ↓ Enter the next one); nothing is posted as a message', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha', 'beta');
      const userMsgs = async () => (await atlas.messages(c.id)).filter((m) => m.author === 'user').length;
      const before = await userMsgs();
      const mains = atlas.model.of('main').length;

      // "/" + ↓ + Enter = /compact.
      const compact = page.waitForResponse((r) => r.url().endsWith('/command'));
      await c.type('/');
      await c.box.press('ArrowDown');
      await c.box.press('Enter');
      expect((await compact).request().postDataJSON()).toEqual({ command: 'compact' });
      await expect(c.compactRow).toBeVisible();
      await expect(c.box).toHaveValue('');
      await expect(c.popup).toBeHidden();

      // "/" + Enter = /clear.
      await atlas.converse(c.id, 'gamma');
      const clear = page.waitForResponse((r) => r.url().endsWith('/command'));
      await c.type('/');
      await c.box.press('Enter');
      expect((await clear).request().postDataJSON()).toEqual({ command: 'clear' });
      await expect(c.clearRow).toBeVisible();

      expect(await userMsgs()).toBe(before + 1); // only « gamma »
      expect((await atlas.messages(c.id)).some((m) => JSON.stringify(m).includes('/c'))).toBe(false);
      expect(atlas.model.of('main')).toHaveLength(mains + 1); // the commands never reached the agent
    });

    test('Tab runs the highlighted command too', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha');
      expect(await c.command('/co', 'Tab')).toBe(200);
      await expect(c.compactRow).toBeVisible();
      await expect(c.box).toHaveValue('');
    });

    test('clicking an option runs it', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha');
      await c.type('/');
      await c.options.filter({ hasText: '/clear' }).click();
      await expect(c.clearRow).toBeVisible();
      await expect(c.box).toHaveValue('');
    });

    test('a fully typed command + Enter runs it and is never posted as a message', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha');
      expect(await c.command('/clear')).toBe(200);
      await expect(c.clearRow).toBeVisible();
      expect((await atlas.messages(c.id)).some((m) => JSON.stringify(m).includes('/clear'))).toBe(false);
    });

    test('"/clear now" is an ordinary message: /clear takes no argument', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha');
      await c.send('/clear now');
      await expect(c.msg('/clear now')).toBeVisible();
      await expect(c.msg(/Reply \d+ to: \/clear now/)).toBeVisible();
      await expect(c.clearRow).toHaveCount(0);
    });

    test('a failing command (nothing to clear) shows the error and gives the text back', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      // A fresh chat has nothing to clear; a fresh task has only its start.
      if (surface === 'direct chat') {
        expect(await c.command('/clear')).toBe(409);
        await expect(c.toast).toContainText('nothing to clear');
        await expect(c.box).toHaveValue('/clear');
      } else {
        expect(await c.command('/clear')).toBe(200); // the task already has its start prompt and a question
        await expect(c.clearRow).toBeVisible();
        expect(await c.command('/clear')).toBe(409);
        await expect(c.toast).toContainText('nothing to clear');
        await expect(c.box).toHaveValue('/clear');
      }
    });
  });
}
