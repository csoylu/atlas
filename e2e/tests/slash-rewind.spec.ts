import { test, expect, openSurface, SURFACES } from '../harness/fixtures.ts';
import type { Conv } from '../harness/conv.ts';

/** Step 5: rewind across a clear. */

/** Rewinds to the user message `text` from the chat, through the confirmation sheet. */
async function rewindTo(c: Conv, text: string): Promise<void> {
  const msg = c.scope.locator('.msg.user').filter({ has: c.page.locator('p', { hasText: new RegExp('^' + text + '$') }) });
  await msg.hover();
  await msg.getByRole('button', { name: 'Rewind to here' }).click();
  await c.page.getByRole('button', { name: 'Rewind', exact: true }).click();
}

/** first, second, then a /clear; the earlier messages are shown so the user can reach them. */
async function clearedChat(c: Conv): Promise<void> {
  await c.atlas.converse(c.id, 'tulip', 'violet');
  expect(await c.command('/clear')).toBe(200);
  await c.open(c.clearRow);
  await c.clearRow.getByRole('button', { name: /Show \d+ earlier messages/ }).click();
  await expect(c.msg('violet')).toBeVisible();
}

for (const surface of SURFACES) {
  test.describe(`rewind across a clear · ${surface}`, () => {
    test('rewinding to a message before the clear removes the clear, and the model sees the earlier messages again', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await clearedChat(c);

      await rewindTo(c, 'violet');
      await expect(c.clearRow).toHaveCount(0);
      expect(await atlas.clears(c.id)).toEqual([]);
      await expect(c.box).toHaveValue('violet'); // the text is back in the box
      await expect(c.msg('tulip')).toBeVisible(); // nothing folded any more
      await expect(c.msg('violet')).toHaveCount(0); // the rewound message left the chat

      // Resend from there: the agent has « tulip » (before the target) in its view again.
      await c.box.press('Enter');
      await expect(c.msg(/Reply \d+ to: violet/)).toBeVisible();
      await atlas.idle(c.id);
      const view = atlas.model.lastMain.text;
      expect(view).toContain('tulip');
      expect(view).toMatch(/Reply \d+ to: tulip/);
      // and no clear came back by itself
      await expect(c.clearRow).toHaveCount(0);
    });

    test('undoing the rewind brings the clear back: the row, the fold, and the agent forgets again', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await clearedChat(c);
      const [clear] = await atlas.clears(c.id);

      await rewindTo(c, 'violet');
      await expect(c.clearRow).toHaveCount(0);
      await c.scope.getByRole('button', { name: 'Undo', exact: true }).click();

      await expect(c.clearRow).toBeVisible();
      expect((await atlas.clears(c.id)).map((x) => x.id)).toEqual([clear!.id]);
      // Folded again: the earlier messages are behind the row.
      await expect(c.msg('tulip')).toHaveCount(0);
      await expect(c.msg('violet')).toHaveCount(0);
      await expect(c.box).toHaveValue(''); // the text the rewind put back left with the undo

      await c.send('after the undo');
      await expect(c.msg(/Reply \d+ to: after the undo/)).toBeVisible();
      const view = atlas.model.lastMain.text;
      expect(view).toContain('after the undo');
      expect(view).not.toContain('tulip');
      expect(view).not.toContain('violet');
    });

    test('rewinding to a message sent after the clear keeps the clear', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'tulip');
      expect(await c.command('/clear')).toBe(200);
      await atlas.converse(c.id, 'later one', 'later two');

      await rewindTo(c, 'later two');
      await expect(c.clearRow).toHaveCount(1);
      expect(await atlas.clears(c.id)).toHaveLength(1);
      await expect(c.msg('tulip')).toHaveCount(0); // still folded
      await expect(c.msg('later one')).toBeVisible();
      await c.box.press('Enter');
      await expect(c.msg(/Reply \d+ to: later two/)).toBeVisible();
      const view = atlas.model.lastMain.text;
      expect(view).toContain('later one');
      expect(view).not.toContain('tulip');
    });

    test('Undo clear is not offered once a rewind took the clear away', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await clearedChat(c);
      const [clear] = await atlas.clears(c.id);
      await rewindTo(c, 'violet');
      const r = await fetch(`${atlas.url}/api/clears/${clear!.id}/undo`, { method: 'POST' });
      expect(r.status).toBe(409);
    });
  });
}
