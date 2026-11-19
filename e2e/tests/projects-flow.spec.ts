import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import type { Card, Project } from '@atlas/shared';
import { TestAtlas } from '../harness/engine.ts';
import { Remotes, gateGh } from '../harness/projects.ts';
import { call, say, tu } from '../harness/audit.ts';
import type { GhPr } from '../../packages/engine/src/prs.ts';

/**
 * #218 — the Projects feature end to end (#213–#217), on a built UI, a scripted model and a local bare git repo as the
 * second project's GitHub: Settings → Projects (repo check, cloning, ready, a failed clone → try again / fix the repo
 * name), an agent already in Atlas added to it, its second chat in the sidebar, a task made on the board under the
 * project filter that runs in the new workspace, the PR flow on the second repo to Done (fake gh), the member removed,
 * the project archived. Screenshots in shots/projects-flow (gitignored).
 */
const SHOTS = join(import.meta.dirname, '..', 'shots', 'projects-flow');
mkdirSync(SHOTS, { recursive: true });
const PR = 'https://github.com/datinel/datinel/pull/7';
const SHA = 'c'.repeat(40);

/** Where an agent's clone of Datinel is, as the engine says (the layout is the engine's business). */
const wsOf = async (atlas: TestAtlas, agent: string) => (await member(atlas, 'datinel', agent))!.workspace!;
/** Any half-cloned folder anywhere in the data folder. */
const cloneLeftovers = (dataDir: string) => readdirSync(dataDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.cloning'));

interface World {
  atlas: TestAtlas;
  remotes: Remotes;
  gh: { pr: GhPr };
  gate: ReturnType<typeof gateGh>;
}

async function world(): Promise<World> {
  const remotes = new Remotes();
  const gh: { pr: GhPr } = { pr: { state: 'open', mergeSha: null, headSha: SHA, branch: 'feat/1-x', base: 'main', mergeable: true, ci: 'pending', qa: null, qaDescription: null } };
  const gate = gateGh('datinel/datinel', 7, SHA);
  const atlas = await TestAtlas.start({
    env: {},
    projects: remotes.options,
    prs: { read: async () => ({ ...gh.pr }), intervalMs: false, validate: { gh: gate.gh } },
  });
  for (const id of ['munih', 'zurich']) atlas.engine.agents.create({ id, rolePrompt: `${id} role`, modelId: atlas.engine.agents.get('atlas').modelId });
  atlas.engine.settings.update({ reviewAgent: 'zurich' });
  return { atlas, remotes, gh, gate };
}
const stop = async (w: World) => {
  await w.atlas.stop();
  w.remotes.cleanup();
};

const row = (page: Page, name: string) => page.locator('.pj-row', { hasText: name }).first();
const project = async (a: TestAtlas, id: string) => (await call<Project>(a, 'GET', `/projects/${id}`)).body;
const member = async (a: TestAtlas, id: string, agent: string) => (await project(a, id)).members.find((m) => m.agentId === agent);

/** Settings → Projects → New project, as Master fills it (the live repo check passes before Create is enabled). */
async function createInUi(page: Page, w: World, f: { name: string; repo: string; lead: string; members?: string[] }) {
  await page.goto(`${w.atlas.url}/#/settings/projects`);
  await page.getByRole('button', { name: '+ New project' }).click();
  const form = page.getByRole('form', { name: 'New project' });
  await form.getByLabel('Name').fill(f.name);
  await form.getByLabel('GitHub repo').fill(f.repo);
  await form.locator('label.field', { hasText: 'Lead' }).locator('select').selectOption(f.lead);
  for (const m of f.members ?? []) await form.locator('.sec-pick label', { hasText: m }).click();
  return form;
}

test('create Datinel from a repo: check, cloning, ready; then an agent of Atlas joins, its second chat, a task, the PR flow to Done, remove, archive', async ({ page }) => {
  const w = await world();
  const { atlas, remotes } = w;
  try {
    remotes.repo('datinel/datinel', { 'README.md': 'datinel\n', 'CLAUDE.md': 'DATINEL-RULES: pnpm test before every push.\n', 'src/index.ts': 'export {};\n' });
    await page.setViewportSize({ width: 1440, height: 900 });

    // 1. One project: the app looks as before (no project groups in the sidebar, no tags).
    await page.goto(`${atlas.url}/#/settings/projects`);
    await expect(page.locator('.pj-note')).toContainText('Atlas made this project');
    await expect(page.locator('.side-group')).toHaveText(['Agents']);

    // 2. New project: the repo check runs while typing, Create waits for it. Clones are held open to see « cloning ».
    remotes.hold();
    const form = await createInUi(page, w, { name: 'Datinel', repo: 'datinel/datinel', lead: 'munih' });
    await expect(form).toContainText(/found/i);
    await page.screenshot({ path: join(SHOTS, '1-new-project.png') });
    await form.getByRole('button', { name: 'Create project' }).click();
    const r = row(page, 'Datinel');
    await expect(r.locator('.st-chip')).toContainText('Cloning · 0 of 1 ready');
    await expect.poll(async () => (await member(atlas, 'datinel', 'munih'))?.cloneState).toBe('cloning');
    await page.screenshot({ path: join(SHOTS, '2-cloning.png') });
    // Nothing to open yet: the sidebar keeps its single group until a member has a workspace there.
    remotes.release();
    await expect.poll(async () => (await member(atlas, 'datinel', 'munih'))?.cloneState).toBe('ready');
    await expect(r.locator('.st-chip')).toHaveCount(0);
    const m = (await member(atlas, 'datinel', 'munih'))!;
    expect(m.workspace).toMatch(/datinel/);
    expect(m.workspace).not.toBe(join(atlas.dataDir, 'workspaces', 'munih')); // never the agent's own folder
    expect(readFileSync(join(m.workspace!, 'README.md'), 'utf8')).toBe('datinel\n');
    expect(existsSync(`${m.workspace}.cloning`)).toBe(false);
    expect(m.branch).toBe('main');
    // The agent's workspace in Atlas is untouched: its own folder, no Datinel files.
    expect(existsSync(join(atlas.dataDir, 'workspaces', 'munih', 'README.md'))).toBe(false);

    // 3. Two projects: one agent group per project in the sidebar; munih's chat in Datinel is a second one.
    await expect(page.locator('.side-group')).toHaveText(['Atlas', 'Datinel']);
    const datinelGroup = page.locator('section.side-agents[aria-label=Datinel]');
    await expect(datinelGroup.locator('.agent-item')).toHaveText(['munih']);

    // 4. Add an agent that is already in Atlas (zurich): its clone, then its chat appears in the Datinel group.
    await page.goto(`${atlas.url}/#/settings/projects/datinel`);
    await page.getByRole('button', { name: '+ Add a member' }).click();
    await page.getByLabel('Add a member').selectOption('zurich');
    await page.getByRole('button', { name: 'Add zurich' }).click();
    await expect.poll(async () => (await member(atlas, 'datinel', 'zurich'))?.cloneState).toBe('ready');
    await expect(datinelGroup.locator('.agent-item')).toHaveText(['munih', 'zurich']);
    await page.screenshot({ path: join(SHOTS, '3-members.png') });
    // zurich's chat in Atlas (as the user opens it), then its second one in Datinel.
    await page.locator('section.side-agents[aria-label=Atlas] .agent-item', { hasText: 'zurich' }).click();
    await expect(page.getByPlaceholder(/Message @zurich/)).toBeVisible();
    const atlasChat = { body: { id: (await project(atlas, 'atlas')).members.find((x) => x.agentId === 'zurich')!.mainChat! } };
    expect(atlasChat.body.id).toBeTruthy();
    atlas.model.next(say('Hello from Datinel.'));
    await datinelGroup.locator('.agent-item', { hasText: 'zurich' }).click();
    await expect(page.locator('.proj-crumb')).toContainText('Datinel'); // its chat in Datinel, not the Atlas one still on screen
    await expect(page.getByPlaceholder(/Message @zurich/)).toBeVisible();
    await page.getByPlaceholder(/Message @zurich/).fill('where am I?');
    await page.keyboard.press('Enter');
    await expect(page.getByText('Hello from Datinel.')).toBeVisible();
    const dChat = (await project(atlas, 'datinel')).members.find((x) => x.agentId === 'zurich')!.mainChat!;
    expect(dChat).toBeTruthy();
    expect(dChat).not.toBe(atlasChat.body.id);
    expect((await call<Card>(atlas, 'GET', `/cards/${dChat}`)).body.projectId).toBe('datinel');
    expect((await call<Card>(atlas, 'GET', `/cards/${atlasChat.body.id}`)).body.projectId).toBe('atlas');
    // The turn was sent with Datinel's repo instructions and workspace, not Atlas's.
    const sys = atlas.model.lastMain.req.system;
    expect(sys).toContain('DATINEL-RULES');
    expect(sys).toContain(await wsOf(atlas, 'zurich'));
    await page.screenshot({ path: join(SHOTS, '4-second-chat.png') });

    // 5. A task made on the board with the filter on Datinel: it gets the project, only members can take it, it runs in the clone.
    await page.goto(`${atlas.url}/#/board`);
    await page.locator('.proj-btn').click();
    await page.locator('.proj-menu').getByText('Datinel', { exact: false }).first().click();
    await expect(page.locator('.proj-btn')).toContainText('Datinel');
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'New task' });
    await expect(dlg.getByLabel('Project')).toHaveValue('datinel');
    await expect(dlg.getByLabel('Agent').locator('option')).toHaveText(['Unassigned', '@munih', '@zurich']); // atlas is no member there
    await dlg.getByLabel('Title').fill('Datinel: add the health route');
    await dlg.getByLabel('Status').selectOption('ready');
    await dlg.getByLabel('Agent').selectOption('munih');
    atlas.model.next(tu('shell', { command: 'pwd && cat CLAUDE.md && ls' }), tu('task_request_review', { summary: 'health route', prs: [PR] }));
    await dlg.getByRole('button', { name: /Create task/ }).click();
    await expect.poll(async () => (await call<Card[]>(atlas, 'GET', '/cards?project=datinel')).body.find((c) => c.title.startsWith('Datinel:'))?.status).toBe('review');
    const task = (await call<Card[]>(atlas, 'GET', '/cards?project=datinel')).body.find((c) => c.title.startsWith('Datinel:'))!;
    expect(task.projectId).toBe('datinel');
    const out = atlas.model.lastMain.req.messages.flatMap((x) => x.content).flatMap((b) => (b.type === 'tool_result' ? [String(b.content)] : [])).join('\n');
    expect(out).toContain(await wsOf(atlas, 'munih'));
    expect(out).toContain('DATINEL-RULES');
    expect(out).toContain('src');
    expect((await call<Card[]>(atlas, 'GET', '/cards?project=atlas')).body.some((c) => c.id === task.id)).toBe(false);
    await page.screenshot({ path: join(SHOTS, '5-task-in-review.png') });

    // 6. The PR flow on datinel/datinel with a fake GitHub: CI green → zurich (a member) reviews and merges → Done.
    atlas.model.next(tu('pr_validate', { pr: 7, verdict: 'ok', sha: SHA, reason: 'read the diff, build green' }), say('Validated and merged.'));
    w.gh.pr = { ...w.gh.pr, ci: 'success' };
    await atlas.engine.prs.poll();
    await expect.poll(() => w.gate.merges().length).toBe(1);
    expect(w.gate.merges()[0]![1]).toBe('repos/datinel/datinel/pulls/7/merge');
    await atlas.idle(task.id);
    w.gh.pr = { ...w.gh.pr, qa: 'success', state: 'merged', mergeSha: 'b'.repeat(40) };
    await atlas.engine.prs.poll();
    await expect.poll(async () => (await atlas.card(task.id)).status).toBe('done');
    expect((await atlas.card(task.id)).prs[0]).toMatchObject({ repo: 'datinel/datinel', number: 7 });
    await page.goto(`${atlas.url}/#/board?card=${task.id}`);
    await expect(page.locator('.prc-row')).toContainText('merged');
    await page.screenshot({ path: join(SHOTS, '6-done.png') });

    // 7. Remove zurich from Datinel: its chat there is archived, its clone is kept, Atlas is untouched.
    await page.goto(`${atlas.url}/#/settings/projects/datinel`);
    const zr = page.locator('.pj-mem', { hasText: 'zurich' });
    await zr.getByRole('button', { name: 'Remove' }).click();
    await expect(zr).toContainText('Remove zurich from Datinel?');
    await page.screenshot({ path: join(SHOTS, '7-remove.png') });
    await zr.getByRole('button', { name: 'Remove zurich' }).click();
    await expect.poll(async () => (await project(atlas, 'datinel')).members.map((x) => x.agentId)).toEqual(['munih']);
    await expect(page.locator('.pj-mem').filter({ hasText: 'munih' }).getByRole('button', { name: 'Remove' })).toBeVisible();
    await expect(page.locator('.pj-mem').filter({ hasText: 'zurich' }).getByRole('button', { name: 'Delete…' })).toBeVisible(); // kept, not a member
    await expect(page.getByText('Workspaces of removed members')).toBeVisible();
    const kept = (await project(atlas, 'datinel')).kept;
    expect(kept.map((k) => k.agentId)).toEqual(['zurich']);
    expect(existsSync(join(kept[0]!.path, 'README.md'))).toBe(true); // the clone stays on disk
    expect((await call<Card>(atlas, 'GET', `/cards/${dChat}`)).body.status).toBe('archived');
    expect((await call<Card>(atlas, 'GET', `/cards/${atlasChat.body.id}`)).body.status).not.toBe('archived');
    expect((await project(atlas, 'atlas')).members.map((x) => x.agentId)).toContain('zurich');
    await expect(datinelGroup.locator('.agent-item')).toHaveText(['munih']);

    // 8. Archive Datinel: read-only, hidden, nothing deleted; the app is back to one project's look.
    await page.getByRole('button', { name: 'Archive…' }).click();
    await page.screenshot({ path: join(SHOTS, '8-archive.png') });
    await page.getByRole('button', { name: 'Archive Datinel' }).click();
    await expect.poll(async () => (await project(atlas, 'datinel')).status).toBe('archived');
    await expect(page.getByRole('heading', { name: 'Archived' })).toBeVisible();
    const r2 = await call(atlas, 'POST', '/cards', { title: 'late', status: 'todo', projectId: 'datinel' });
    expect(r2.status).toBe(409);
    expect(r2.body.error ?? JSON.stringify(r2.body)).toMatch(/archived/);
    expect((await call<Card[]>(atlas, 'GET', '/cards')).body.some((c) => c.id === task.id)).toBe(false); // hidden unless asked
    expect((await call<Card[]>(atlas, 'GET', '/cards?archived=1')).body.some((c) => c.id === task.id)).toBe(true);
    expect(existsSync(join(await wsOf(atlas, 'munih'), 'README.md'))).toBe(true);
    await page.screenshot({ path: join(SHOTS, '9-archived.png') });
  } finally {
    await stop(w);
  }
});

test('a clone that fails says why and waits; a run there fails loudly; Try again clones it once the repo can be reached', async ({ page }) => {
  const w = await world();
  const { atlas, remotes } = w;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    // The check sees the repo (GitHub knows it) but the clone can't read it yet (access, network, not pushed): the check passes, the clone fails.
    remotes.announced.add('datinel/datinel');
    const form = await createInUi(page, w, { name: 'Datinel', repo: 'datinel/datinel', lead: 'munih', members: ['zurich'] });
    await form.getByRole('button', { name: 'Create project' }).click();
    const r = row(page, 'Datinel');
    await expect(r.locator('.badge.bad')).toHaveText('Clone failed');
    await expect(r.getByRole('alert')).toContainText("Can't reach datinel/datinel");
    await expect(r.getByRole('button', { name: 'Fix the repo name' })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'failed-1-clone-failed.png') });
    const m = (await member(atlas, 'datinel', 'munih'))!;
    expect(m.cloneState).toBe('failed');
    expect(m.cloneError).toMatch(/datinel\/datinel/);
    expect(m.workspace === null || !existsSync(m.workspace)).toBe(true);
    expect(cloneLeftovers(atlas.dataDir)).toEqual([]); // never a half folder
    // Nothing to open there yet: the sidebar shows no Datinel group.
    await expect(page.locator('.side-group')).toHaveText(['Atlas']);

    // A task there can't run, and says why on the card; it never runs in Atlas's folder.
    atlas.model.next(say('this must never be asked'));
    const task = (await call<Card>(atlas, 'POST', '/cards', { title: 'Datinel: first task', status: 'ready', assignee: 'munih', projectId: 'datinel' })).body;
    await expect.poll(() => atlas.engine.runner.runs(task.id)[0]?.status).toBe('failed');
    expect(atlas.engine.runner.runs(task.id)[0]!.error).toMatch(/could not be cloned/);
    expect(atlas.model.of('main')).toHaveLength(0);

    // The repo becomes reachable; Try again clones every failed member.
    remotes.repo('datinel/datinel', { 'README.md': 'datinel\n' });
    await r.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(async () => (await project(atlas, 'datinel')).members.map((x) => x.cloneState)).toEqual(['ready', 'ready']);
    await expect(r.getByRole('alert')).toHaveCount(0);
    await expect(r.locator('.badge.bad')).toHaveCount(0);
    expect(readFileSync(join(await wsOf(atlas, 'munih'), 'README.md'), 'utf8')).toBe('datinel\n');
    expect(readFileSync(join(await wsOf(atlas, 'zurich'), 'README.md'), 'utf8')).toBe('datinel\n');
    await expect(page.locator('.side-group')).toHaveText(['Atlas', 'Datinel']);
    await page.screenshot({ path: join(SHOTS, 'failed-2-retried.png') });
  } finally {
    await stop(w);
  }
});

test('a clone that fails on a mistyped repo: Fix the repo name, check, Save, and every failed member clones the right one', async ({ page }) => {
  const w = await world();
  const { atlas, remotes } = w;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    remotes.repo('datinel/datinel', { 'README.md': 'right repo\n' });
    remotes.announced.add('datinel/datinal'); // the check let the typo through (a repo that was renamed)
    const form = await createInUi(page, w, { name: 'Datinel', repo: 'datinel/datinal', lead: 'munih' });
    await form.getByRole('button', { name: 'Create project' }).click();
    const r = row(page, 'Datinel');
    await expect(r.getByRole('alert')).toContainText("Can't reach datinel/datinal");
    await r.getByRole('button', { name: 'Fix the repo name' }).click();
    await expect(page).toHaveURL(/#\/settings\/projects\/datinel\/repo$/);
    const repo = page.getByLabel('GitHub repo');
    await expect(repo).toBeFocused();
    await expect(repo).toBeEnabled();
    await repo.fill('datinel/datinelx');
    await expect(page.getByText(/not found|can't|no repo/i).first()).toBeVisible(); // the live check: no such repo
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await repo.fill('datinel/datinel');
    await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
    await page.screenshot({ path: join(SHOTS, 'fix-1-repo.png') });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(async () => (await member(atlas, 'datinel', 'munih'))?.cloneState).toBe('ready');
    expect((await project(atlas, 'datinel')).repo).toBe('datinel/datinel');
    expect(readFileSync(join(await wsOf(atlas, 'munih'), 'README.md'), 'utf8')).toBe('right repo\n');
    // Once a clone exists the repo is fixed: another repo is another project.
    await expect(repo).toBeDisabled();
    expect(remotes.cloned).toEqual(['datinel/datinal', 'datinel/datinel']);
  } finally {
    await stop(w);
  }
});
