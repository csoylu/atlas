import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { TestAtlas } from '../harness/engine.ts';
import { Remotes } from '../harness/projects.ts';

/**
 * Workflows v2 stage 2 (#262): the « Deploy preview » workflow built on the canvas (Add step menu, Action panel with
 * Run a command, a step added from an exit), the approval banner for a workflow an agent made (on a phone too), and a
 * run of the approved command in a clean checkout of the project's repo (a local bare repo stands in for GitHub).
 */
const get = async (atlas: TestAtlas, path: string) => (await fetch(atlas.url + '/api' + path)).json();
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };

test('Deploy preview: built with Add step, approved from the banner, then a run of the command', async ({ page }) => {
  const remotes = new Remotes();
  const repo = remotes.repo('datinel/datinel', { README: 'datinel main\n' });
  const atlas = await TestAtlas.start({
    env: {},
    projects: remotes.options,
    workflowCommand: { clone: async (_r, dir) => void execFileSync('git', ['clone', '-q', repo, dir], { env: GIT_ENV }) },
  });
  try {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const e = atlas.engine;
    e.agents.create({ id: 'munih', modelId: e.agents.get('atlas').modelId });
    const project = e.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'atlas', members: ['munih'] });
    await expect.poll(() => e.projects.list().find((p) => p.id === project.id)?.members.map((m) => m.cloneState), { timeout: 20_000 }).toEqual(['ready', 'ready']);
    // An agent makes it (its command needs Master's OK): trigger by hand → Run a command.
    const w = e.workflows.create(
      {
        name: 'Deploy preview',
        projectId: project.id,
        nodes: [
          { id: 'trigger', kind: 'trigger', x: 40, y: 80, config: { kind: 'manual' } },
          { id: 'n1', kind: 'action', x: 320, y: 80, config: { do: 'command', title: 'Deploy the preview', command: 'cat README\necho "deployed $TASK_REF"', secrets: [], limitMin: 10 } },
        ],
        edges: [{ from: 'trigger', exit: 'start', to: 'n1' }],
      } as never,
      'munih',
    );

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(atlas.url + `/#/workflows/${w.id}`);
    const banner = page.locator('.wf-appr');
    await expect(banner).toContainText('Waiting for your approval');
    await expect(banner).toContainText('@munih made this workflow');
    await expect(banner).toContainText('echo "deployed $TASK_REF"');
    await expect(banner).toContainText('datinel/datinel');
    await expect(banner).toContainText('10 min');

    // Approve from a phone: the banner sits above the steps.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Approve' }).click();
    await expect(banner).toHaveCount(0);
    expect((await get(atlas, `/workflows/${w.id}`)).needsApproval).toBe(false);

    await page.setViewportSize({ width: 1440, height: 900 });

    // Add step from the header: the menu says each kind's exits; the step lands on the selected step's first free exit.
    await page.locator('.wf-node[data-id="n1"]').click();
    await page.getByRole('button', { name: /Add step/ }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /Action/ })).toContainText(/exit/i);
    await menu.getByRole('menuitem', { name: /Action/ }).click();
    const side = page.getByRole('complementary', { name: 'Step' });
    await side.getByRole('radio', { name: 'Notify Master' }).click();
    await side.getByLabel('Text').fill('Preview deployed');
    await expect.poll(async () => (await get(atlas, `/workflows/${w.id}`)).edges).toContainEqual(expect.objectContaining({ from: 'n1', exit: 'exit 0' }));
    // Drag from « other exit » to empty canvas: the same menu opens there, with a ghost step already wired.
    const dot = page.locator('.wf-node[data-id="n1"] [data-exit="other exit"] .pd');
    const box = (await dot.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + 220, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator('.wf-ghost')).toBeVisible();
    await page.getByRole('menu').getByRole('menuitem', { name: /Action/ }).click();
    await side.getByRole('radio', { name: 'Notify Master' }).click();
    await side.getByLabel('Text').fill('Preview failed');
    await expect.poll(async () => (await get(atlas, `/workflows/${w.id}`)).edges).toContainEqual(expect.objectContaining({ from: 'n1', exit: 'other exit' }));
    expect((await get(atlas, `/workflows/${w.id}`)).nodes).toHaveLength(4);

    // A run: the command runs in the clean checkout of main, exit 0, then the notification.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole('button', { name: 'Run now' }).click();
    await expect
      .poll(async () => (await get(atlas, `/workflows/${w.id}/runs`))[0]?.state, { timeout: 30_000 })
      .toBe('done');
    const runs = await get(atlas, `/workflows/${w.id}/runs`);
    const run = await get(atlas, `/workflow-runs/${runs[0].id}`);
    expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'n1')).toMatchObject({ state: 'done', exit: 'exit 0' });
    await page.getByRole('button', { name: /^Runs/ }).click();
    await expect(page.locator('.wf-node[data-id="n1"]')).toContainText('exit 0');
    expect(errors).toEqual([]);
  } finally {
    await atlas.stop();
  }
});
