import { test, expect } from '../harness/fixtures.ts';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';

/**
 * #381: a url artifact showing a workspace page in the pane, scrolled far down, then an area dragged in comment mode.
 * The comment is in the page's own coordinates (the scroll added, `of` = the whole page) and names what is inside,
 * as an html artifact's does: the helper in the frame answers, not an overlay over the frame.
 * (The picture cut from those coordinates is checked with a real Chrome in test/screenshot.chrome.test.ts.)
 */
const LONG = `<!doctype html><html><head><style>body{margin:0;font:16px sans-serif}section{height:1400px;padding:24px}</style></head><body>
<section style="background:#fde2e2"><h2>Section 1</h2><p>The top of the page.</p></section>
<section style="background:#e2f0fd"><h2>Section 2</h2></section>
<section style="background:#e2fde6"><h2 id="s3">Section 3</h2><div class="bars" style="margin-top:40px">
<div class="bar" style="width:200px;height:24px;background:#3a7">Working bar one</div>
<div class="bar" style="width:160px;height:24px;margin-top:8px;background:#3a7">Working bar two</div></div></section>
</body></html>`;

const tu = (name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id: 't' + Math.random().toString(36).slice(2, 8), name, input }];

test('an area dragged in a scrolled url page: the box is offset by the scroll and inside names the bars', async ({ atlas, page }) => {
  const ws = join(atlas.dataDir, 'workspaces', 'atlas');
  mkdirSync(join(ws, 'pages'), { recursive: true });
  writeFileSync(join(ws, 'pages', 'long.html'), LONG);
  const chat = await atlas.chat();
  atlas.model.next(tu('artifact_create', { kind: 'url', title: 'Long page', content: '/api/files/atlas/pages/long.html' }), [{ type: 'text', text: 'Done.' }]);
  await atlas.say(chat.id, 'make it');
  await atlas.idle(chat.id);

  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  await page.locator('.artifact', { hasText: 'Long page' }).first().click();
  await expect.poll(() => page.frames().some((f) => f.url().includes('pages/long.html'))).toBe(true);
  const frame = page.frames().find((f) => f.url().includes('pages/long.html'))!;
  await frame.waitForFunction(() => !!(window as unknown as { __atlasPane?: unknown }).__atlasPane);
  // Scroll to section 3, then comment mode.
  await frame.evaluate(() => document.getElementById('s3')!.scrollIntoView({ block: 'start' }));
  const scrollY = await frame.evaluate(() => scrollY);
  expect(scrollY).toBeGreaterThan(2000);
  await page.locator('aside.side-doc').getByRole('button', { name: 'Comment' }).click();

  // Drag around the two bars (in the app's coordinates: the frame's box plus the bars' place in its viewport).
  const fb = (await page.locator('aside.side-doc iframe').boundingBox())!;
  const bars = await frame.evaluate(() => {
    const r = document.querySelector('.bars')!.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const x0 = fb.x + bars.x - 10;
  const y0 = fb.y + bars.y - 10;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + 120, y0 + 40, { steps: 4 });
  await page.mouse.move(x0 + 240, y0 + bars.h + 20, { steps: 4 });
  await page.mouse.up();

  const box = page.locator('.cm-box');
  await expect(box).toBeVisible();
  await box.locator('textarea').fill('These bars.');
  await box.getByRole('button', { name: 'Add' }).click();
  if (process.env.SHOT_381) await page.screenshot({ path: join(process.env.SHOT_381, 'pane.png') });
  const before = atlas.model.of('main').length;
  await page.getByPlaceholder('Message @atlas').fill('look');
  atlas.model.next([{ type: 'text', text: 'ok' }]);
  await page.getByPlaceholder('Message @atlas').press('Enter');
  await expect.poll(() => atlas.model.of('main').length).toBeGreaterThan(before);
  await atlas.idle(chat.id);

  const sent = atlas.model.lastMain.text;
  const m = /area x=(\d+) y=(\d+) w=(\d+) h=(\d+) px of (\d+)×(\d+)/.exec(sent);
  expect(m, sent).not.toBeNull();
  const [, , y, , h, , of] = m!.map(Number);
  expect(y).toBeGreaterThan(scrollY); // the page's coordinates, not the frame's
  expect(Math.abs(y! - (scrollY + bars.y - 10))).toBeLessThanOrEqual(2);
  expect(h).toBeGreaterThan(50);
  expect(of).toBeGreaterThan(4000); // the whole page, not the frame
  expect(sent).toContain('Working bar one');
  expect(sent).toContain('Working bar two');
  expect(sent).not.toContain('The top of the page');
  if (process.env.SHOT_381) {
    const last = atlas.model.lastMain.req.messages.at(-1)!;
    const img = (last.content as ContentBlock[]).find((b) => b.type === 'image') as { path?: string } | undefined;
    writeFileSync(join(process.env.SHOT_381, 'sent.txt'), sent);
    if (img?.path) copyFileSync(img.path, join(process.env.SHOT_381, 'picture.png'));
  }
});
