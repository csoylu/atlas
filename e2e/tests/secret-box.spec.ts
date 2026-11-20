import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { Card } from '@atlas/shared';
import type { TestAtlas } from '../harness/engine.ts';
import { say, settle, sh, test, toolResults, tu } from '../harness/secrets.ts';

/**
 * The secret box in the chat (#297): a task blocks on « needs secret X », Master types the value where the question is
 * shown (the chat row, the task sheet's Now box, the Inbox) and saves; the task resumes with $X in its shell. The leak
 * audit (harness/leaks.ts) then checks the value is in the store and nowhere else: files, logs, API answers, events,
 * model requests. SHOTS=<dir> also saves screenshots of every state (empty, error, saved) at 1440 and 390, both themes.
 */

const SHOTS = process.env.SHOTS;
const json = { 'content-type': 'application/json' };

/** A task of the chat (its report lands there) that blocks on `name`. */
async function blockedTask(atlas: TestAtlas, chat: Card, name: string, description: string): Promise<Card> {
  atlas.model.next(tu('task_block', { kind: 'capability', question: `I need the ${description} to read the chain.`, secret: name, secret_description: description }));
  const r = await fetch(atlas.url + '/api/cards', { method: 'POST', headers: json, body: JSON.stringify({ title: `Read the chain (${name})`, status: 'todo', assignee: 'atlas' }) });
  const task = (await r.json()) as Card;
  atlas.engine.db.prepare('UPDATE cards SET origin_card = ? WHERE id = ?').run(chat.id, task.id);
  await fetch(atlas.url + `/api/cards/${task.id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'ready' }) });
  await settle(atlas, task.id);
  expect((await atlas.card(task.id)).status).toBe('blocked');
  return task;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name + '.png') });
}

test('Master types the secret in the chat: empty is refused in the box, Save resumes the task with $NAME, the value is nowhere else', async ({ page, w }) => {
  const { atlas, store, leaks } = w;
  const V = 'etherscan-box-canary-7788-qrs';
  leaks.watch('ETHERSCAN_KEY', V);
  const chat = await atlas.chat();
  const task = await blockedTask(atlas, chat, 'ETHERSCAN_KEY', 'Etherscan API key');

  await page.goto(`${atlas.url}/#/chat/${chat.id}`);
  const box = page.locator('.chat-secbox .secbox');
  await expect(box).toContainText('ETHERSCAN_KEY');
  await expect(box).toContainText('Etherscan API key');
  await expect(box.getByRole('link', { name: 'Settings → Secrets' })).toHaveAttribute('href', '#/settings/secrets');

  // Empty: a clear error in the box, nothing sent, nothing stored.
  await box.getByRole('button', { name: 'Save' }).click();
  await expect(box.locator('.secbox-err')).toHaveText(/Type or paste the value first: nothing was stored/);
  expect(store.names()).toEqual([]);

  // Masked, with Show / Hide.
  const input = box.getByLabel('Value of ETHERSCAN_KEY');
  await input.fill(V);
  await expect(input).toHaveAttribute('type', 'password');
  await box.getByRole('button', { name: 'Show the value' }).click();
  await expect(input).toHaveAttribute('type', 'text');
  await box.getByRole('button', { name: 'Hide the value' }).click();
  await expect(input).toHaveAttribute('type', 'password');

  atlas.model.next(sh('echo "token=$ETHERSCAN_KEY"; printenv ETHERSCAN_KEY | wc -c'), tu('task_complete', { summary: 'read it' }));
  await box.getByRole('button', { name: 'Save' }).click();
  const saved = page.locator('.chat-secbox .secbox.saved');
  await expect(saved).toContainText('Saved ETHERSCAN_KEY');
  await expect(page.getByLabel('Value of ETHERSCAN_KEY')).toHaveCount(0);
  await expect.poll(async () => (await atlas.card(task.id)).status, { timeout: 20_000 }).toBe('done');
  expect(store.get('ETHERSCAN_KEY')).toBe(V);
  const out = toolResults(atlas).at(-1)!;
  expect(out).toContain('token=[secret ETHERSCAN_KEY]');
  expect(out.trim().split('\n').at(-1)!.trim()).toBe(String(V.length + 1));
  expect(JSON.stringify(atlas.db('SELECT * FROM secrets'))).not.toContain(V);
  // Not a chat message: nothing in the chat's or the task's conversation holds it, and no message was posted by the box.
  expect(JSON.stringify(atlas.db('SELECT content FROM messages'))).not.toContain(V);
  await expect(page.locator('.msg.user')).toHaveCount(0);
});

test('the box in the task sheet and the Inbox; a value that is already there is refused in the box, nothing replaced', async ({ page, w }) => {
  const { atlas, store } = w;
  const chat = await atlas.chat();
  const task = await blockedTask(atlas, chat, 'DUNE_API_KEY', 'Dune Analytics API key');

  await page.goto(`${atlas.url}/#/board?card=${task.id}`);
  const now = page.locator('.cm-now .secbox');
  await expect(now).toContainText('DUNE_API_KEY');
  await expect(now).toContainText('Dune Analytics API key');

  await page.goto(`${atlas.url}/#/inbox/${task.id}`);
  const ibx = page.locator('.ibx-q .secbox');
  await expect(ibx).toContainText('DUNE_API_KEY');

  // Someone stored a value meanwhile (Settings → Secrets): the box never overwrites it, and says so.
  store.set('DUNE_API_KEY', 'kept-value-000111');
  await ibx.getByLabel('Value of DUNE_API_KEY').fill('replacement-value-222333');
  await ibx.getByRole('button', { name: 'Save' }).click();
  await expect(ibx.locator('.secbox-err')).toContainText('already has a value');
  expect(store.get('DUNE_API_KEY')).toBe('kept-value-000111');
  await expect(ibx.getByLabel('Value of DUNE_API_KEY')).toHaveValue(''); // the field never keeps a value
});

// Only with SHOTS=<dir> (the review's pictures); skipped before any engine starts.
(SHOTS ? test : test.skip)('screenshots: empty, error and saved, at 1440 and 390, dark and light', async ({ page, w }) => {
  test.setTimeout(180_000);
  const { atlas, leaks } = w;
  let n = 0;
  for (const theme of ['dark', 'light'] as const)
    for (const width of [1440, 390]) {
      n++;
      const name = `SHOT_KEY_${n}`;
      const V = `shot-canary-value-${n}-abcdef`;
      leaks.watch(name, V);
      const chat = await atlas.chat();
      const task = await blockedTask(atlas, chat, name, 'Etherscan API key, read-only, from etherscan.io/myapikey');
      const tag = `${theme}-${width}`;
      await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
      // The task sheet and the Inbox, empty.
      await page.goto(`${atlas.url}/?theme=${theme}#/board?card=${task.id}`);
      await expect(page.locator('.cm-now .secbox')).toBeVisible();
      await page.locator('.cm-now .secbox').scrollIntoViewIfNeeded();
      await shot(page, `task-empty-${tag}`);
      await page.goto(`${atlas.url}/?theme=${theme}#/inbox/${task.id}`);
      await expect(page.locator('.ibx-q .secbox')).toBeVisible();
      await shot(page, `inbox-empty-${tag}`);
      // The chat: empty, error, saved.
      await page.goto(`${atlas.url}/?theme=${theme}#/chat/${chat.id}`);
      const box = page.locator('.chat-secbox .secbox');
      await expect(box).toBeVisible();
      await box.scrollIntoViewIfNeeded();
      await shot(page, `chat-empty-${tag}`);
      await box.getByRole('button', { name: 'Save' }).click();
      await expect(box.locator('.secbox-err')).toBeVisible();
      await shot(page, `chat-error-${tag}`);
      atlas.model.next(say('Read it.'));
      await box.getByLabel(`Value of ${name}`).fill(V);
      await box.getByRole('button', { name: 'Save' }).click();
      await expect(page.locator('.chat-secbox .secbox.saved')).toBeVisible();
      await atlas.idle(task.id);
      await shot(page, `chat-saved-${tag}`);
    }
});
