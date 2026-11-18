import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, Project } from '@atlas/shared';
import { eventually, launch, until, type Launched } from '../test/kit/index.ts';
import { spawnClone, type CloneRun } from './projects.ts';
import type { ModelRequest } from './providers/types.ts';

/** #214: one workspace and one main chat per agent per project. Git clones come from local bare repos. */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, stdio: 'pipe' });

/** A bare repo `<remotes>/<owner>/<name>.git` holding `files`. */
function remote(remotes: string, repo: string, files: Record<string, string>): void {
  const work = mkdtempSync(join(tmpdir(), 'atlas-src-'));
  git(work, 'init', '-q', '-b', 'main');
  for (const [f, text] of Object.entries(files)) writeFileSync(join(work, f), text);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  mkdirSync(join(remotes, repo.split('/')[0]!), { recursive: true });
  git(remotes, 'clone', '-q', '--bare', work, `${repo}.git`);
}

/** git clone from the local remotes (the real command with real progress and errors, no GitHub). */
const localClone =
  (remotes: string): CloneRun =>
  (repo, dir, o) =>
    spawnClone('git', ['clone', '--progress', join(remotes, `${repo}.git`), dir], o);

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const use = (id: string, name: string, input: unknown): ContentBlock[] => [{ type: 'tool_use', id, name, input }];
const results = (req: ModelRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [String(b.content)] : []));

async function setup(o: { script?: NonNullable<Parameters<typeof launch>[0]>['script']; clone?: CloneRun; dbFile?: string; dataDir?: string } = {}) {
  const remotes = mkdtempSync(join(tmpdir(), 'atlas-remotes-'));
  const l = await launch({
    script: o.script,
    dispatch: false,
    env: {},
    ...(o.dbFile ? { dbFile: o.dbFile, dataDir: o.dataDir } : {}),
    projects: { clone: o.clone ?? localClone(remotes) },
  });
  for (const id of ['munih', 'zurich', 'dina']) if (!l.engine.agents.list().some((a) => a.id === id)) l.engine.agents.create({ id, rolePrompt: `${id} role`, modelId: 'sonnet' });
  return { ...l, remotes };
}

const member = (l: Launched, project: string, agent: string) => l.engine.projects.get(project).members.find((m) => m.agentId === agent);
const state = (l: Launched, project: string, agent: string) => member(l, project, agent)?.cloneState;
const ready = (l: Launched, project: string, ...agents: string[]) =>
  until(() => agents.every((a) => state(l, project, a) === 'ready'), `${agents.join(', ')} ready in ${project}`, 10_000);

describe('project workspaces (#214)', () => {
  it('clones each member a workspace in workspaces/<agent>/<project>; the first project keeps the old workdirs', async () => {
    const l = await setup();
    remote(l.remotes, 'datinel/datinel', { 'README.md': 'datinel', 'AGENTS.md': 'Datinel rules' });
    const progress: number[] = [];
    l.engine.bus.on((e) => {
      if (e.type !== 'project.updated' || e.project.id !== 'datinel') return;
      const p = e.project.members.find((m) => m.agentId === 'zurich')?.cloneProgress;
      if (typeof p === 'number') progress.push(p);
    });
    const made = await l.call<Project>('POST', '/projects', { name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    expect(made.status).toBe(201);
    await ready(l, 'datinel', 'dina', 'zurich');
    const z = member(l, 'datinel', 'zurich')!;
    expect(z).toMatchObject({ home: false, workspace: join(l.dataDir, 'workspaces', 'zurich', 'datinel'), cloneError: null });
    expect(readFileSync(join(z.workspace!, 'README.md'), 'utf8')).toBe('datinel');
    expect(existsSync(`${z.workspace}.cloning`)).toBe(false);
    expect(progress.every((p) => p >= 0 && p <= 100)).toBe(true);
    // The first project: home, its own workdir, nothing cloned.
    expect(member(l, 'atlas', 'zurich')).toMatchObject({ home: true, workspace: null, cloneState: 'ready' });
    expect(l.engine.projects.workspace('zurich', 'atlas')).toBe(join(l.dataDir, 'workspaces', 'zurich'));
    expect(l.engine.projects.workspace('zurich', 'datinel')).toBe(z.workspace);
    // A project without a repo: an empty folder.
    await l.call('POST', '/projects', { name: 'Notes', lead: 'munih' });
    await ready(l, 'notes', 'munih');
    expect(readdirSync(join(l.dataDir, 'workspaces', 'munih', 'notes'))).toEqual([]);
  });

  it('a failed clone says why and waits; Try again and Fix the repo name clone it', async () => {
    const l = await setup();
    await l.call('POST', '/projects', { name: 'Datinel', repo: 'datinel/datinal', lead: 'dina', members: ['zurich'] });
    await until(() => state(l, 'datinel', 'dina') === 'failed' && state(l, 'datinel', 'zurich') === 'failed', 'both clones failed', 10_000);
    expect(member(l, 'datinel', 'dina')!.cloneError).toMatch(/datinel\/datinal/);
    expect(existsSync(join(l.dataDir, 'workspaces', 'dina', 'datinel'))).toBe(false);
    // A run there fails loudly, never in another project's folder.
    expect(() => l.engine.projects.workspace('dina', 'datinel')).toThrow(/could not be cloned/);
    // Try again: still missing → failed again; then the repo appears → ready.
    expect((await l.call('POST', '/projects/datinel/members/dina/retry')).status).toBe(200);
    await until(() => state(l, 'datinel', 'dina') === 'failed', 'failed again', 10_000);
    remote(l.remotes, 'datinel/datinal', { 'a.txt': 'a' });
    await l.call('POST', '/projects/datinel/members/dina/retry');
    await ready(l, 'datinel', 'dina');
    expect((await l.call('POST', '/projects/datinel/members/dina/retry')).status).toBe(409); // only a failed one
    // Fix the repo name: allowed while no workspace of it exists… but dina's is ready now: refused.
    expect((await l.call('PATCH', '/projects/datinel', { repo: 'datinel/datinel' })).status).toBe(409);

    // Fix the repo name on a project whose clones all failed: the failed ones clone the new name.
    await l.call('POST', '/projects', { name: 'Other', repo: 'datinel/nope', lead: 'munih' });
    await until(() => state(l, 'other', 'munih') === 'failed', 'other failed', 10_000);
    remote(l.remotes, 'datinel/other', { 'o.txt': 'o' });
    expect((await l.call('PATCH', '/projects/other', { repo: 'datinel/other' })).body).toMatchObject({ repo: 'datinel/other' });
    await ready(l, 'other', 'munih');
    expect(readFileSync(join(l.dataDir, 'workspaces', 'munih', 'other', 'o.txt'), 'utf8')).toBe('o');
  });

  it("a task in project B works only in B's workspace: file tools, shell cwd, instructions, served files", async () => {
    const l = await setup({
      script: [
        use('t1', 'shell', { command: 'pwd; ls' }),
        use('t2', 'write_file', { path: 'out.txt', content: 'from datinel' }),
        use('t3', 'read_file', { path: 'README.md' }),
        text('done'),
      ],
    });
    remote(l.remotes, 'datinel/datinel', { 'README.md': 'datinel readme', 'CLAUDE.md': 'DATINEL-INSTRUCTIONS' });
    writeFileSync(join(l.dataDir, 'workspaces', 'atlas', 'CLAUDE.md'), 'ATLAS-INSTRUCTIONS');
    mkdirSync(join(l.dataDir, 'workspaces', 'zurich'), { recursive: true });
    writeFileSync(join(l.dataDir, 'workspaces', 'zurich', 'CLAUDE.md'), 'ZURICH-ATLAS-INSTRUCTIONS');
    writeFileSync(join(l.dataDir, 'workspaces', 'zurich', 'README.md'), 'atlas readme');
    l.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    await ready(l, 'datinel', 'zurich');
    const ws = join(l.dataDir, 'workspaces', 'zurich', 'datinel');

    const c = l.engine.kanban.create({ title: 'work', projectId: 'datinel', assignee: 'zurich', status: 'done' }, 'user');
    l.engine.kanban.appendMessage(c.id, 'user', 'user', text('go'));
    l.engine.runner.wake(c.id);
    await l.engine.runner.settled(c.id);
    const calls = l.fake.calls;
    expect(calls).toHaveLength(4);
    const system = calls[0]!.system;
    expect(system).toContain('DATINEL-INSTRUCTIONS');
    expect(system).not.toContain('ATLAS-INSTRUCTIONS');
    expect(system).toContain(`Working directory: ${ws}.`);
    expect(system).toContain('/api/files/zurich@datinel/<path>');
    expect(results(calls[1]!)[0]).toContain(ws);
    expect(results(calls[1]!)[0]).toContain('README.md');
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('from datinel');
    expect(existsSync(join(l.dataDir, 'workspaces', 'zurich', 'out.txt'))).toBe(false);
    expect(results(calls[3]!)[0]).toContain('datinel readme');

    // Served files: the old URL is the home workspace; <agent>@<project> is the clone.
    const get = async (p: string) => {
      const r = await fetch(l.api + p);
      return { status: r.status, text: await r.text() };
    };
    expect(await get('/files/zurich/README.md')).toMatchObject({ status: 200, text: 'atlas readme' });
    expect(await get('/files/zurich@datinel/out.txt')).toMatchObject({ status: 200, text: 'from datinel' });
    expect((await get('/files/munih@datinel/x')).status).toBe(409); // not a member there: no fallback
    // An artifact made there is a file of that workspace, served from it.
    const doc = l.engine.documents.create('zurich', { kind: 'markdown', title: 'Spec', content: '# Spec' }, 'zurich', c.id);
    expect(doc).toMatchObject({ projectId: 'datinel', filesRoot: 'zurich@datinel' });
    expect(existsSync(join(ws, doc.path))).toBe(true);
    expect(existsSync(join(l.dataDir, 'workspaces', 'zurich', doc.path))).toBe(false);
  });

  it('the system prompt keeps a stable cached prefix per agent and project', async () => {
    const l = await setup({ script: [text('a'), text('b'), text('c')], clone: async (_r, dir) => void mkdirSync(dir, { recursive: true }) });
    l.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    await ready(l, 'datinel', 'zurich');
    const runIn = async (projectId: string, title: string) => {
      const c = l.engine.kanban.create({ title, projectId, assignee: 'zurich', status: 'done' }, 'user');
      l.engine.kanban.appendMessage(c.id, 'user', 'user', text('go'));
      l.engine.runner.wake(c.id);
      await l.engine.runner.settled(c.id);
    };
    await runIn('datinel', 'one');
    await runIn('datinel', 'two');
    await runIn('atlas', 'three');
    const prefix = (i: number) => {
      const r = l.fake.calls[i]!;
      return r.system.slice(0, r.cache!.systemStable);
    };
    expect(prefix(0)).toBe(prefix(1));
    expect(prefix(0)).toContain('Project: Datinel');
    expect(prefix(2)).toContain('Project: Atlas');
    expect(prefix(2)).not.toBe(prefix(0));
  });

  it("a run whose workspace isn't ready fails loudly on the card", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const l = await setup({
      script: [text('should not run')],
      clone: async (_repo, dir) => {
        await gate;
        mkdirSync(dir, { recursive: true });
      },
    });
    l.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    await until(() => state(l, 'datinel', 'zurich') === 'cloning', 'cloning');
    const c = l.engine.kanban.create({ title: 'work', projectId: 'datinel', assignee: 'zurich', status: 'done' }, 'user');
    l.engine.kanban.appendMessage(c.id, 'user', 'user', text('go'));
    l.engine.runner.wake(c.id);
    await l.engine.runner.settled(c.id);
    const run = l.engine.db.prepare('SELECT status, error FROM runs WHERE card_id = ?').get(c.id) as { status: string; error: string };
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/workspace in project Datinel is not ready yet \(cloning\)/);
    expect(l.fake.calls).toHaveLength(0);
    release();
    await ready(l, 'datinel', 'zurich');
  });

  it('one main chat per agent per project, with separate histories; the first project keeps the same chat', async () => {
    const l = await setup({ clone: async (_r, dir) => void mkdirSync(dir, { recursive: true }) });
    const atlasChat = (await l.call<{ id: string; title: string }>('POST', '/agents/zurich/main-chat')).body;
    l.engine.kanban.appendMessage(atlasChat.id, 'user', 'user', text('about atlas'));
    l.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    await ready(l, 'datinel', 'zurich');
    const dChat = (await l.call<{ id: string; title: string; projectId: string }>('POST', '/agents/zurich/main-chat?project=datinel')).body;
    expect(dChat).toMatchObject({ title: '@zurich · Datinel', projectId: 'datinel' });
    expect(dChat.id).not.toBe(atlasChat.id);
    expect((await l.call<{ id: string }>('POST', '/agents/zurich/main-chat')).body.id).toBe(atlasChat.id);
    expect((await l.call<{ id: string }>('POST', '/agents/zurich/main-chat?project=atlas')).body.id).toBe(atlasChat.id);
    expect((await l.call<{ id: string }>('POST', '/agents/zurich/main-chat?project=datinel')).body.id).toBe(dChat.id);
    expect(l.engine.agents.get('zurich').mainChat).toBe(atlasChat.id);
    expect(l.engine.kanban.messages(dChat.id)).toHaveLength(0);
    expect(l.engine.kanban.messages(atlasChat.id)).toHaveLength(1);
    expect(member(l, 'datinel', 'zurich')!.mainChat).toBe(dChat.id);
    // Not a member: no chat there.
    expect((await l.call('POST', '/agents/munih/main-chat?project=datinel')).status).toBe(400);
    // /clear in Datinel leaves the Atlas chat alone.
    const fresh = (await l.call<{ id: string }>('POST', '/agents/zurich/main-chat/new?project=datinel')).body;
    expect(member(l, 'datinel', 'zurich')!.mainChat).toBe(fresh.id);
    expect(l.engine.agents.get('zurich').mainChat).toBe(atlasChat.id);
  });

  it('removing a member stops its run there, gives its tasks to the lead, archives its chat, keeps its clone', async () => {
    let started = () => {};
    const inRun = new Promise<void>((r) => (started = r));
    const l = await setup({
      clone: async (_r, dir) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'f.txt'), 'kept');
      },
      script: [
        () => {
          started();
          return use('t1', 'shell', { command: 'sleep 30' });
        },
        text('after'),
      ],
    });
    l.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    await ready(l, 'datinel', 'zurich');
    const atlasChat = l.engine.kanban.mainChat('zurich');
    const dChat = l.engine.kanban.mainChat('zurich', 'datinel');
    const atlasTask = l.engine.kanban.create({ title: 'atlas work', assignee: 'zurich', status: 'todo' }, 'user');
    const t = l.engine.kanban.create({ title: 'datinel work', projectId: 'datinel', assignee: 'zurich', status: 'done' }, 'user');
    const other = l.engine.kanban.create({ title: 'datinel later', projectId: 'datinel', assignee: 'zurich', status: 'todo' }, 'user');
    l.engine.kanban.appendMessage(t.id, 'user', 'user', text('go'));
    l.engine.runner.wake(t.id);
    await inRun;
    await eventually(() => l.engine.runner.current(t.id), { what: 'the run' });

    const after = (await l.call<Project>('PATCH', '/projects/datinel', { members: ['dina'] })).body;
    expect(after.members.map((m) => m.agentId)).toEqual(['dina']);
    expect(after.kept).toEqual([expect.objectContaining({ agentId: 'zurich', path: join(l.dataDir, 'workspaces', 'zurich', 'datinel'), home: false })]);
    await l.idle(t.id);
    expect(l.engine.db.prepare('SELECT status FROM runs WHERE card_id = ?').get(t.id)).toEqual({ status: 'stopped' });
    expect(l.engine.kanban.get(other.id)).toMatchObject({ status: 'triage', assignee: null });
    expect(l.engine.kanban.get(dChat.id).status).toBe('archived');
    // Other projects untouched.
    expect(l.engine.kanban.get(atlasChat.id).status).not.toBe('archived');
    expect(l.engine.kanban.get(atlasTask.id)).toMatchObject({ status: 'todo', assignee: 'zurich' });
    // The clone stays on disk and is still served (read-only history), until Master deletes it.
    expect(readFileSync(join(l.dataDir, 'workspaces', 'zurich', 'datinel', 'f.txt'), 'utf8')).toBe('kept');
    expect((await fetch(l.api + '/files/zurich@datinel/f.txt')).status).toBe(200);
    // Back in: takes the kept workspace as it is, ready, no clone.
    const back = (await l.call<Project>('PATCH', '/projects/datinel', { members: ['dina', 'zurich'] })).body;
    expect(back.members.find((m) => m.agentId === 'zurich')).toMatchObject({ cloneState: 'ready' });
    expect(back.kept).toEqual([]);
    // Delete: Master's explicit action, only on a kept one.
    await l.call('PATCH', '/projects/datinel', { members: ['dina'] });
    expect((await l.call('DELETE', '/projects/datinel/kept/zurich')).body).toMatchObject({ kept: [] });
    expect(existsSync(join(l.dataDir, 'workspaces', 'zurich', 'datinel'))).toBe(false);
    expect((await l.call('DELETE', '/projects/datinel/kept/zurich')).status).toBe(404);
  });

  it('a clone cut by an engine stop or kill starts again at the next start: never half-ready', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-t-'));
    const dbFile = join(dataDir, 'atlas.db');
    let entered = () => {};
    const inClone = new Promise<void>((r) => (entered = r));
    const a = await setup({
      dbFile,
      dataDir,
      clone: (_r, dir, o) =>
        new Promise((_ok, fail) => {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, 'half'), 'x');
          entered();
          o.signal.addEventListener('abort', () => fail(o.signal.reason));
        }),
    });
    a.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: [] });
    await inClone;
    expect(state(a, 'datinel', 'dina')).toBe('cloning');
    await a.engine.stop();
    // A stop leaves it 'cloning' (a kill too: the row was written before git started); the partial folder is gone.
    // Simulate a kill that left the partial folder.
    const ws = join(dataDir, 'workspaces', 'dina', 'datinel');
    mkdirSync(`${ws}.cloning`, { recursive: true });
    writeFileSync(join(`${ws}.cloning`, 'half'), 'x');

    const b = await setup({
      dbFile,
      dataDir,
      clone: async (_r, dir) => {
        expect(existsSync(dir)).toBe(false);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'full'), 'y');
      },
    });
    await ready(b, 'datinel', 'dina');
    expect(readdirSync(ws)).toEqual(['full']);
    expect(existsSync(`${ws}.cloning`)).toBe(false);
  });

  it('a kill after the clone finished but before it was marked ready: ready at the next start, no second clone', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-t-'));
    const dbFile = join(dataDir, 'atlas.db');
    const a = await setup({ dbFile, dataDir, clone: async (_r, dir) => void mkdirSync(dir, { recursive: true }) });
    a.engine.projects.create({ name: 'Notes', lead: 'munih' });
    await ready(a, 'notes', 'munih');
    await a.engine.stop();
    // As if killed right after the rename: the folder is full, the row still says cloning.
    const ws = join(dataDir, 'workspaces', 'munih', 'notes');
    writeFileSync(join(ws, 'done'), 'z');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbFile);
    db.prepare("UPDATE project_members SET clone_state = 'cloning' WHERE project_id = 'notes'").run();
    db.close();
    let cloned = 0;
    const b = await setup({
      dbFile,
      dataDir,
      clone: async () => {
        cloned++;
      },
    });
    await ready(b, 'notes', 'munih');
    expect(cloned).toBe(0);
    expect(readdirSync(ws)).toEqual(['done']);
  });
});
