import { test, expect } from '../harness/fixtures.ts';
import type { ContentBlock } from '@atlas/shared';

/** #192: a document chip in a task's thread opens the document in the task panel (#222), at the chip's version and section. */
const tu = (name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id: 't' + Math.random().toString(36).slice(2, 8), name, input }];
const filler = Array.from({ length: 6 }, (_, i) => `## ${i + 1}. Part ${i + 1}\n\n${'Some text. '.repeat(80)}`).join('\n\n');
const doc = (v: string) => `# Spec\n\n${v} body\n\n${filler}\n\n## 7. Open questions\n\nWhat is still open.`;

test('task panel: the chip and the Artifacts row open the document over the task; ‹ Task and Esc go back', async ({ atlas, page }) => {
  atlas.model.next(
    tu('artifact_create', { kind: 'markdown', title: 'Chip spec', content: doc('v1') }),
    tu('artifact_update', { artifact: 'docs/chip-spec.md', content: doc('v2'), section: '7. Open questions' }),
    tu('artifact_update', { artifact: 'docs/chip-spec.md', content: doc('v3') }),
    [{ type: 'text', text: 'Done.' }] as ContentBlock[],
  );
  const task = await atlas.task('Doc chip task');
  await atlas.idle(task.id, 30_000);
  await page.goto(`${atlas.url}/#/board?card=${task.id}`);
  const modal = page.locator('.thread-panel');
  await expect(modal).toBeVisible();
  const chips = modal.locator('button.artifact');
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(1)).toContainText('Open');

  // The v2 chip: its version, scrolled to its section, filling the panel.
  await chips.nth(1).click();
  const reader = modal.locator('.cm-reader');
  await expect(reader).toBeVisible();
  await expect(reader.locator('.sd-ver-btn')).toHaveText('v2 of 3');
  await expect(reader.getByText('v2 body')).toBeAttached();
  await expect(reader.getByRole('heading', { name: '7. Open questions' })).toBeInViewport();
  const m = (await modal.boundingBox())!;
  const r = (await reader.boundingBox())!;
  expect(r.height).toBeGreaterThan(m.height - 4);
  // ‹ Task: back to the task, the panel stays.
  await reader.getByRole('button', { name: '‹ Task' }).click();
  await expect(reader).toHaveCount(0);
  await expect(modal).toBeVisible();

  // The Artifacts row opens the same view at the latest version; Esc goes back to the task, a second Esc closes it.
  await modal.locator('.cm-doc').first().click();
  await expect(reader).toBeVisible();
  await expect(reader.locator('.sd-ver-btn')).toHaveText('v3');
  // A click in its text keeps Esc there too.
  await reader.getByText('v3 body').click();
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
});
