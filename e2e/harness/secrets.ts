import { test as base, expect, type Page } from '@playwright/test';
import { Leaks } from './leaks.ts';
import type { Card, ContentBlock } from '@atlas/shared';
import { TestAtlas } from './engine.ts';
import type { SecretStore } from '../../packages/engine/src/secrets.ts';
import type { Reply } from './scripted.ts';
import { say, tu } from './audit.ts';

export { say, tu };

/** The desktop keychain's stand-in: an in-memory store (the value is « in the store » and nowhere else). */
export class MemStore implements SecretStore {
  label = 'test keychain';
  map = new Map<string, string>();
  names = () => [...this.map.keys()];
  get = (n: string) => this.map.get(n);
  set = (n: string, v: string) => void this.map.set(n, v);
  delete = (n: string) => void this.map.delete(n);
}

export const sh = (command: string, background = false): ContentBlock[] => tu('shell', background ? { command, background } : { command });

/** A task for `agent` whose run ends in a question (the scripted `final` text) once the scripted tool calls are done. */
export async function runTask(atlas: TestAtlas, title: string, agent: string, ...turns: Reply[]): Promise<Card> {
  atlas.model.next(...turns, say('Done: waiting for you.'));
  const task = await atlas.task(title, agent);
  await settle(atlas, task.id);
  return task;
}
/** The run ended and the task waits for the user. */
export async function settle(atlas: TestAtlas, id: string): Promise<void> {
  await expect.poll(async () => (await atlas.card(id)).status, { timeout: 20_000 }).toBe('blocked');
  await atlas.idle(id);
}

/** Indexed like an array that is long enough (a missing result then fails on the string, not on the index). */
type Results = [string, string, string, string, string, string, ...string[]];
/** Every tool result the model got in its last request (the whole conversation of that task), as text, oldest first. */
export function toolResults(atlas: TestAtlas): Results {
  const req = atlas.model.lastMain.req;
  return req.messages.flatMap((m) => m.content).flatMap((b) => (b.type === 'tool_result' ? [typeof b.content === 'string' ? b.content : JSON.stringify(b.content)] : [])) as Results;
}

/** Settings → Secrets, as Master adds one. */
export async function addSecret(page: Page, s: { name: string; value: string; description?: string; agents?: string[]; all?: boolean }): Promise<void> {
  await page.getByRole('button', { name: '+ Add a secret' }).click();
  const form = page.locator('[data-secret-form=add]');
  await form.getByPlaceholder('DUNE_API_KEY').fill(s.name);
  if (s.description) await form.getByPlaceholder('What it opens, and for what').fill(s.description);
  await form.locator('input[type=password]').fill(s.value);
  if (s.all) await form.getByRole('radio', { name: 'All agents' }).click();
  else if (s.agents) {
    await form.getByRole('radio', { name: 'Selected agents' }).click();
    for (const a of s.agents) await form.locator('.sec-pick label', { hasText: a }).click();
  }
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator(`[data-secret=${s.name}]`)).toBeVisible();
}

/** The task's chat (ticket modal on the board) with the Nth shell step opened: its terminal. */
export async function openStep(page: Page, atlas: TestAtlas, task: Card, command: string) {
  await page.goto(`${atlas.url}/#/board?card=${task.id}`);
  const row = page.locator('.step', { hasText: command }).first();
  await row.click();
  return page.locator('.fv-term').filter({ hasText: command }).first();
}

export interface World {
  atlas: TestAtlas;
  store: MemStore;
  leaks: Leaks;
}
/**
 * `w`: a desktop-mode Atlas (in-memory keychain stand-in, no model keys in its environment), a second agent « zurich »
 * and a leak audit that watches it. After every passing test the audit runs: values the test registered with
 * `leaks.watch` must be nowhere but in the store (files, logs, API, events, model requests: harness/leaks.ts).
 */
export const test = base.extend<{ w: World }>({
  w: async ({ page }, use, info) => {
    const store = new MemStore();
    const atlas = await TestAtlas.start({ secrets: store, env: {} });
    atlas.engine.agents.create({ id: 'zurich', modelId: atlas.engine.agents.get('atlas').modelId });
    const leaks = new Leaks();
    leaks.attach(atlas, page);
    await use({ atlas, store, leaks });
    const found = info.status === 'passed' ? await leaks.findings(atlas) : [];
    leaks.detach();
    await atlas.stop();
    expect(found, 'a secret value leaked out of the store').toEqual([]);
  },
});
