import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { runCardTool } from './cardTools.ts';
import { runTeamTool, type TeamToolContext } from './teamTools.ts';
import { runDocTool } from './docTools.ts';
import type { CloneRun, GhRun } from './projects.ts';
import { until } from '../test/kit/index.ts';

/** A clone that makes the folder with one file (no git, no network). */
const fakeClone: CloneRun = async (_repo, dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'hi');
};
const ready = (e: Engine, project: string, ...agents: string[]) =>
  until(() => agents.every((a) => e.projects.get(project).members.find((m) => m.agentId === a)?.cloneState === 'ready'), `${agents.join(', ')} ready in ${project}`);

const engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
});

async function setup(gh?: GhRun, fake = new FakeProvider([])) {
  const e = await startEngine({
    memoryReview: false,
    dbFile: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    dispatch: false,
    providers: () => fake,
    env: {},
    projects: { gh: gh ?? (async () => Promise.reject(new Error('no gh in this test'))), clone: fakeClone },
  });
  engines.push(e);
  for (const id of ['munih', 'zurich', 'dina']) e.agents.create({ id, rolePrompt: `${id} role`, modelId: 'sonnet' });
  return e;
}

/** Atlas (lead atlas, everyone) and Datinel (lead dina, members dina + zurich). */
async function twoProjects(gh?: GhRun) {
  const e = await setup(gh);
  const datinel = e.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
  return { e, datinel };
}

const api = async (e: Engine, method: string, path: string, body?: unknown) => {
  const r = await fetch(e.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: r.status === 204 ? null : ((await r.json()) as unknown) };
};

describe('projects (#213)', () => {
  it('starts with one project, Atlas, holding everything: nothing behaves differently', async () => {
    const e = await setup();
    const [atlas, ...rest] = e.projects.list();
    expect(rest).toEqual([]);
    expect(atlas).toMatchObject({ id: 'atlas', name: 'Atlas', repo: 'csoylu/atlas', status: 'active', isDefault: true });
    // New agents join it, in their own workdir, ready.
    expect(atlas!.members.map((m) => [m.agentId, m.workspace, m.cloneState])).toEqual(
      expect.arrayContaining([
        ['atlas', null, 'ready'],
        ['munih', null, 'ready'],
      ]),
    );
    const c = e.kanban.create({ title: 'x', assignee: 'munih', status: 'ready' }, 'user');
    expect(c.projectId).toBe('atlas');
    expect(e.kanban.newChat('munih').projectId).toBe('atlas');
    expect(e.workflows.createOneStep({ agentId: 'munih', prompt: 'p', kind: 'cron', cron: '0 9 * * *' }, 'user').projectId).toBe('atlas');
    expect(e.documents.createFolder('Feeds').projectId).toBe('atlas');
    // The triage agent setting is the Atlas lead.
    e.settings.update({ triageAgent: 'munih' });
    expect(e.projects.get('atlas').lead).toBe('munih');
    expect(e.settings.get().triageAgent).toBe('munih');
  });

  it('creates, edits and archives through the API; the repo is fixed once set', async () => {
    const e = await setup();
    const made = await api(e, 'POST', '/api/projects', { name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ id: 'datinel', lead: 'dina', colour: 145, isDefault: false });
    expect((made.body as { members: { agentId: string; cloneState: string }[] }).members.map((m) => [m.agentId, m.cloneState]).sort()).toEqual([
      ['dina', 'cloning'],
      ['zurich', 'cloning'],
    ]);
    await ready(e, 'datinel', 'dina', 'zurich');
    expect((await api(e, 'POST', '/api/projects', { name: 'datinel' })).status).toBe(409);
    expect((await api(e, 'POST', '/api/projects', { name: 'Other', repo: 'datinel/datinel' })).status).toBe(409);
    expect((await api(e, 'POST', '/api/projects', { name: 'Bad', repo: 'nope' })).status).toBe(400);
    const edited = await api(e, 'PATCH', '/api/projects/datinel', { name: 'Datinel v2', lead: 'zurich', members: ['zurich'], colour: 50 });
    expect(edited.body).toMatchObject({ name: 'Datinel v2', lead: 'zurich', colour: 50 });
    expect((edited.body as { members: unknown[] }).members).toHaveLength(1);
    expect(await api(e, 'PATCH', '/api/projects/datinel', { repo: 'datinel/other' })).toMatchObject({ status: 409, body: { error: expect.stringMatching(/fixed/) } });
    // A lead can't leave the project.
    expect((await api(e, 'PATCH', '/api/projects/datinel', { members: [] })).body).toMatchObject({ members: [{ agentId: 'zurich' }] });
    expect((await api(e, 'GET', '/api/projects')).body).toHaveLength(2);
    // Archive keeps everything, hides it unless asked; the last active one can't go.
    expect((await api(e, 'POST', '/api/projects/datinel/archive')).body).toMatchObject({ status: 'archived' });
    expect((await api(e, 'GET', '/api/projects')).body).toHaveLength(1);
    expect((await api(e, 'GET', '/api/projects?archived=1')).body).toHaveLength(2);
    expect(await api(e, 'POST', '/api/projects/atlas/archive')).toMatchObject({ status: 409, body: { error: expect.stringMatching(/last active project/) } });
    expect((await api(e, 'PATCH', '/api/projects/datinel', { name: 'x' })).status).toBe(409);
    expect((await api(e, 'POST', '/api/projects/datinel/restore')).body).toMatchObject({ status: 'active' });
  });

  it('checks a repo with gh: found, private, default branch, instructions', async () => {
    const calls: string[][] = [];
    const gh: GhRun = async (args) => {
      calls.push(args);
      if (args[1] === 'repos/datinel/datinel') return JSON.stringify({ private: true, default_branch: 'main' });
      if (args[1]!.startsWith('repos/datinel/datinel/contents/')) return JSON.stringify([{ name: 'CLAUDE.md', type: 'file' }, { name: 'src', type: 'dir' }]);
      throw new Error('gh: HTTP 404: Not Found');
    };
    const e = await setup(gh);
    expect((await api(e, 'GET', '/api/projects/repo-check?repo=datinel/datinel')).body).toEqual({
      repo: 'datinel/datinel',
      found: true,
      private: true,
      defaultBranch: 'main',
      instructions: ['CLAUDE.md'],
      error: null,
    });
    expect((await api(e, 'GET', '/api/projects/repo-check?repo=csoylu/nope')).body).toMatchObject({ found: false, error: 'gh: HTTP 404: Not Found' });
    expect((await api(e, 'GET', '/api/projects/repo-check?repo=bad')).status).toBe(400);
    expect(calls[1]).toEqual(['api', 'repos/datinel/datinel/contents/?ref=main']);
  });

  it('scopes every list route to a project, and hides archived projects unless asked', async () => {
    const { e, datinel } = await twoProjects();
    const a = e.kanban.create({ title: 'atlas task' }, 'user');
    const d = e.kanban.create({ title: 'datinel task', projectId: 'Datinel', assignee: 'dina' }, 'user');
    expect(d.projectId).toBe(datinel.id);
    // Task numbers stay global.
    expect([a.number, d.number]).toEqual([1, 2]);
    // A task's assignee must be a member of its project.
    expect(() => e.kanban.create({ title: 'x', projectId: 'datinel', assignee: 'munih' }, 'user')).toThrow(/@munih is not a member of project Datinel/);
    expect(() => e.kanban.update(d.id, { assignee: 'munih' }, 'user')).toThrow(/not a member/);
    // The project is fixed: update ignores it (not in UpdateCard).
    e.kanban.update(d.id, { projectId: 'atlas' } as never, 'user');
    expect(e.kanban.get(d.id).projectId).toBe('datinel');
    const chat = e.kanban.newChat('dina', 'datinel');
    e.workflows.createOneStep({ agentId: 'dina', prompt: 'p', kind: 'cron', cron: '0 9 * * *', projectId: 'datinel' }, 'user');
    e.workflows.createOneStep({ agentId: 'atlas', prompt: 'g', kind: 'cron', cron: '0 9 * * *', projectId: null }, 'user');
    e.documents.createFolder('Specs', 'datinel');
    e.documents.createFolder('Specs', 'atlas'); // names are unique per project only

    const titles = async (path: string) => ((await api(e, 'GET', path)).body as { title?: string; name?: string }[]).map((x) => x.title ?? x.name);
    expect(await titles('/api/cards?project=datinel')).toEqual(['datinel task']);
    expect(await titles('/api/cards?project=Atlas')).toEqual(['atlas task']);
    expect(await titles('/api/cards')).toEqual(['atlas task', 'datinel task']);
    expect((await api(e, 'GET', '/api/chats?project=datinel')).body).toMatchObject([{ id: chat.id, projectId: 'datinel' }]);
    expect((await api(e, 'GET', '/api/workflows?project=datinel')).body).toHaveLength(2); // its own + the global one
    expect((await api(e, 'GET', '/api/folders?project=datinel')).body).toMatchObject([{ name: 'Specs', projectId: 'datinel' }]);
    expect((await api(e, 'GET', '/api/cards?project=nope')).status).toBe(404);

    await api(e, 'POST', '/api/projects/datinel/archive');
    expect(await titles('/api/cards')).toEqual(['atlas task']);
    expect(await titles('/api/cards?archived=1')).toEqual(['atlas task', 'datinel task']);
    expect(await titles('/api/cards?project=datinel')).toEqual(['datinel task']);
    expect(await titles('/api/chats')).toEqual([]);
    expect(e.workflows.list().map((w) => w.projectId)).toEqual([null]);
    expect(e.workflows.list({ archived: true }).find((w) => w.projectId === 'datinel')?.enabled).toBe(false);
    // Read-only: nothing is deleted, every write is refused.
    expect(() => e.kanban.update(d.id, { title: 'y' }, 'user')).toThrow(/project Datinel is archived/);
    expect(await api(e, 'POST', `/api/cards/${chat.id}/messages`, { text: 'hi' })).toMatchObject({ status: 409 });
    expect(() => e.kanban.create({ title: 'z', projectId: 'datinel' }, 'user')).toThrow(/archived/);
    expect(() => e.documents.createFolder('More', 'datinel')).toThrow(/archived/);
    expect(() => e.workflows.update(e.workflows.list({ project: 'datinel', archived: true }).find((w) => w.projectId)!.id, { enabled: true })).toThrow(/archived/);
  });

  it('gives a project its new tasks to triage: the lead', async () => {
    const { e } = await twoProjects();
    const d = e.kanban.create({ title: 'raw idea', projectId: 'datinel' }, 'user');
    expect(d.status).toBe('triage');
    expect(e.kanban.leadOf(d.projectId)).toBe('dina');
    e.projects.update('datinel', { lead: null });
    expect(e.dispatcher.reason(e.kanban.get(d.id))).toMatch(/no triage agent set/);
  });

  it('scopes the agent tools to the run project; only a lead crosses', async () => {
    const { e } = await twoProjects();
    await ready(e, 'datinel', 'dina', 'zurich');
    const own = e.kanban.create({ title: 'zurich in datinel', projectId: 'datinel', assignee: 'zurich' }, 'user');
    const lead = e.kanban.create({ title: 'dina in datinel', projectId: 'datinel', assignee: 'dina' }, 'user');
    const atlasRun = e.kanban.create({ title: 'munih in atlas', assignee: 'munih' }, 'user');
    const zurich = { kanban: e.kanban, agentId: 'zurich', cardId: own.id };
    const dina = { kanban: e.kanban, agentId: 'dina', cardId: lead.id };
    const munih = { kanban: e.kanban, agentId: 'munih', cardId: atlasRun.id };

    expect(runCardTool('task_list', {}, zurich).output.split('\n')).toHaveLength(2);
    expect(runCardTool('task_list', {}, munih).output).toMatch(/munih in atlas/);
    expect(runCardTool('task_list', {}, munih).output).not.toMatch(/datinel/);
    // A task made by a run is in the run's project.
    expect(runCardTool('task_create', { title: 'follow-up', assignee: 'zurich' }, zurich).output).toMatch(/created #4/);
    expect(e.kanban.list({ project: 'datinel' }).map((c) => c.title)).toContain('follow-up');
    // Crossing: refused for a member, allowed for a lead (of either side).
    expect(runCardTool('task_list', { project: 'atlas' }, zurich)).toMatchObject({ isError: true, output: expect.stringMatching(/only a project's lead can act on another project/) });
    expect(runCardTool('task_show', { id: atlasRun.id }, zurich).isError).toBe(true);
    expect(runCardTool('task_update', { id: atlasRun.id, title: 'x' }, zurich).isError).toBe(true);
    expect(runCardTool('task_list', { project: 'atlas' }, dina).output).toMatch(/munih in atlas/);
    expect(runCardTool('task_create', { title: 'for atlas', project: 'Atlas' }, dina).output).toMatch(/created/);
    expect(e.kanban.list({ project: 'atlas' }).map((c) => c.title)).toContain('for atlas');

    // Messages: members of the same project; crossing is for a lead.
    const team = (c: { agentId: string; cardId: string }) => ({ ...c, kanban: e.kanban, memories: e.memories, workflows: e.workflows, deliver: () => {} }) as unknown as TeamToolContext;
    expect(runTeamTool('agent_message', { agent: 'munih', text: 'hi' }, team(zurich))).toMatchObject({ isError: true, output: expect.stringMatching(/@munih is not a member of project Datinel/) });
    expect(runTeamTool('task_message', { id: atlasRun.id, text: 'hi' }, team(zurich)).isError).toBe(true);
    expect(runTeamTool('task_message', { id: lead.id, text: 'hi' }, team(zurich)).isError).toBe(false);
    expect(runTeamTool('agent_message', { agent: 'munih', text: 'hi' }, team(dina)).isError).toBe(false);

    // Schedules: the run's project (and global ones).
    expect(runTeamTool('schedule_create', { prompt: 'nightly', cron: '0 3 * * *' }, team(zurich)).isError).toBe(false);
    expect(e.workflows.list({ project: 'datinel' }).map((w) => w.projectId)).toEqual(['datinel']);
    expect(runTeamTool('schedule_list', {}, team(munih)).output).toBe('(no schedules)');
    expect(runTeamTool('schedule_list', { project: 'datinel' }, team(munih)).isError).toBe(true);

    // Artifacts: made in the run's project; another project's are out of reach.
    const docs = (agentId: string, cardId: string) => ({ documents: e.documents, agentId, chatId: null, cardId, scope: (asked?: string) => e.kanban.scope(agentId, cardId, asked) });
    expect(runDocTool('artifact_create', { kind: 'markdown', title: 'Datinel spec', content: '# Datinel spec' }, docs('zurich', own.id)).isError).toBe(false);
    const spec = e.documents.library({ project: 'datinel' })[0]!;
    expect(spec).toMatchObject({ title: 'Datinel spec', projectId: 'datinel' });
    expect(runDocTool('artifact_list', {}, docs('munih', atlasRun.id)).output).not.toMatch(/Datinel spec/);
    expect(runDocTool('artifact_list', {}, docs('zurich', own.id)).output).toMatch(/Datinel spec/);
    expect(runDocTool('artifact_read', { artifact: spec.id }, docs('munih', atlasRun.id)).isError).toBe(true);
    expect(runDocTool('artifact_list', { project: 'datinel' }, docs('atlas', e.kanban.create({ title: 'lead run', assignee: 'atlas' }, 'user').id)).output).toMatch(/Datinel spec/);
  });

  it("puts the run's project, its lead and its members in the system prompt", async () => {
    const fake = new FakeProvider([[{ type: 'text', text: 'ok' }]]);
    const e2 = await setup(undefined, fake);
    e2.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    await ready(e2, 'datinel', 'zurich');
    const c = e2.kanban.create({ title: 'work', projectId: 'datinel', assignee: 'zurich', status: 'done' }, 'user');
    e2.kanban.appendMessage(c.id, 'user', 'user', [{ type: 'text', text: 'go' }]);
    e2.runner.wake(c.id);
    await e2.runner.settled(c.id);
    const system = fake.calls[0]!.system;
    expect(system).toContain('Project: Datinel (github.com/datinel/datinel), led by dina.');
    expect(system).toContain('# Team (project Datinel)');
    expect(system).toMatch(/- dina \(lead\): dina role/);
    expect(system).toMatch(/- zurich \(you\): zurich role/);
    expect(system).not.toMatch(/- munih/);
  });
});

describe('branchOf (#217: the branch shown per member)', () => {
  it('reads the branch from .git/HEAD; null without a clone or on a detached head', async () => {
    const { branchOf } = await import('./projects.ts');
    const dir = mkdtempSync(join(tmpdir(), 'branch-'));
    expect(branchOf(null)).toBeNull();
    expect(branchOf(dir)).toBeNull();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/217-projects-ui\n');
    expect(branchOf(dir)).toBe('feat/217-projects-ui');
    writeFileSync(join(dir, '.git', 'HEAD'), '4b825dc642cb6eb9a060e54bf8d69288fbee4904\n');
    expect(branchOf(dir)).toBeNull();
  });
});
