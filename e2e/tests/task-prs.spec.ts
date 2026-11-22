import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import type { ContentBlock } from '@atlas/shared';
import { TestAtlas } from '../harness/engine.ts';
import type { GhPr } from '../../packages/engine/src/prs.ts';

/**
 * #189 on the board: a task linked to its PR goes In review (not « Needs you »), shows « PR #41 », its reviewer's
 * run starts when CI is green, a failed validation sends it back to Ready with the reason, a merge moves it to Done.
 * A fake GitHub reader (no gh, no network). Screenshots in shots/task-prs (gitignored).
 */
const SHOTS = join(import.meta.dirname, '..', 'shots', 'task-prs');
mkdirSync(SHOTS, { recursive: true });
const URL = 'https://github.com/csoylu/atlas/pull/41';
const use = (name: string, input: unknown): ContentBlock[] => [{ type: 'tool_use', id: 't' + Math.random().toString(36).slice(2, 8), name, input }];

test('board flow: In review with its PR, failed → Ready with the reason, merged → Done', async ({ page }) => {
  const gh: { pr: GhPr } = { pr: { state: 'open', mergeSha: null, headSha: 'aaaaaaa1111', branch: 'feat/170-x', base: 'main', mergeable: true, ci: 'pending', qa: null, qaDescription: null } };
  const atlas = await TestAtlas.start({ prs: { read: async () => ({ ...gh.pr }), intervalMs: false } });
  try {
    atlas.engine.agents.create({ id: 'zurich', modelId: atlas.engine.agents.get('atlas').modelId });
    atlas.model.next(use('task_request_review', { summary: 'engine + tests', prs: [URL] }));
    const task = await atlas.task('Workflows engine');
    await expect.poll(async () => (await atlas.card(task.id)).status).toBe('review');
    await atlas.engine.prs.poll();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${atlas.url}/#/board`);
    const tile = page.locator('article.card', { hasText: 'Workflows engine' });
    // #266: one pill per PR with its worst state; the reviewer's name is in the note and the task view.
    await expect(tile.locator('.pr-pill')).toHaveText('PR #41 · CI running');
    await expect(tile.locator('.pr-pill')).toHaveAttribute('href', URL);
    await expect(tile).toContainText('QA starts when CI is green');
    await expect(page.getByText(/^Needs you/).first()).toHaveText('Needs you'); // no count: in review is not for you
    await page.screenshot({ path: join(SHOTS, 'review-1440.png') });

    // CI green → zurich's run starts in this task's thread; it ends without merging (validation failed on GitHub).
    atlas.model.next([{ type: 'text', text: 'Tests red on the restart test: failing it.' }]);
    gh.pr = { ...gh.pr, ci: 'success' };
    await atlas.engine.prs.poll();
    await expect.poll(() => atlas.engine.runner.runs(task.id).some((r) => r.agentId === 'zurich')).toBe(true);
    await atlas.idle(task.id);
    gh.pr = { ...gh.pr, qa: 'failure', qaDescription: 'zurich: restart test red' };
    await atlas.engine.prs.poll();
    // Back to Ready for atlas (the dispatcher then starts it again: the scripted builder just answers).
    await expect.poll(() => atlas.engine.db.prepare("SELECT payload FROM card_events WHERE card_id = ? AND kind = 'status' ORDER BY id DESC").all(task.id).map((r) => JSON.parse((r as { payload: string }).payload).to)).toContain('ready');
    await expect(page.locator('article.card', { hasText: 'Workflows engine' }).locator('.pr-pill')).toHaveText('PR #41 · QA failed'); // back in Ready: the pill says why
    await page.goto(`${atlas.url}/#/board?card=${task.id}`);
    await expect(page.getByText('PR #41: Validation failed (@zurich): zurich: restart test red', { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'failed-1440.png') });

    // The builder fixes and hands it back; the merge moves it to Done by itself.
    await atlas.idle(task.id);
    atlas.engine.kanban.requestReview(task.id, [URL], 'atlas', 'fixed');
    gh.pr = { ...gh.pr, headSha: 'bbbbbbb2222', qa: 'success', state: 'merged', mergeSha: 'e96a8e2ffff' };
    await atlas.engine.prs.poll();
    await expect.poll(async () => (await atlas.card(task.id)).status).toBe('done');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${atlas.url}/#/board?card=${task.id}`);
    await expect(page.locator('.thread-panel .cm-now .pr-pill')).toContainText('merged');
    await page.screenshot({ path: join(SHOTS, 'done-390.png') });
  } finally {
    await atlas.stop();
  }
});
