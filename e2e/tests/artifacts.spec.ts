import { test, expect } from '../harness/fixtures.ts';
import type { Locator } from '@playwright/test';
import type { ContentBlock } from '@atlas/shared';
import type { TestAtlas } from '../harness/engine.ts';

/** #127: artifacts (#120): chat card, one-row viewer, Library. A scripted model makes the artifacts. */
const tu = (name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id: 't' + Math.random().toString(36).slice(2, 8), name, input }];
const done = [{ type: 'text', text: 'Done.' }] as ContentBlock[];

async function makeSpec(atlas: TestAtlas) {
  const chat = await atlas.chat();
  atlas.model.next(
    tu('artifact_create', { kind: 'markdown', title: 'Viewer spec', content: '# Viewer spec\n\nv1 body', folder: 'Design' }),
    tu('artifact_update', { artifact: 'docs/viewer-spec.md', content: '# Viewer spec\n\nv2 body' }),
    tu('artifact_update', { artifact: 'docs/viewer-spec.md', content: '# Viewer spec\n\nv3 body' }),
    done,
  );
  await atlas.say(chat.id, 'make the spec');
  await atlas.idle(chat.id);
  return chat;
}

test('chat cards: Kind · vN, Updated to vN, vM is the latest; a card opens its own version', async ({ atlas, page }) => {
  const chat = await makeSpec(atlas);
  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  const cards = page.locator('.artifact');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0).locator('.art-meta')).toHaveText('Document · v1 · v3 is the latest');
  await expect(cards.nth(1).locator('.art-meta')).toHaveText('Updated to v2 · Document · v3 is the latest');
  await expect(cards.nth(2).locator('.art-meta')).toHaveText('Updated to v3 · Document');
  await expect(cards.nth(2).locator('.art-meta')).not.toContainText('latest');

  await cards.nth(0).click();
  const panel = page.locator('aside.side-doc');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('v1 body')).toBeVisible();
  // ONE header row
  await expect(panel.locator('.sd-head')).toHaveCount(1);
  const ver = panel.locator('.sd-ver-btn');
  await expect(ver).toHaveText('v1 of 3');
  await expect(ver).toHaveClass(/old/);
  await expect(panel.getByRole('button', { name: 'Latest' })).toBeVisible();
  // the other cards show their versions
  await cards.nth(1).click();
  await expect(panel.getByText('v2 body')).toBeVisible();
  await expect(ver).toHaveText('v2 of 3');
  await panel.getByRole('button', { name: 'Latest' }).click();
  await expect(ver).toHaveText('v3');
  await expect(panel.getByRole('button', { name: 'Latest' })).toHaveCount(0);
  await expect(panel.getByText('v3 body')).toBeVisible();
});

test('viewer: version picker restores, ⋯ menu content in a chat', async ({ atlas, page }) => {
  const chat = await makeSpec(atlas);
  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  await page.locator('.artifact').nth(0).click();
  const panel = page.locator('aside.side-doc');
  await panel.locator('.sd-ver-btn').click();
  const rows = page.locator('.fixed-pop .pop-row');
  await expect(rows).toHaveCount(4); // v1..v3 + Restore
  await expect(page.locator('.fixed-pop')).toContainText('Restore v1 as v4');
  await page.getByRole('menuitem', { name: /Restore v1 as v4/ }).click();
  await expect(panel.locator('.sd-ver-btn')).toHaveText('v4');
  await expect(panel.getByText('v1 body')).toBeVisible();
  const v = (await (await fetch(atlas.url + '/api/documents')).json()) as { title: string; version: number }[];
  expect(v.find((d) => d.title === 'Viewer spec')?.version).toBe(4);
  // ⋯ menu
  await panel.getByRole('button', { name: 'More' }).click();
  const pop = page.locator('.fixed-pop');
  await expect(pop).toContainText('Design'); // folder
  await expect(pop).toContainText('docs/viewer-spec.md');
  await expect(pop.getByText('Show the source')).toBeVisible();
  await expect(pop.getByText('Open in the Library')).toBeVisible();
  await expect(pop.getByText('Open in the browser')).toHaveCount(0);
  await pop.getByText('Show the source').click();
  await expect(panel.locator('.sd-src')).toContainText('# Viewer spec');
  // the old Preview/Source/History row, "Opened by" row and the banner are gone
  await expect(panel.getByText(/Viewing v\d+ of/)).toHaveCount(0);
});

test('kinds: page, diagram and link cards; link menu has Open in the browser', async ({ atlas, page }) => {
  const chat = await atlas.chat();
  atlas.model.next(
    tu('artifact_create', { kind: 'html', title: 'Orb page', content: '<h1>hello page</h1>' }),
    tu('artifact_create', { kind: 'svg', title: 'Flow', content: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40"><rect width="100" height="40" fill="red"/></svg>' }),
    tu('artifact_create', { kind: 'url', title: 'Dev server', content: 'http://localhost:5173' }),
    done,
  );
  await atlas.say(chat.id, 'go');
  await atlas.idle(chat.id);
  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  const cards = page.locator('.artifact');
  await expect(cards.nth(0).locator('.art-meta')).toHaveText('Page · v1');
  await expect(cards.nth(1).locator('.art-meta')).toHaveText('Diagram · v1');
  await expect(cards.nth(2).locator('.art-meta')).toHaveText('Link · v1');
  await cards.nth(2).click();
  const panel = page.locator('aside.side-doc');
  await panel.getByRole('button', { name: 'More' }).click();
  await expect(page.locator('.fixed-pop').getByText('Open in the browser')).toBeVisible();
  await expect(page.locator('.fixed-pop').getByText('Show the address')).toBeVisible();
});

test('phone: the panel is full screen with ‹ Back', async ({ atlas, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const chat = await makeSpec(atlas);
  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  const panel = page.locator('aside.side-doc');
  // The agent's artifacts are open in the panel: on a phone it covers the chat until ‹ Back.
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: /Back/ }).click();
  await expect(panel).toBeHidden();
  await page.locator('.artifact').nth(0).click();
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(388);
  expect(box!.height).toBeGreaterThanOrEqual(780);
  await expect(panel.locator('.sd-head')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: /Back/ })).toBeVisible();
  await panel.getByRole('button', { name: /Back/ }).click();
  await expect(panel).toBeHidden();
  // Hide at desktop boundary 760/761
  await page.setViewportSize({ width: 761, height: 844 });
  await page.locator('.artifact').nth(0).click();
  await expect(panel).toBeVisible();
});

test('desktop: Full size toggles', async ({ atlas, page }) => {
  const chat = await makeSpec(atlas);
  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  await page.locator('.artifact').nth(2).click();
  const panel = page.locator('aside.side-doc');
  const w0 = (await panel.boundingBox())!.width;
  await panel.getByRole('button', { name: 'Full size' }).click();
  await expect(panel).toHaveClass(/full/);
  expect((await panel.boundingBox())!.width).toBeGreaterThan(w0);
  await panel.getByRole('button', { name: 'Back to the side panel' }).click();
  await expect(panel).not.toHaveClass(/full/);
  await panel.getByRole('button', { name: 'Close the panel' }).click();
  await expect(panel).toBeHidden();
});

async function seedLibrary(atlas: TestAtlas) {
  const chat = await atlas.chat();
  const mk = (kind: string, title: string, content: string, folder?: string) => tu('artifact_create', { kind, title, content, ...(folder ? { folder } : {}) });
  atlas.model.next(
    mk('markdown', 'Alpha spec', '# Alpha spec\nthe quick brown zebra jumps', 'Design'),
    mk('markdown', 'Beta', '# Beta\nnothing special', 'Design'),
    mk('html', 'Gamma page', '<h1>Gamma</h1>', 'Design'),
    mk('svg', 'Delta flow', '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><circle cx="25" cy="25" r="20"/></svg>', 'Research'),
    mk('url', 'Epsilon link', 'http://localhost:5173'),
    mk('markdown', 'Zeta loose', '# Zeta\nunfiled doc'),
    done,
  );
  await atlas.say(chat.id, 'seed');
  await atlas.idle(chat.id, 30_000);
}

/** Resolves once the element has stopped scrolling (same scrollLeft over 10 frames): a scroll closes an open menu, so click after it. */
async function scrollSettled(el: Locator): Promise<void> {
  await el.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let last = n.scrollLeft;
        let still = 0;
        const tick = () => {
          still = n.scrollLeft === last ? still + 1 : 0;
          last = n.scrollLeft;
          if (still >= 10) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

test('library: folders with counts, tabs, tiles, search, empty state', async ({ atlas, page }) => {
  await seedLibrary(atlas);
  await page.goto(`${atlas.url}/#/library`);
  const nav = page.locator('nav.lib-folders');
  await expect(nav.locator('.nav-item', { hasText: /All artifacts/ })).toContainText('6');
  await expect(nav.locator('.nav-item', { hasText: /Unfiled/ })).toContainText('2');
  await expect(nav.locator('.nav-item', { hasText: /Design/ })).toContainText('3');
  await expect(nav.locator('.nav-item', { hasText: /Research/ })).toContainText('1');
  // tiles: at most 4, each a live render
  const tiles = page.locator('.lib-tile');
  await expect(tiles).toHaveCount(4);
  await expect(page.locator('.lib-tile').first().locator('iframe, img, .doc-md, .lib-pv-doc').first()).toBeVisible();
  // type tabs
  for (const t of ['All', 'Docs', 'Pages', 'Diagrams', 'Links']) await expect(page.getByRole('tab', { name: t, exact: true }).first()).toBeAttached();
  await page.getByRole('tab', { name: 'Diagrams', exact: true }).first().click();
  await expect(page.locator('.lib-row')).toHaveCount(1);
  await expect(page.locator('.lib-row')).toContainText('Delta flow');
  await page.getByRole('tab', { name: 'All', exact: true }).first().click();
  // folder
  await nav.locator('.nav-item', { hasText: /Design/ }).click();
  await expect(page.locator('.lib-row')).toHaveCount(3);
  // search by content
  const search = page.getByLabel('Search the Library').first();
  await search.fill('zebra');
  const res = page.locator('.list-group[aria-label=Results] .lib-row');
  await expect(res).toHaveCount(1);
  await expect(res).toContainText('Alpha spec');
  await expect(res.locator('.lib-snip')).toContainText('zebra');
  await expect(res.locator('.lib-fold')).toContainText('Design');
  await search.fill('qqqnothing');
  await expect(page.locator('.lib-empty')).toBeVisible();
  await search.fill('');
  await expect(page.locator('.lib-row').first()).toBeVisible();
});

test('library: pin on top, move to, folder rename + delete → Unfiled, new folder', async ({ atlas, page }) => {
  await seedLibrary(atlas);
  await page.goto(`${atlas.url}/#/library`);
  const nav = page.locator('nav.lib-folders');
  await nav.locator('.nav-item', { hasText: /Design/ }).click();
  // pin Alpha (oldest in Design) through the row menu
  const row = page.locator('.lib-row', { hasText: 'Alpha spec' });
  await row.getByRole('button', { name: /Actions for Alpha spec/ }).click();
  const pop = page.locator('.fixed-pop');
  await expect(pop.getByText('Open', { exact: true })).toBeVisible();
  await pop.getByText('Pin on top of its folder').click();
  await expect(page.locator('.list-group[aria-label=Pinned] .lib-row')).toContainText('Alpha spec');
  // move Beta to Research
  await page.locator('.lib-row', { hasText: 'Beta' }).getByRole('button', { name: /Actions for Beta/ }).click();
  await page.locator('.fixed-pop').getByRole('menuitemradio', { name: /Research/ }).click();
  await expect(nav.locator('.nav-item', { hasText: /Research/ })).toContainText('2');
  await expect(nav.locator('.nav-item', { hasText: /Design/ })).toContainText('2');
  // new folder
  await page.getByRole('button', { name: 'New folder' }).first().click();
  await page.getByLabel('Folder name').filter({ visible: true }).first().fill('Ideas');
  await page.getByLabel('Folder name').filter({ visible: true }).first().press('Enter');
  await expect(nav.locator('.nav-item', { hasText: /Ideas/ })).toContainText('0');
  // rename Research → Studies
  await nav.getByRole('button', { name: /Actions for Research/ }).click();
  await page.locator('.fixed-pop').getByText('Rename').click();
  await page.getByLabel('Folder name').filter({ visible: true }).first().fill('Studies');
  await page.getByLabel('Folder name').filter({ visible: true }).first().press('Enter');
  await expect(nav.locator('.nav-item', { hasText: /Studies/ })).toContainText('2');
  // delete Design → its 2 artifacts go to Unfiled
  page.on('dialog', (d) => void d.accept());
  await nav.getByRole('button', { name: /Actions for Design/ }).click();
  await page.locator('.fixed-pop').getByText(/Delete/).click();
  const confirm = page.getByRole('button', { name: /^Delete/ });
  if (await confirm.count()) await confirm.last().click();
  await expect(nav.locator('.nav-item', { hasText: /Unfiled/ })).toContainText('4');
  await expect(nav.locator('.nav-item', { hasText: /All artifacts/ })).toContainText('6');
  await expect(nav.locator('.nav-item', { hasText: /Design/ })).toHaveCount(0);
});

test('library viewer: ⋯ has Pin and Move to; ‹ Library goes back', async ({ atlas, page }) => {
  await seedLibrary(atlas);
  const docs = (await (await fetch(atlas.url + '/api/documents')).json()) as { id: string; title: string }[];
  const alpha = docs.find((d) => d.title === 'Alpha spec')!;
  await page.goto(`${atlas.url}/#/library/${alpha.id}`);
  const v = page.locator('.viewer.library');
  await expect(v.locator('.sd-head')).toHaveCount(1);
  await v.getByRole('button', { name: 'More' }).click();
  const pop = page.locator('.fixed-pop');
  await expect(pop.getByText('Pin on top of its folder')).toBeVisible();
  await expect(pop.getByText('Move to')).toBeVisible();
  await expect(pop.getByRole('menuitemradio')).toHaveCount(3); // Design, Research, Unfiled
  await pop.getByRole('menuitemradio', { name: /Research/ }).click();
  await expect.poll(async () => ((await (await fetch(atlas.url + '/api/documents/' + alpha.id)).json()) as { folderId: string | null }).folderId).not.toBeNull();
  await v.getByRole('link', { name: /Library/ }).click();
  await expect(page.locator('.lib-row').first()).toBeVisible();
});

/** Information text needs 4.5:1 in both themes (m94): computed colour vs the first opaque background behind it. */
const CONTRAST = `(sels) => {
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const mix = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0) { stack.push(c); if (c.a === 1) break; } } let bg = { r: 255, g: 255, b: 255, a: 1 }; for (const c of stack.reverse()) bg = mix(c, bg); return bg; };
  const out = [];
  for (const s of sels) for (const el of document.querySelectorAll(s)) {
    if (!el.offsetParent || !el.textContent.trim()) continue;
    const bg = bgOf(el); const fg = mix(parse(getComputedStyle(el).color), bg);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    out.push({ s, text: el.textContent.trim().slice(0, 30), ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100 });
  }
  return out;
}`;

for (const theme of ['dark', 'light']) {
  test(`contrast ≥ 4.5 in ${theme}: chat cards, old-version header, Library`, async ({ atlas, page }) => {
    const chat = await makeSpec(atlas);
    await seedLibrary(atlas);
    await page.goto(`${atlas.url}/?theme=${theme}#/chat/${chat.id}`);
    await page.locator('.artifact').nth(0).click();
    await expect(page.locator('.sd-ver-btn.old')).toBeVisible();
    const chatSels = ['.art-title', '.art-meta', '.art-upd', '.art-old', '.art-open', '.sd-ver-btn', '.sd-latest-btn', '.sd-tab-t'];
    const a = (await page.evaluate(`(${CONTRAST})(${JSON.stringify(chatSels)})`)) as { s: string; text: string; ratio: number }[];
    await page.goto(`${atlas.url}/?theme=${theme}#/library`);
    await expect(page.locator('.lib-tile').first()).toBeVisible();
    await page.getByLabel('Search the Library').first().fill('zebra');
    await expect(page.locator('.lib-snip')).toBeVisible();
    const libSels = ['.lib-t', '.lib-snip', '.lib-fold', '.lib-when', '.tab-n', '.nav-item', '.mem-chip', '.lg'];
    const b = (await page.evaluate(`(${CONTRAST})(${JSON.stringify(libSels)})`)) as typeof a;
    await page.getByLabel('Search the Library').first().fill('');
    await expect(page.locator('.lib-tile').first()).toBeVisible();
    const c = (await page.evaluate(`(${CONTRAST})(${JSON.stringify(['.lib-tile-t b', '.lib-tile-m', '.lib-tile-m span', '.lib-fold', '.lib-t', '.lib-when', '.lg', '.count', '.tabbtn'])})`)) as typeof a;
    const all = [...a, ...b, ...c];
    expect(all.length).toBeGreaterThan(15);
    if (process.env.SHOW) console.log(theme, JSON.stringify(all.map((x) => x.s + "=" + x.ratio).filter((v, i, ar) => ar.indexOf(v) === i)));
    const low = all.filter((x) => x.ratio < 4.5);
    expect(low, JSON.stringify(low)).toEqual([]);
  });
}

test('phone library: folders are chips, tiles swipe sideways, chip ⋯ renames and deletes', async ({ atlas, page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedLibrary(atlas);
  await page.goto(`${atlas.url}/#/library`);
  await expect(page.locator('nav.lib-folders')).toBeHidden();
  const chips = page.locator('.lib-chips');
  await expect(chips.getByRole('button', { name: /All artifacts\s*6/ })).toBeVisible();
  await expect(chips.getByRole('button', { name: /Design\s*3/ })).toBeVisible();
  // tiles are a horizontally scrolling row
  const tiles = page.locator('.lib-tiles');
  await expect(page.locator('.lib-tile')).toHaveCount(4);
  const sw = await tiles.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }));
  expect(sw.sw).toBeGreaterThan(sw.cw);
  expect(['auto', 'scroll']).toContain(sw.ox);
  // no horizontal page overflow
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // chip ⋯
  await chips.getByRole('button', { name: /Design\s*3/ }).click();
  await scrollSettled(chips);
  await chips.getByRole('button', { name: /Actions for Design/ }).scrollIntoViewIfNeeded(); // the ⋯ sits at the end of the row
  await scrollSettled(chips);
  await chips.getByRole('button', { name: /Actions for Design/ }).click();
  await page.locator('.fixed-pop').getByText('Rename').click();
  await page.getByLabel('Folder name').filter({ visible: true }).first().fill('Specs');
  await page.getByLabel('Folder name').filter({ visible: true }).first().press('Enter');
  await expect(chips.getByRole('button', { name: /Specs\s*3/ })).toBeVisible();
  await scrollSettled(chips);
  page.on('dialog', (d) => void d.accept());
  await chips.getByRole('button', { name: /Actions for Specs/ }).scrollIntoViewIfNeeded();
  await scrollSettled(chips);
  await chips.getByRole('button', { name: /Actions for Specs/ }).click();
  await page.locator('.fixed-pop').getByText(/Delete/).click();
  const confirm = page.getByRole('button', { name: /^Delete/ });
  if (await confirm.count()) await confirm.last().click();
  await expect(chips.getByRole('button', { name: /Unfiled\s*5/ })).toBeVisible();
});
