import { test, expect, openSurface, SURFACES } from '../harness/fixtures.ts';
import { SUMMARY_LEAD } from '../../packages/engine/src/context.ts';

/** Step 2: /compact and /compact <focus>. */
for (const surface of SURFACES) {
  test.describe(`/compact · ${surface}`, () => {
    test('writes the summary now: « Compacted by you · N messages → 1 summary », the body shows it, the agent reads it instead of the history', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic', 'beta topic');
      const visible = (await atlas.messages(c.id)).filter((m) => m.author !== 'tool').length;

      expect(await c.command('/compact')).toBe(200);
      const row = c.compactRow;
      await expect(row).toBeVisible();
      await expect(row).toContainText(`${visible} messages → 1 summary`);
      expect(atlas.model.of('summary')).toHaveLength(1);
      expect(atlas.model.of('summary')[0]!.text).not.toContain('with this focus'); // no focus asked

      // Its body is the summary.
      await c.open(row);
      await expect(row).toContainText('SUMMARY1');
      await expect(row).toContainText('the conversation so far, condensed.');

      // The chat is not folded (that is /clear's job): the messages are still on screen.
      await expect(c.msg('alpha topic')).toBeVisible();
      await expect(c.msg(/Reply \d+ to: beta topic/)).toBeVisible();

      // The next call carries the summary and no longer the old turns.
      await atlas.converse(c.id, 'gamma topic');
      const view = atlas.model.lastMain.text;
      expect(view).toContain(SUMMARY_LEAD);
      expect(view).toContain('SUMMARY1');
      expect(view).toContain('gamma topic');
      expect(view).not.toContain('alpha topic');
      expect(view).not.toMatch(/Reply \d+ to: beta topic/);
    });

    test('/compact <focus>: the summarizer request contains the focus, and so does the summary shown', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic', 'beta topic');
      expect(await c.command('/compact keep the rewind design')).toBe(200);
      const [call] = atlas.model.of('summary');
      expect(call!.text).toContain('with this focus: keep the rewind design');
      await c.open(c.compactRow);
      await expect(c.compactRow).toContainText('[focus: keep the rewind design]');
    });

    test('compacting again later moves the summary forward: it covers the old summary and what came after', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      expect(await c.command('/compact')).toBe(200);
      await atlas.converse(c.id, 'beta topic');
      expect(await c.command('/compact')).toBe(200);
      const second = atlas.model.of('summary').at(-1)!;
      expect(second.text).toContain('SUMMARY1'); // the first summary is an input of the second
      expect(second.text).toContain('beta topic');
      await atlas.converse(c.id, 'gamma topic');
      const view = atlas.model.lastMain.text;
      expect(view).toContain('SUMMARY2');
      expect(view).not.toContain('SUMMARY1');
    });

    test('a second /compact with nothing new is a 409 and a toast, and writes nothing', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      expect(await c.command('/compact')).toBe(200);
      await expect(c.compactRow).toBeVisible();

      expect(await c.command('/compact')).toBe(409);
      await expect(c.toast).toContainText('nothing new to compact');
      await expect(c.box).toHaveValue('/compact'); // given back, not lost
      expect(atlas.model.of('summary')).toHaveLength(1);
      await expect(c.compactRow).toHaveCount(1);

      // New messages make it possible again, and the second summary folds the first.
      await atlas.converse(c.id, 'delta topic');
      expect(await c.command('/compact')).toBe(200);
      expect(atlas.model.of('summary')).toHaveLength(2);
      expect(atlas.model.of('summary')[1]!.text).toContain('Summary so far:');
      expect(atlas.model.of('summary')[1]!.text).toContain('SUMMARY1');
    });

    test('the spinner line shows while the summary is written, then goes', async ({ atlas, page }) => {
      const c = await openSurface(atlas, page, surface);
      await atlas.converse(c.id, 'alpha topic');
      await page.route('**/command', async (r) => {
        await new Promise((res) => setTimeout(res, 800));
        await r.continue();
      });
      await c.type('/compact');
      await c.box.press('Enter');
      await expect(c.busy).toContainText('Compacting');
      await expect(c.compactRow).toBeVisible();
      await expect(c.busy).toHaveCount(0);
    });

    test('nothing to compact yet in an empty chat: 409 with the text given back', async ({ atlas, page }) => {
      test.skip(surface === 'task chat', 'a task always has its start prompt');
      const c = await openSurface(atlas, page, surface);
      expect(await c.command('/compact')).toBe(409);
      await expect(c.toast).toContainText('nothing to compact yet');
      await expect(c.compactRow).toHaveCount(0);
    });
  });
}
