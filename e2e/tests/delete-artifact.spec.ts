import { test, expect } from '../harness/fixtures.ts';
import type { ContentBlock } from '@atlas/shared';
import type { TestAtlas } from '../harness/engine.ts';

/** #242: delete an artifact from the Library or its viewer; a chat card of a deleted artifact says so. */
const tu = (name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id: 't' + Math.random().toString(36).slice(2, 8), name, input }];
const done = [{ type: 'text', text: 'Done.' }] as ContentBlock[];
const SHOTS = process.env.SHOTS; // a folder: screenshots of the dialog and the deleted card

async function make(atlas: TestAtlas) {
  const chat = await atlas.chat();
  atlas.model.next(
    tu('artifact_create', { kind: 'html', title: 'Old price feed mockup', content: '<h1>Old price feed mockup</h1><p>v1</p>' }),
    tu('artifact_update', { artifact: 'pages/old-price-feed-mockup.html', content: '<h1>Old price feed mockup</h1><p>v2</p>' }),
    tu('artifact_create', { kind: 'markdown', title: 'Kept spec', content: '# Kept spec' }),
    done,
  );
  await atlas.say(chat.id, 'make them');
  await atlas.idle(chat.id);
  return chat;
}
const docs = async (atlas: TestAtlas) => ((await (await fetch(atlas.url + '/api/documents')).json()) as { id: string; title: string }[]).map((d) => d.title);

test('Library row ⋯ → Delete…: confirm, gone from the Library, the chat cards say « Deleted artifact »', async ({ atlas, page }) => {
  const chat = await make(atlas);
  await page.goto(`${atlas.url}/#/library`);
  const row = page.locator('.lib-row', { hasText: 'Old price feed mockup' });
  await row.getByRole('button', { name: 'Actions for Old price feed mockup' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.locator('h2')).toHaveText('Delete «Old price feed mockup»?');
  await expect(dialog).toContainText("All 2 versions are removed. This can't be undone.");
  // Cancel keeps it
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await docs(atlas)).toContain('Old price feed mockup');

  await row.getByRole('button', { name: 'Actions for Old price feed mockup' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.lib-row', { hasText: 'Old price feed mockup' })).toHaveCount(0);
  await expect(page.locator('.lib-row', { hasText: 'Kept spec' })).toHaveCount(1);
  expect(await docs(atlas)).toEqual(['Kept spec']);

  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  const gone = page.locator('.artifact.deleted');
  await expect(gone).toHaveCount(2);
  await expect(gone.first().locator('.art-meta')).toHaveText('Deleted artifact · Page · v1');
  await expect(page.locator('button.artifact')).toHaveCount(1); // Kept spec still opens
});

test('viewer ⋯ → Delete…: the open panel tab closes and the cards turn « Deleted » live', async ({ atlas, page }) => {
  const chat = await make(atlas);
  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  await page.locator('button.artifact').first().click();
  const panel = page.locator('aside.side-doc');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.artifact.deleted')).toHaveCount(2);
  expect(await docs(atlas)).toEqual(['Kept spec']);
});

if (SHOTS)
  for (const theme of ['dark', 'light'] as const)
    for (const width of [1440, 390])
      test(`screenshots · ${theme} ${width}px`, async ({ atlas, browser }) => {
        const chat = await make(atlas);
        const page = await (await browser.newContext({ viewport: { width, height: width > 500 ? 900 : 844 }, colorScheme: theme, isMobile: width < 500, hasTouch: width < 500 })).newPage();
        await page.goto(`${atlas.url}/?theme=${theme}#/library`);
        const row = page.locator('.lib-row', { hasText: 'Old price feed mockup' });
        await row.getByRole('button', { name: 'Actions for Old price feed mockup' }).click();
        await page.getByRole('menuitem', { name: 'Delete…' }).click();
        await expect(page.getByRole('alertdialog')).toContainText('All 2 versions');
        await page.screenshot({ path: `${SHOTS}/confirm-${theme}-${width}.png` });
        await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
        await expect(row).toHaveCount(0);
        await page.goto(`${atlas.url}/?theme=${theme}#/chat/${chat.id}`);
        await page.getByRole('button', { name: 'Close Kept spec' }).click(); // the other artifact's tab (artifact_create opened it)
        await expect(page.locator('aside.side-doc')).toHaveCount(0);
        await expect(page.locator('.artifact.deleted')).toHaveCount(2);
        await page.screenshot({ path: `${SHOTS}/deleted-card-${theme}-${width}.png` });
      });

test('Library viewer ⋯ → Delete…: back to the Library list', async ({ atlas, page }) => {
  await make(atlas);
  const id = ((await (await fetch(atlas.url + '/api/documents')).json()) as { id: string; title: string }[]).find((d) => d.title === 'Old price feed mockup')!.id;
  await page.goto(`${atlas.url}/#/library/${id}`);
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/#\/library$/);
  await expect(page.locator('.lib-row', { hasText: 'Kept spec' })).toHaveCount(1);
  await expect(page.locator('.lib-row', { hasText: 'Old price feed mockup' })).toHaveCount(0);
});
