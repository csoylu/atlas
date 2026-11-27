import { test, expect } from '../harness/fixtures.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Frame, Page } from '@playwright/test';
import type { ContentBlock } from '@atlas/shared';
import type { TestAtlas } from '../harness/engine.ts';

/**
 * #368: a text selection is quoted everywhere with #367's pill, note box and chips: a markdown document, its source,
 * an html page (inside its frame), a url showing a raw text file, a file in the Files editor, an expanded tool row.
 * Q quotes only in read-only text; in the editor, the composer and a page's input or contenteditable it types a q.
 * (The browser tab is the desktop's: e2e/tests/browser-electron.spec.ts.)
 */
const tu = (name: string, input: Record<string, unknown>): ContentBlock[] => [
  {
    type: 'tool_use',
    id: 't' + Math.random().toString(36).slice(2, 8),
    name,
    input,
  },
];

const PAGE = `<!doctype html><html><body><h1>Pricing page</h1><p id="lead">Plans start at nine euros a month.</p>
<input id="i" placeholder="type"><div id="ce" contenteditable="true" style="min-height:24px;border:1px solid #999">edit</div></body></html>`;

async function setup(atlas: TestAtlas) {
  const ws = join(atlas.dataDir, 'workspaces', 'atlas');
  mkdirSync(join(ws, 'notes'), { recursive: true });
  writeFileSync(join(ws, 'notes', 'run.log'), 'boot ok\nworker started on port 4100\nshutdown\n');
  writeFileSync(join(ws, 'notes', 'app.ts'), 'export const port = 4100;\nexport const host = "localhost";\n');
  const chat = await atlas.chat();
  atlas.model.next(
    tu('artifact_create', {
      kind: 'markdown',
      title: 'Rollout plan',
      content: '# Rollout plan\n\n## Steps\n\nShip the beta to ten users first.\n\nThen widen it.',
      folder: 'Design',
    }),
    tu('artifact_create', {
      kind: 'html',
      title: 'Pricing page',
      path: 'pages/pricing.html',
      content: PAGE,
    }),
    tu('artifact_create', {
      kind: 'url',
      title: 'Run log',
      content: '/api/files/atlas/notes/run.log',
    }),
    tu('read_file', { path: 'notes/run.log' }),
    [{ type: 'text', text: 'Done.' }],
  );
  await atlas.say(chat.id, 'make them');
  await atlas.idle(chat.id);
  return chat;
}

/** Select `text` inside the element matched by `sel` (in the page or a frame), as a mouse drag would, then let go. */
async function select(where: Page | Frame, sel: string, text: string) {
  await where.evaluate(
    ([s, t]) => {
      for (const root of document.querySelectorAll(s)) {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const i = n.textContent!.indexOf(t);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + t.length);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(r);
          n.parentElement!.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return;
        }
      }
      throw new Error(`no « ${t} » in ${s}`);
    },
    [sel, text] as const,
  );
}

const frameOf = async (page: Page, part: string) => {
  await expect.poll(() => page.frames().some((f) => f.url().includes(part))).toBe(true);
  const f = page.frames().find((x) => x.url().includes(part))!;
  await f.waitForFunction(() => !!(window as unknown as { __atlasPane?: unknown }).__atlasPane);
  return f;
};

async function addQuote(page: Page, note: string) {
  const box = page.locator('.qt-box');
  await expect(box).toBeVisible();
  if (note) await box.locator('textarea').fill(note);
  await box.getByRole('button', { name: /^Add/ }).click();
  await expect(box).toHaveCount(0);
}

test('a passage of a document, a page, a raw text file, a file and a tool row: chips numbered in order, sent as one message', async ({ atlas, page }) => {
  const chat = await setup(atlas);
  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  const panel = page.locator('aside.side-doc');
  const chips = page.locator('.cm-chips .cm-chip');

  // 1. The markdown document: the pill, then Quote.
  await page.locator('.artifact', { hasText: 'Rollout plan' }).first().click();
  await expect(panel.getByText('Ship the beta to ten users first.')).toBeVisible();
  await select(page, 'aside.side-doc [data-qpane="md"]', 'beta to ten users');
  await page.locator('.qt-pop').click();
  await addQuote(page, 'why ten?');
  await expect(chips).toHaveCount(1);

  // 2. The html page: the selection inside the frame shows the app's pill; Q pressed in the frame quotes it.
  await page.locator('.artifact', { hasText: 'Pricing page' }).first().click();
  const pricing = await frameOf(page, 'pages/pricing.html');
  await select(pricing, '#lead', 'nine euros');
  await expect(page.locator('.qt-pop')).toBeVisible();
  // The drag gave the frame the focus; Q there is the frame's key, sent to the app.
  await pricing.locator('#lead').hover();
  await page.mouse.down();
  await page.mouse.up();
  await select(pricing, '#lead', 'nine euros');
  await page.keyboard.press('q');
  await addQuote(page, 'too cheap');
  await expect(chips).toHaveCount(2);
  // Q in the page's input and contenteditable types a q and quotes nothing.
  await pricing.locator('#i').click();
  await pricing.locator('#i').press('q');
  await expect(pricing.locator('#i')).toHaveValue('q');
  await pricing.locator('#ce').click();
  await pricing.locator('#ce').press('End');
  await pricing.locator('#ce').press('q');
  await expect(pricing.locator('#ce')).toHaveText('editq');
  await expect(page.locator('.qt-box')).toHaveCount(0);

  // Jump back: chip 1 opens the document again and lights its passage.
  await chips.nth(0).click();
  await expect(panel.locator('[data-qpane="md"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (CSS as unknown as { highlights: Map<string, unknown> }).highlights.has('qt-flash'))).toBe(true);
  await page.keyboard.press('Escape');

  // 3. The url artifact showing a raw text file: its lines.
  await page.locator('.artifact', { hasText: 'Run log' }).first().click();
  const log = await frameOf(page, 'notes/run.log');
  await select(log, 'pre', 'worker started');
  await page.locator('.qt-pop').click();
  await addQuote(page, '');
  await expect(chips).toHaveCount(3);

  // 4. The expanded tool row (read_file's output).
  const row = page.locator('.step', { hasText: 'run.log' }).first();
  await row.locator('.chat-row-line').click();
  await expect(row.locator('[data-qtool]')).toContainText('port 4100');
  await select(page, '[data-qtool]', 'port 4100');
  await page.locator('.qt-pop').click();
  await addQuote(page, 'which port in prod?');
  await expect(chips).toHaveCount(4);

  // 5. A chat quote (the agent's « Done. »), then send: one message, numbered in the order added.
  await select(page, '[data-qseq]', 'Done');
  await page.locator('.qt-pop').click();
  await addQuote(page, '');
  await expect(chips).toHaveCount(5);
  const before = atlas.model.of('main').length;
  await page.getByPlaceholder('Message @atlas').fill('see these');
  await page.getByPlaceholder('Message @atlas').press('Enter');
  await expect.poll(() => atlas.model.of('main').length).toBeGreaterThan(before);
  await atlas.idle(chat.id);
  const sent = atlas.model.lastMain.text;
  const at = (s: string) => sent.indexOf(s);
  for (const s of ['[comment 1]', '[comment 2]', '[comment 3]', '[quote 4]', '[quote 5]']) expect(sent).toContain(s);
  expect(at('[comment 1]')).toBeLessThan(at('[comment 2]'));
  expect(at('[comment 2]')).toBeLessThan(at('[comment 3]'));
  expect(at('[comment 3]')).toBeLessThan(at('[quote 4]'));
  expect(at('[quote 4]')).toBeLessThan(at('[quote 5]'));
  // Each says where it is: the document's section and lines, the page's element, the file's lines, the tool call.
  expect(sent).toMatch(/beta to ten users/);
  expect(sent).toMatch(/in element [^\n"]*#lead/);
  expect(sent).toMatch(/notes\/run\.log[^\n]*line 2/);
  expect(sent).toMatch(/\[quote 4\][^\n]*read_file/);
  // One message: the last user turn carries every quote and the text.
  const last = atlas.model.lastMain.req.messages.at(-1)!;
  const said = JSON.stringify(last.content);
  expect(last.role).toBe('user');
  for (const x of ['[comment 1]', '[comment 3]', '[quote 5]', 'see these']) expect(said).toContain(x);
});

test('the Files editor: the pill quotes its lines; Q types a q there; Q in the composer types a q', async ({ atlas, page }) => {
  const chat = await setup(atlas);
  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  await fetch(`${atlas.url}/api/chats/${chat.id}/panel/file/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'notes/app.ts', line: null }),
  });
  const line = page.locator('[data-qpane="code"] .cm-line', {
    hasText: 'export const host',
  });
  await expect(line).toBeVisible();
  await line.click({ clickCount: 3 });
  await expect(page.locator('.qt-pop')).toBeVisible();
  // Q in the editor is a letter: typed over the selection, nothing quoted.
  await page.keyboard.press('q');
  await expect(page.locator('[data-qpane="code"] .cm-content')).toContainText('q');
  await expect(page.locator('.qt-box')).toHaveCount(0);
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Control+z');
  const first = page.locator('[data-qpane="code"] .cm-line', {
    hasText: 'export const port',
  });
  await first.click({ clickCount: 3 });
  await page.locator('.qt-pop').click();
  await addQuote(page, 'make it 4200');
  await expect(page.locator('.cm-chips .cm-chip')).toHaveCount(1);
  // The composer: q is a letter.
  const composer = page.getByPlaceholder('Message @atlas');
  await composer.click();
  await composer.press('q');
  await expect(composer).toHaveValue('q');
  await expect(page.locator('.qt-box')).toHaveCount(0);
  await composer.press('Enter');
  await expect.poll(() => atlas.model.lastMain.text).toMatch(/\[comment 1\][^\n]*notes\/app\.ts[^\n]*line 1/);
  expect(atlas.model.lastMain.text).toContain('make it 4200');
});
