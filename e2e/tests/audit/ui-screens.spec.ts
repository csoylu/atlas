import { test, expect } from '../../harness/fixtures.ts';
import type { Page } from '@playwright/test';
import { call, tu, say } from '../../harness/audit.ts';

/** Every console error / page error / failed API response the page sees while a test runs. */
function watch(page: Page) {
  const bad: string[] = [];
  page.on('pageerror', (e) => bad.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') bad.push('console: ' + m.text());
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) bad.push(`HTTP ${r.status()} ${r.url()}`);
  });
  return bad;
}

test.describe('U · screens (Playwright, real UI, scripted model)', () => {
  test('[U01] (partial) with a name already saved the welcome sheet does not show and the app shell opens; the sheet itself is NOT exercised', async ({ page, atlas }) => {
    // fresh engine without the name the harness presets
    await call(atlas, 'PATCH', '/settings', {});
    await page.goto(atlas.url);
    // the harness already set a name; the sheet must not show then
    await expect(page.getByRole('navigation').first()).toBeVisible();
  });

  test('[U02] sidebar: Inbox / Tasks / Library / Workflows navigate and set the hash, no console errors', async ({ page, atlas }) => {
    const bad = watch(page);
    await page.goto(atlas.url);
    for (const [label, hash] of [
      ['Inbox', '#/inbox'],
      ['Tasks', '#/board'],
      ['Library', '#/library'],
      ['Workflows', '#/workflows'],
    ] as const) {
      await page.getByRole('button', { name: new RegExp('^' + label) }).first().click();
      await expect.poll(() => page.evaluate(() => location.hash)).toContain(hash);
    }
    expect(bad).toEqual([]);
  });

  test('[U03] board: New task form creates a card (priority/agent pickers, list toggle and filter NOT exercised)', async ({ page, atlas }) => {
    const bad = watch(page);
    await page.goto(atlas.url + '/#/board');
    await page.getByRole('button', { name: /New task/ }).first().click();
    await page.getByPlaceholder('Task title').fill('UI created task');
    await page.getByPlaceholder(/Description, acceptance/).fill('body text');
    await page.keyboard.press('Enter').catch(() => {});
    const form = page.getByPlaceholder('Task title');
    if (await form.isVisible().catch(() => false)) await page.getByRole('button', { name: /^(Create|Add)/ }).first().click();
    await expect.poll(async () => (await call(atlas, 'GET', '/cards')).body.map((c: any) => c.title)).toContain('UI created task');
    await expect(page.getByText('UI created task').first()).toBeVisible();
    expect(bad).toEqual([]);
  });

  test('[U04] board: an API change shows live without reload; dragging a card to Done sets its status', async ({ page, atlas }) => {
    const c = (await call(atlas, 'POST', '/cards', { title: 'drag me', status: 'todo' })).body;
    await page.goto(atlas.url + '/#/board');
    const card = page.getByText('drag me').first();
    await expect(card).toBeVisible();
    // live update: an API change shows without reload
    await call(atlas, 'PATCH', `/cards/${c.id}`, { title: 'renamed via api' });
    await expect(page.getByText('renamed via api').first()).toBeVisible();
    // drag to the Done column
    const done = page.locator('section.column.done, section.list-group').filter({ hasText: /Done/ }).first();
    await page.getByText('renamed via api').first().dragTo(done);
    await expect.poll(async () => (await call(atlas, 'GET', `/cards/${c.id}`)).body.status).toBe('done');
  });

  test('[U05] task panel: opens from ?card= beside the board, edits the description inline (saved), closes with Esc (status/assignee pickers NOT exercised)', async ({ page, atlas }) => {
    const bad = watch(page);
    const c = (await call(atlas, 'POST', '/cards', { title: 'modal card', body: 'first body', status: 'todo' })).body;
    await page.goto(atlas.url + `/#/board?card=${c.id}`);
    await expect(page.getByText('first body').first()).toBeVisible();
    // A side panel, not a modal: the board stays on screen beside it, its card marked as open.
    await expect(page.locator('.thread-panel')).toBeVisible();
    await expect(page.locator('[aria-modal="true"]')).toHaveCount(0);
    await expect(page.locator('.board-screen')).toBeVisible();
    await page.getByText('first body').first().click();
    const ta = page.getByRole('textbox', { name: /Description/ }).first();
    await ta.fill('edited body');
    await ta.blur();
    await expect.poll(async () => (await call(atlas, 'GET', `/cards/${c.id}`)).body.body).toBe('edited body');
    await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => location.hash)).not.toContain('card=');
    expect(bad).toEqual([]);
  });

  test('[U06] inbox: a blocked card shows in Needs you with its options; clicking an option answers and the card resumes', async ({ page, atlas }) => {
    const bad = watch(page);
    atlas.model.next(tu('task_block', { kind: 'needs_input', question: 'Which colour?', options: ['Red', 'Blue'] }), tu('task_complete', { summary: 'painted' }));
    const c = await atlas.task('paint it');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('blocked');
    await page.goto(atlas.url + '/#/inbox');
    await expect(page.getByText('Which colour?').first()).toBeVisible();
    await page.getByText('Which colour?').first().click();
    await page.getByRole('button', { name: 'Blue' }).first().click();
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('done');
    expect(atlas.model.lastMain.text).toContain('Blue');
    expect(bad).toEqual([]);
  });

  test('[U07] inbox: updates list, mark read on open, Archive all read', async ({ page, atlas }) => {
    atlas.model.next(tu('task_complete', { summary: 'finished A' }));
    const c = await atlas.task('task A');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('done');
    await page.goto(atlas.url + '/#/inbox');
    await expect(page.getByText('task A').first()).toBeVisible();
    await page.getByText('task A').first().click();
    await expect.poll(async () => (await call(atlas, 'GET', '/inbox')).body.badge).toBe(0);
    await page.goto(atlas.url + '/#/inbox');
    await page.getByRole('button', { name: /Archive all read/ }).click();
    await expect.poll(async () => (await call(atlas, 'GET', '/inbox')).body.updates.length).toBe(0);
  });

  test('[U08] chat: send, reply shown, chat renamed from the first message (history menu / delete NOT exercised)', async ({ page, atlas }) => {
    const bad = watch(page);
    const ch = await atlas.chat();
    await page.goto(atlas.url + `/#/chat/${ch.id}`);
    const box = page.getByPlaceholder(/Message @atlas/);
    await box.fill('hello there');
    await box.press('Enter');
    await expect(page.getByText('Reply 1 to: hello there')).toBeVisible();
    expect((await atlas.card(ch.id)).title).toContain('hello there');
    expect(bad).toEqual([]);
  });

  test('[U09] chat: Shift+Enter makes a newline and does not send; empty message is not sent', async ({ page, atlas }) => {
    const ch = await atlas.chat();
    await page.goto(atlas.url + `/#/chat/${ch.id}`);
    const box = page.getByPlaceholder(/Message @atlas/);
    await box.fill('line1');
    await box.press('Shift+Enter');
    await box.type('line2');
    expect(await box.inputValue()).toBe('line1\nline2');
    expect((await call(atlas, 'GET', `/cards/${ch.id}/messages`)).body.length).toBe(0);
    await box.fill('   ');
    await box.press('Enter');
    expect((await call(atlas, 'GET', `/cards/${ch.id}/messages`)).body.length).toBe(0);
  });

  test('[U10] chat: a write_file step shows as a row; Stop aborts a long shell (step detail view NOT exercised)', async ({ page, atlas }) => {
    const bad = watch(page);
    const ch = await atlas.chat();
    atlas.model.next(tu('write_file', { path: 'notes/a.md', content: '# A\n\nhello' }), tu('shell', { command: 'sleep 30' }));
    await page.goto(atlas.url + `/#/chat/${ch.id}`);
    const box = page.getByPlaceholder(/Message @atlas/);
    await box.fill('do things');
    await box.press('Enter');
    await expect(page.getByText(/notes\/a\.md/).first()).toBeVisible();
    const stop = page.getByRole('button', { name: /^Stop/ }).first();
    await expect(stop).toBeVisible({ timeout: 10_000 });
    await stop.click();
    await expect.poll(async () => (await call(atlas, 'GET', `/cards/${ch.id}/runs`)).body.at(-1)?.status, { timeout: 15_000 }).toMatch(/stopped|done/);
    expect(bad).toEqual([]);
  });

  test('[U11] library: lists a document, opens its viewer, New folder creates a folder (versions UI NOT exercised)', async ({ page, atlas }) => {
    const bad = watch(page);
    const ch = await atlas.chat();
    atlas.model.next(tu('write_file', { path: 'docs/spec.md', content: '# Spec\n\n## One\ntext\n' }), say('done'));
    await atlas.say(ch.id, 'write spec');
    await expect.poll(async () => (await call(atlas, 'GET', '/documents')).body.length).toBe(1);
    await page.goto(atlas.url + '/#/library');
    const doc = (await call(atlas, 'GET', '/documents')).body[0];
    await expect(page.getByText('Spec', { exact: true }).first()).toBeVisible();
    await page.goto(atlas.url + '/#/library/' + doc.id);
    await expect(page.getByRole('heading', { name: 'One' }).first()).toBeVisible();
    await page.goto(atlas.url + '/#/library');
    await page.getByRole('button', { name: 'New folder' }).first().click();
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Audit folder');
    await page.getByRole('textbox', { name: 'Folder name' }).press('Enter');
    await expect.poll(async () => (await call(atlas, 'GET', '/folders')).body.map((f: any) => f.name)).toEqual(['Audit folder']);
    expect(bad).toEqual([]);
  });

  test('[U12] workflows: create from the list (by hand), the canvas opens; Run now from the list opens its task; off; delete (wiring: workflows.spec.ts)', async ({ page, atlas }) => {
    const bad = watch(page);
    page.on('dialog', (d) => d.accept());
    atlas.model.next(tu('task_complete', { summary: 'workflow run done' }));
    await page.goto(atlas.url + '/#/workflows');
    await expect(page.getByText('Memory cleanup').first()).toBeVisible();
    await page.getByRole('button', { name: 'New workflow' }).click();
    await page.getByLabel('Name').fill('Ping the team');
    await page.getByRole('radio', { name: /Only by hand/ }).click();
    await page.getByRole('button', { name: 'Create and open the canvas' }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/#\/workflows\/wf_/);
    const side = page.getByRole('complementary', { name: 'Step' });
    await side.getByLabel('Agent').selectOption('atlas');
    await side.getByLabel('Prompt').fill('Ping the team');
    const wf = (await call(atlas, 'GET', '/workflows')).body.find((x: any) => x.name === 'Ping the team');
    await expect.poll(async () => (await call(atlas, 'GET', `/workflows/${wf.id}`)).body.nodes.find((n: any) => n.id === 'step1').config.prompt).toBe('Ping the team');
    await page.goto(atlas.url + '/#/workflows');
    const row = page.locator('.model-list > *').filter({ hasText: 'Ping the team' }).first();
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Run now' }).click();
    await expect.poll(async () => (await call(atlas, 'GET', '/cards')).body.length).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => location.hash)).toContain('card='); // Run now opens the card
    await page.keyboard.press('Escape');
    // off
    await row.locator('label.switch').click();
    await expect.poll(async () => (await call(atlas, 'GET', `/workflows/${wf.id}`)).body.enabled).toBe(false);
    // delete: from the trigger's panel
    await row.getByRole('button', { name: 'Open' }).click();
    await page.locator('.wf-node[data-id="trigger"]').click();
    await page.getByRole('button', { name: 'Delete workflow' }).click();
    await expect.poll(async () => (await call(atlas, 'GET', '/workflows')).body.some((x: any) => x.id === wf.id)).toBe(false);
    expect(bad).toEqual([]);
  });

  test('[U13] settings: every page opens from the nav without errors and shows content', async ({ page, atlas }) => {
    const bad = watch(page);
    await page.goto(atlas.url + '/#/settings');
    const links = page.getByRole('navigation', { name: 'Settings' }).getByRole('link');
    await expect(links.first()).toBeVisible();
    const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThanOrEqual(8);
    for (const h of hrefs) {
      await page.goto(atlas.url + '/' + h);
      await page.waitForTimeout(300);
      const txt = await page.locator('.settings-main').innerText();
      expect(txt.trim().length, h!).toBeGreaterThan(20);
    }
    console.log('SETTINGS PAGES', hrefs.join(' '));
    expect(bad).toEqual([]);
  });

  test('[U14] memory page: a memory shows and the search box filters it (add/edit/pin/archive in the UI NOT exercised; the API is in Y01)', async ({ page, atlas }) => {
    const bad = watch(page);
    await call(atlas, 'POST', '/memories', { kind: 'fact', scope: 'shared', text: 'zebra fact in the UI' });
    await page.goto(atlas.url + '/#/settings/memory');
    await expect(page.getByText('zebra fact in the UI').first()).toBeVisible();
    await page.getByLabel('Search memory').fill('nomatchxyz');
    await expect(page.getByText('zebra fact in the UI')).toHaveCount(0);
    await page.getByLabel('Search memory').fill('zebra');
    await expect(page.getByText('zebra fact in the UI').first()).toBeVisible();
    expect(bad).toEqual([]);
  });

  test('[U15] command palette: Cmd+K opens, searches tasks (#N) and chats, Esc closes; shortcuts help', async ({ page, atlas }) => {
    const bad = watch(page);
    const c = (await call(atlas, 'POST', '/cards', { title: 'palette target', status: 'todo' })).body;
    await page.goto(atlas.url + '/#/board');
    await page.keyboard.press('Meta+k');
    const dlg = page.getByRole('dialog', { name: /Command palette/ }).or(page.getByLabel('Command palette'));
    await expect(dlg.first()).toBeVisible();
    await page.getByPlaceholder(/Search artifacts, chats, tasks/).fill('palette tar');
    await expect(dlg.first().getByText('palette target').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => location.hash)).toContain(c.id);
    await page.keyboard.press('Meta+k');
    await expect(dlg.first()).toBeVisible();
    // under load the palette is visible a moment before its key handler is attached: press Esc until it closes
    await expect(async () => {
      await page.keyboard.press('Escape');
      await expect(dlg.first()).toBeHidden({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    expect(bad).toEqual([]);
  });

  test('[U16] keyboard: G then I/L/S/T navigate (C = New task NOT exercised)', async ({ page, atlas }) => {
    await page.goto(atlas.url + '/#/board');
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await expect.poll(() => page.evaluate(() => location.hash)).toContain('#/inbox');
    await page.keyboard.press('g');
    await page.keyboard.press('l');
    await expect.poll(() => page.evaluate(() => location.hash)).toContain('#/library');
    await page.keyboard.press('g');
    await page.keyboard.press('w');
    await expect.poll(() => page.evaluate(() => location.hash)).toContain('#/workflows');
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await expect.poll(() => page.evaluate(() => location.hash)).toContain('#/board');
  });

  test('[U17] side panel: panel_open shows the document beside the chat; the hide button hides it (quote chip NOT exercised)', async ({ page, atlas }) => {
    const bad = watch(page);
    const ch = await atlas.chat();
    atlas.model.next(tu('write_file', { path: 'docs/p.md', content: '# Panel doc\n\n## Alpha\nfoo\n' }), tu('panel_open', { path: 'docs/p.md' }), say('opened'));
    await page.goto(atlas.url + `/#/chat/${ch.id}`);
    const box = page.getByPlaceholder(/Message @atlas/);
    await box.fill('open a doc');
    await box.press('Enter');
    await expect(page.getByLabel('Documents').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Panel doc').first()).toBeVisible();
    await page.getByRole('button', { name: /Hide the documents panel/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Alpha' })).toBeHidden();
    expect(bad).toEqual([]);
  });

  test('[U18] responsive: at 390 px the app has no horizontal scroll on every main screen', async ({ page, atlas }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const ch = await atlas.chat();
    await atlas.converse(ch.id, 'hi');
    for (const h of ['#/inbox', '#/board', '#/library', '#/workflows', '#/settings/memory', `#/chat/${ch.id}`]) {
      await page.goto(atlas.url + '/' + h);
      await page.waitForTimeout(250);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over, h).toBeLessThanOrEqual(1);
    }
  });

  test('[U19] unknown route and unknown ids degrade gracefully (no blank screen, no uncaught error)', async ({ page, atlas }) => {
    const bad = watch(page);
    for (const h of ['#/nonsense', '#/chat/doesnotexist', '#/library/nope', '#/board?card=missing', '#/inbox/zzz', '#/settings/bogus']) {
      await page.goto(atlas.url + '/' + h);
      await page.waitForTimeout(300);
      await expect(page.locator('#root')).not.toBeEmpty();
    }
    expect(bad.filter((b) => b.startsWith('pageerror'))).toEqual([]);
  });
});
