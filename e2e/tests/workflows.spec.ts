import { mkdtempSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { test, expect } from '@playwright/test';
import { TestAtlas } from '../harness/engine.ts';
import { tu } from '../harness/audit.ts';

const migrations = join(import.meta.dirname, '..', '..', 'packages', 'engine', 'src', 'store', 'migrations');
const get = async (atlas: TestAtlas, path: string) => (await fetch(atlas.url + '/api' + path)).json();

/** Workflows (#171): the list, a new workflow built on the canvas, Run now, the run's task link; a migrated schedule. */
test('create a workflow, add and wire a step, Run now: the run finishes with its task links', async ({ page }) => {
  const atlas = await TestAtlas.start();
  try {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(atlas.url + '/#/workflows');
    await page.getByRole('button', { name: 'New workflow' }).click();
    await page.getByLabel('Name').fill('Ship it');
    await page.getByRole('radio', { name: /Only by hand/ }).click();
    await page.getByRole('button', { name: 'Create and open the canvas' }).click();

    // The canvas opens with its empty agent step selected.
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/workflows\/wf_/);
    const id = (await page.evaluate(() => location.hash)).split('/')[2]!;
    const side = page.getByRole('complementary', { name: 'Step' });
    await expect(side.getByText('Agent step')).toBeVisible();
    await side.getByLabel('Title').fill('Part one');
    await side.getByLabel('Agent').selectOption('atlas');
    await side.getByLabel('Prompt').fill('Do part one');

    // Add a second agent step; it is selected.
    await page.getByRole('button', { name: '+ Add step' }).click();
    await page.getByRole('menuitem', { name: /Agent step/ }).click();
    await side.getByLabel('Title').fill('Part two');
    await side.getByLabel('Agent').selectOption('atlas');
    await side.getByLabel('Prompt').fill('Do part two after {{previous.summary}}');

    // Wire: drag step1's « done » exit onto the new step.
    const from = page.locator('.wf-node[data-id="step1"] [data-exit="done"] .pd');
    const to = page.locator('.wf-node[data-id="step2"]');
    const a = (await from.boundingBox())!;
    const b = (await to.boundingBox())!;
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 40, b.y + 30, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.wf-edges path[data-edge="step1:done"]')).toHaveCount(1);
    await expect.poll(async () => (await get(atlas, `/workflows/${id}`)).edges, { timeout: 5_000 }).toContainEqual({ from: 'step1', exit: 'done', to: 'step2' });
    await expect(page.locator('.wf-saved')).toContainText('saved');
    const saved = await get(atlas, `/workflows/${id}`);
    expect(saved.nodes.find((n: any) => n.id === 'step2').config).toMatchObject({ title: 'Part two', agentId: 'atlas', prompt: 'Do part two after {{previous.summary}}' });

    // Run now: the two tasks run (scripted: each completes), the run ends Done, each step links its task.
    atlas.model.next(tu('task_complete', { summary: 'part one shipped' }), tu('task_complete', { summary: 'part two shipped' }));
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(new RegExp(`#/workflows/${id}/runs/wr_`));
    const runs = page.getByRole('complementary', { name: 'Runs' });
    await expect(runs.locator('.wf-runs button').first()).toContainText('Done', { timeout: 20_000 });
    const log = runs.locator('.wf-steps-log li');
    await expect(log).toHaveCount(3);
    await expect(log.nth(1)).toContainText('Part one');
    await expect(log.nth(2)).toContainText('Part two');
    await expect(log.nth(2)).toContainText('part two shipped');
    const link = log.nth(2).getByRole('button', { name: /^#\d+$/ });
    await expect(link).toBeVisible();
    // The path taken is green; the node shows Done with its task.
    await expect(page.locator('.wf-edges path[data-edge="step1:done"]')).toHaveClass(/taken/);
    await expect(page.locator('.wf-node[data-id="step2"] .wf-run')).toContainText('Done');
    // The task link opens the task.
    await link.click();
    await expect.poll(() => page.evaluate(() => location.hash)).toContain('card=');
    const run = (await get(atlas, `/workflows/${id}`)).lastRun;
    expect(run.state).toBe('done');
    expect(run.steps[2].summary).toContain('part two shipped');
    expect(errors).toEqual([]);
  } finally {
    await atlas.stop();
  }
});

test('a schedule migrated from before workflows shows on the list and runs', async ({ page }) => {
  // A data dir at migration 0043 with one schedule: the engine migrates it at start.
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-e2e-'));
  mkdirSync(join(dataDir, 'workspaces', 'atlas'), { recursive: true });
  const db = new Database(join(dataDir, 'atlas.db'));
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  db.pragma('foreign_keys = OFF');
  for (const f of readdirSync(migrations).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0044').sort()) {
    db.exec(readFileSync(join(migrations, f), 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, 'x');
  }
  db.prepare(
    `INSERT INTO schedules (id, agent_id, title, kind, cron, at, prompt, create_card, timezone, enabled, next_run_at, last_fired_at, last_card_id, chat_card_id, last_error, created_by, created_at, updated_at)
     VALUES ('sch_e2e', 'atlas', 'Morning summary', 'cron', '0 9 * * 1-5', NULL, 'Summarise the night', 1, 'Europe/Paris', 1, '2099-01-01T08:00:00.000Z', NULL, NULL, NULL, NULL, 'user', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')`,
  ).run();
  db.close();

  const atlas = await TestAtlas.start({ dataDir });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(atlas.url + '/#/schedules'); // old links land on Workflows
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/workflows');
    const row = page.locator('.wf-row').filter({ hasText: 'Morning summary' });
    await expect(row).toContainText('Weekdays at 09:00');
    await expect(row).toContainText('@atlas');
    await expect(page.locator('.crumb-sub')).toHaveText('2 on'); // with the built-in Memory cleanup
    atlas.model.next(tu('task_complete', { summary: 'night summarised' }));
    await row.getByRole('button', { name: 'Run now' }).click();
    // Run now opens the task it started, as it did for a schedule.
    await expect.poll(() => page.evaluate(() => location.hash)).toContain('card=');
    await page.keyboard.press('Escape');
    await expect(row.locator('.wfl-last .st')).toHaveText('Done', { timeout: 20_000 });
    await expect(row.locator('.wfl-strip i.done')).toHaveCount(1);
    await expect(row.getByRole('button', { name: /^→ #\d+$/ })).toBeVisible();
    const w = await get(atlas, '/workflows/sch_e2e');
    expect(w.lastRun).toMatchObject({ number: 1, state: 'done', trigger: 'manual' });

    // Its canvas: trigger → the one agent step; on a phone, the steps as a list.
    await row.locator('.wfl-name').click();
    await expect(page.locator('.wf-node[data-id="step1"]')).toContainText('Morning summary');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.wf-phone .wf-node')).toHaveCount(2);
    await expect(page.locator('.wf-phone .wf-node').nth(1)).toContainText(/done\s*→\s*ends the run/);
  } finally {
    await atlas.stop();
  }
});
