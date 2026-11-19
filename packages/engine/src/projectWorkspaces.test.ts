import { describe, expect, it, onTestFinished } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESUME_KICK, type ContentBlock, type Project } from '@atlas/shared';
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
  it('clones each member a workspace in projects/<project>/<agent>; the first project keeps the old workdirs', async () => {
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
    expect(z).toMatchObject({ home: false, workspace: join(l.dataDir, 'projects', 'datinel', 'zurich'), cloneError: null });
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
    expect(readdirSync(join(l.dataDir, 'projects', 'notes', 'munih'))).toEqual([]);
  });

  it('a failed clone says why and waits; Try again and Fix the repo name clone it', async () => {
    const l = await setup();
    await l.call('POST', '/projects', { name: 'Datinel', repo: 'datinel/datinal', lead: 'dina', members: ['zurich'] });
    await until(() => state(l, 'datinel', 'dina') === 'failed' && state(l, 'datinel', 'zurich') === 'failed', 'both clones failed', 10_000);
    expect(member(l, 'datinel', 'dina')!.cloneError).toMatch(/datinel\/datinal/);
    expect(existsSync(join(l.dataDir, 'projects', 'datinel', 'dina'))).toBe(false);
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
    expect(readFileSync(join(l.dataDir, 'projects', 'other', 'munih', 'o.txt'), 'utf8')).toBe('o');
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
    const ws = join(l.dataDir, 'projects', 'datinel', 'zurich');

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

  it('every run is told the shell is not confined: stay in this project, cross only through the project parameter (#248)', async () => {
    const l = await setup({ script: [text('a'), text('b')], clone: async (_r, dir) => void mkdirSync(dir, { recursive: true }) });
    l.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    await ready(l, 'datinel', 'zurich');
    for (const projectId of ['atlas', 'datinel']) {
      const c = l.engine.kanban.create({ title: projectId, projectId, assignee: 'zurich', status: 'done' }, 'user');
      l.engine.kanban.appendMessage(c.id, 'user', 'user', text('go'));
      l.engine.runner.wake(c.id);
      await l.engine.runner.settled(c.id);
    }
    expect(l.fake.calls).toHaveLength(2);
    for (const call of l.fake.calls) {
      expect(call.system).toContain('file tools read it and the temp folders (/tmp, $TMPDIR) and write only in it');
      expect(call.system).toContain('Shell commands stay inside this working directory and the temp folders');
      expect(call.system).toContain("never read or write another project's workspace by path");
      expect(call.system).toContain("through the tools' explicit `project` parameter, not by path");
      // In the cached prefix: it is part of the workspace block, not of the volatile tail.
      expect(call.system.slice(0, call.cache!.systemStable)).toContain('Shell commands stay inside this working directory');
    }
    expect(l.fake.calls[0]!.system).toContain('Project: Atlas');
    expect(l.fake.calls[1]!.system).toContain('Project: Datinel');
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
    expect(after.kept).toEqual([expect.objectContaining({ agentId: 'zurich', path: join(l.dataDir, 'projects', 'datinel', 'zurich'), home: false })]);
    await l.engine.runner.settled(t.id); // the row is stopped with the removal (#246); wait for the loop itself
    expect(l.engine.db.prepare('SELECT status FROM runs WHERE card_id = ?').get(t.id)).toEqual({ status: 'stopped' });
    expect(l.engine.kanban.get(other.id)).toMatchObject({ status: 'triage', assignee: null });
    expect(l.engine.kanban.get(dChat.id).status).toBe('archived');
    // Other projects untouched.
    expect(l.engine.kanban.get(atlasChat.id).status).not.toBe('archived');
    expect(l.engine.kanban.get(atlasTask.id)).toMatchObject({ status: 'todo', assignee: 'zurich' });
    // The clone stays on disk and is still served (read-only history), until Master deletes it.
    expect(readFileSync(join(l.dataDir, 'projects', 'datinel', 'zurich', 'f.txt'), 'utf8')).toBe('kept');
    expect((await fetch(l.api + '/files/zurich@datinel/f.txt')).status).toBe(200);
    // Back in: takes the kept workspace as it is, ready, no clone.
    const back = (await l.call<Project>('PATCH', '/projects/datinel', { members: ['dina', 'zurich'] })).body;
    expect(back.members.find((m) => m.agentId === 'zurich')).toMatchObject({ cloneState: 'ready' });
    expect(back.kept).toEqual([]);
    // Delete: Master's explicit action, only on a kept one.
    await l.call('PATCH', '/projects/datinel', { members: ['dina'] });
    expect((await l.call('DELETE', '/projects/datinel/kept/zurich')).body).toMatchObject({ kept: [] });
    expect(existsSync(join(l.dataDir, 'projects', 'datinel', 'zurich'))).toBe(false);
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
    const ws = join(dataDir, 'projects', 'datinel', 'dina');
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
    const ws = join(dataDir, 'projects', 'notes', 'munih');
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
  /* ── #246: a restart never resumes the run of an agent that left the card's project ── */

  const kicks = (l: Launched, cardId: string) =>
    (l.engine.db.prepare('SELECT content FROM messages m JOIN cards c ON c.conversation_id = m.conversation_id WHERE c.id = ?').all(cardId) as { content: string }[]).filter((m) =>
      m.content.includes(RESUME_KICK),
    ).length;
  const runsOf = (l: Launched, cardId: string) => l.engine.db.prepare('SELECT status, error FROM runs WHERE card_id = ? ORDER BY started_at, rowid').all(cardId);
  const mkdirClone: CloneRun = async (_r, dir) => void mkdirSync(dir, { recursive: true });

  it("the removal stops the member's run row in its own transaction: a stop right after it resumes nothing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-t-'));
    const dbFile = join(dataDir, 'atlas.db');
    let started = () => {};
    const inRun = new Promise<void>((r) => (started = r));
    const a = await setup({
      dbFile,
      dataDir,
      clone: mkdirClone,
      script: [
        () => {
          started();
          return use('t1', 'shell', { command: 'sleep 30' });
        },
        text('after'),
      ],
    });
    a.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    await ready(a, 'datinel', 'zurich');
    const t = a.engine.kanban.create({ title: 'datinel work', projectId: 'datinel', assignee: 'zurich', status: 'todo' }, 'user');
    a.engine.kanban.appendMessage(t.id, 'user', 'user', text('go'));
    a.engine.runner.wake(t.id, { kind: 'work' });
    await inRun;
    // As if the engine died between the removal's commit and the abort of the run.
    a.engine.projects.onRelease = () => {};
    await a.call('PATCH', '/projects/datinel', { members: ['dina'] });
    expect(runsOf(a, t.id)).toEqual([{ status: 'stopped', error: '@zurich left project Datinel' }]);
    await a.engine.stop(); // the loop ends 'engine shutting down': the stopped row keeps its reason

    const b = await setup({ dbFile, dataDir, clone: mkdirClone });
    expect(runsOf(b, t.id)).toEqual([{ status: 'stopped', error: '@zurich left project Datinel' }]);
    expect(kicks(b, t.id)).toBe(0);
    expect(b.engine.kanban.get(t.id)).toMatchObject({ status: 'triage', assignee: null });
    expect(b.engine.db.prepare("SELECT status, output FROM tool_calls WHERE run_id IN (SELECT id FROM runs WHERE card_id = ?)").all(t.id)).toEqual([
      { status: 'error', output: expect.stringContaining('interrupted') },
    ]);
  });

  it('archiving a project stops its running run rows in the same transaction', async () => {
    let started = () => {};
    const inRun = new Promise<void>((r) => (started = r));
    const l = await setup({
      clone: mkdirClone,
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
    const t = l.engine.kanban.create({ title: 'datinel work', projectId: 'datinel', assignee: 'zurich', status: 'todo' }, 'user');
    l.engine.kanban.appendMessage(t.id, 'user', 'user', text('go'));
    l.engine.runner.wake(t.id, { kind: 'work' });
    await inRun;
    l.engine.projects.archive('datinel'); // the API aborts the live runs after this; the rows are already stopped
    expect(runsOf(l, t.id)).toEqual([{ status: 'stopped', error: 'project Datinel archived' }]);
    l.engine.runner.stop(t.id, 'project Datinel archived');
    await eventually(() => expect(l.engine.db.prepare("SELECT status FROM tool_calls WHERE status = 'running'").all()).toEqual([]), { what: 'the shell cut' });
  });

  it.each([
    ['a removed member', 'running'],
    ['a removed member', 'interrupted'],
    ['an archived project', 'running'],
  ] as const)('a restart stops, never resumes, a run of %s left %s: no kick, the card stays where it was', async (why, left) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-t-'));
    const dbFile = join(dataDir, 'atlas.db');
    const a = await setup({ dbFile, dataDir, clone: mkdirClone });
    a.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    await ready(a, 'datinel', 'zurich');
    const t = a.engine.kanban.create({ title: 'datinel work', projectId: 'datinel', assignee: 'zurich', status: 'todo' }, 'user');
    const mine = a.engine.kanban.create({ title: 'atlas work', assignee: 'zurich', status: 'todo' }, 'user');
    await a.engine.stop();
    // What an engine killed mid-run leaves (or an older build that did not stop the row with the removal).
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbFile);
    const run = db.prepare(
      "INSERT INTO runs (id, card_id, agent_id, kind, status, started_at, owner, lease_until) VALUES (?, ?, 'zurich', 'work', ?, ?, 'dead', ?)",
    );
    const past = new Date(Date.now() - 60_000).toISOString();
    run.run('r_gone', t.id, left, past, past);
    run.run('r_mine', mine.id, left, past, past);
    if (why === 'an archived project') db.prepare("UPDATE projects SET status = 'archived', archived_at = ? WHERE id = 'datinel'").run(past);
    else {
      db.prepare("DELETE FROM project_members WHERE project_id = 'datinel' AND agent_id = 'zurich'").run();
      db.prepare("UPDATE cards SET status = 'triage', assignee = NULL WHERE id = ?").run(t.id);
    }
    db.close();

    const b = await setup({ dbFile, dataDir, clone: mkdirClone, script: [text('resumed')] });
    const reason = why === 'an archived project' ? 'project Datinel archived' : '@zurich left project Datinel';
    expect(runsOf(b, t.id)).toEqual([{ status: 'stopped', error: reason }]);
    expect(kicks(b, t.id)).toBe(0);
    expect(b.engine.kanban.get(t.id)).toMatchObject(why === 'an archived project' ? { status: 'todo', assignee: 'zurich' } : { status: 'triage', assignee: null });
    // A run in a project the agent is still in resumes as before.
    expect(kicks(b, mine.id)).toBe(1);
    await b.idle(mine.id);
    expect(runsOf(b, mine.id)).toEqual([
      { status: 'interrupted', error: left === 'running' ? 'engine stopped during the run' : null },
      { status: 'done', error: null },
    ]);
  });

  it("#245: file tools never cross projects, in either direction: the clone lives outside the agent's own workdir", async () => {
    // The six file tools aimed at the other project's folder (absolute), then a listing of the run's own workdir.
    const dirs = { target: '' };
    const round = (tag: string) => [
      () => use(`${tag}1`, 'read_file', { path: join(dirs.target, 'README.md') }),
      () => use(`${tag}2`, 'write_file', { path: join(dirs.target, 'new.txt'), content: 'crossed' }),
      () => use(`${tag}3`, 'edit_file', { path: join(dirs.target, 'README.md'), old_text: 'readme', new_text: 'crossed' }),
      () => use(`${tag}4`, 'grep', { pattern: 'readme', path: dirs.target }),
      () => use(`${tag}5`, 'list_files', { path: dirs.target }),
      () => use(`${tag}6`, 'glob', { pattern: '*.md', path: dirs.target }),
      () => use(`${tag}7`, 'list_files', { path: '.' }),
      () => text('done'),
    ];
    // Temp folders are readable from any run: the data dir must live elsewhere for reads to be refused.
    const dataDir = mkdtempSync(join(homedir(), '.atlas-t245-'));
    onTestFinished(() => rmSync(dataDir, { recursive: true, force: true }));
    const l = await setup({ script: [...round('a'), ...round('b')], dbFile: join(dataDir, 'atlas.db'), dataDir });
    remote(l.remotes, 'datinel/datinel', { 'README.md': 'datinel readme' });
    const home = join(l.dataDir, 'workspaces', 'zurich');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'README.md'), 'atlas readme');
    l.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    await ready(l, 'datinel', 'zurich');
    const clone = l.engine.projects.workspace('zurich', 'datinel');

    const runIn = async (projectId: string, target: string) => {
      dirs.target = target;
      const before = l.fake.calls.length;
      const c = l.engine.kanban.create({ title: `cross from ${projectId}`, projectId, assignee: 'zurich', status: 'done' }, 'user');
      l.engine.kanban.appendMessage(c.id, 'user', 'user', text('go'));
      l.engine.runner.wake(c.id);
      await l.engine.runner.settled(c.id);
      const calls = l.fake.calls.slice(before);
      expect(calls).toHaveLength(8);
      return calls.slice(1).map((req) => results(req)[0]!);
    };
    const refused = /outside (your workdir|the folders you can open)/;
    // A → B: a run in the home project (Atlas) reaching the Datinel clone.
    const fromHome = await runIn('atlas', clone);
    for (const out of fromHome.slice(0, 6)) expect(out).toMatch(refused);
    expect(fromHome[6]).toContain('README.md');
    expect(fromHome[6]).not.toContain('datinel');
    // B → A: a run in Datinel reaching the home workdir.
    const fromClone = await runIn('datinel', home);
    for (const out of fromClone.slice(0, 6)) expect(out).toMatch(refused);
    expect(fromClone[6]).toContain('README.md');
    // Nothing was written or edited on either side.
    expect(readFileSync(join(clone, 'README.md'), 'utf8')).toBe('datinel readme');
    expect(readFileSync(join(home, 'README.md'), 'utf8')).toBe('atlas readme');
    expect(existsSync(join(clone, 'new.txt')) || existsSync(join(home, 'new.txt'))).toBe(false);
    // By layout: neither folder holds the other.
    expect(clone).toBe(join(l.dataDir, 'projects', 'datinel', 'zurich'));
    expect(clone.startsWith(home + '/') || home.startsWith(clone + '/')).toBe(false);
  });

  it('#245: a clone made inside an agent workdir moves out at start, restart-safe, with its rewind log and worktrees', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-t-'));
    const dbFile = join(dataDir, 'atlas.db');
    const a = await setup({ dbFile, dataDir });
    remote(a.remotes, 'datinel/datinel', { 'README.md': 'datinel readme' });
    a.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich', 'munih'] });
    await ready(a, 'datinel', 'dina', 'zurich', 'munih');
    a.engine.projects.update('datinel', { members: ['dina', 'zurich'] }); // munih's clone is kept
    const card = a.engine.kanban.create({ title: 'old work', projectId: 'datinel', assignee: 'zurich', status: 'todo' }, 'user');
    await a.engine.stop();

    // Put the #214 layout back: every clone inside its agent's own workdir, paths stored that way.
    const fresh = (agent: string) => join(dataDir, 'projects', 'datinel', agent);
    const legacy = (agent: string) => join(dataDir, 'workspaces', agent, 'datinel');
    const { renameSync } = await import('node:fs');
    for (const agent of ['dina', 'zurich', 'munih']) {
      mkdirSync(join(dataDir, 'workspaces', agent), { recursive: true });
      renameSync(fresh(agent), legacy(agent));
    }
    // zurich's clone has a linked worktree next to it; dina was killed mid-move (folder moved, path not yet).
    git(legacy('zurich'), 'worktree', 'add', '-q', join(dataDir, 'wt'), '-b', 'side');
    renameSync(legacy('dina'), fresh('dina'));
    mkdirSync(`${legacy('zurich')}.cloning`);
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbFile);
    for (const agent of ['dina', 'zurich']) db.prepare("UPDATE project_members SET workspace = ? WHERE project_id = 'datinel' AND agent_id = ?").run(legacy(agent), agent);
    db.prepare("UPDATE kept_workspaces SET path = ? WHERE project_id = 'datinel' AND agent_id = 'munih'").run(legacy('munih'));
    const now = new Date().toISOString();
    const log = db.prepare("INSERT INTO file_changes (card_id, workdir, path, tool, started_at, ended_at) VALUES (?, ?, ?, 'write_file', ?, ?)");
    log.run(card.id, legacy('zurich'), 'a.txt', now, now);
    log.run(card.id, join(dataDir, 'workspaces', 'zurich'), 'datinel/b.txt', now, now); // logged by a home run
    log.run(card.id, join(dataDir, 'workspaces', 'zurich'), 'notes.txt', now, now);
    db.prepare("INSERT INTO checkpoints (card_id, seq, workdir, card_status, at) VALUES (?, 1, ?, 'todo', ?)").run(card.id, legacy('zurich'), now);
    const ops = [{ workdir: join(dataDir, 'workspaces', 'zurich'), path: 'datinel/c.txt', from: null, to: null }, { workdir: legacy('zurich'), path: 'd.txt', from: null, to: null }];
    db.prepare("INSERT INTO rewinds (id, card_id, from_seq, upto_seq, workdir, card_before, state, at, ops) VALUES ('rw1', ?, 1, 1, ?, '{}', 'done', ?, ?)").run(card.id, legacy('zurich'), now, JSON.stringify(ops));
    db.close();

    const b = await setup({ dbFile, dataDir });
    for (const agent of ['dina', 'zurich']) {
      expect(member(b, 'datinel', agent)).toMatchObject({ workspace: fresh(agent), cloneState: 'ready' });
      expect(b.engine.projects.workspace(agent, 'datinel')).toBe(fresh(agent));
      expect(readFileSync(join(fresh(agent), 'README.md'), 'utf8')).toBe('datinel readme');
      expect(existsSync(legacy(agent))).toBe(false);
    }
    expect(b.engine.projects.get('datinel').kept).toEqual([expect.objectContaining({ agentId: 'munih', path: fresh('munih') })]);
    expect(existsSync(join(fresh('munih'), 'README.md'))).toBe(true);
    expect(existsSync(`${legacy('zurich')}.cloning`)).toBe(false);
    // The worktree still finds its repo; the rewind log follows the files.
    expect(git(join(dataDir, 'wt'), 'rev-parse', '--abbrev-ref', 'HEAD').toString().trim()).toBe('side');
    const q = (sql: string) => b.engine.db.prepare(sql).all();
    expect(q('SELECT workdir, path FROM file_changes ORDER BY id')).toEqual([
      { workdir: fresh('zurich'), path: 'a.txt' },
      { workdir: fresh('zurich'), path: 'b.txt' },
      { workdir: join(dataDir, 'workspaces', 'zurich'), path: 'notes.txt' },
    ]);
    expect(q('SELECT workdir FROM checkpoints')).toEqual([{ workdir: fresh('zurich') }]);
    const rw = b.engine.db.prepare("SELECT workdir, ops FROM rewinds WHERE id = 'rw1'").get() as { workdir: string; ops: string };
    expect(rw.workdir).toBe(fresh('zurich'));
    expect(JSON.parse(rw.ops)).toEqual([
      { workdir: fresh('zurich'), path: 'c.txt', from: null, to: null },
      { workdir: fresh('zurich'), path: 'd.txt', from: null, to: null },
    ]);
    // Served files follow too.
    expect((await fetch(b.api + '/files/zurich@datinel/README.md')).status).toBe(200);
    // A second start changes nothing.
    expect(b.engine.projects.relocateClones()).toBe(0);
  });

  it('#245: a clone folder that would sit in an agent workdir is refused, never made', async () => {
    const l = await setup();
    l.engine.agents.update('dina', { workdir: l.dataDir });
    l.engine.projects.create({ name: 'Notes', lead: 'dina', members: ['munih'] });
    await until(() => state(l, 'notes', 'dina') === 'failed', 'dina refused', 10_000);
    expect(member(l, 'notes', 'dina')!.cloneError).toMatch(/overlaps @dina's own workdir/);
    expect(state(l, 'notes', 'munih')).toBe('failed'); // munih's clone would be inside dina's workdir too
    expect(existsSync(join(l.dataDir, 'projects', 'notes'))).toBe(false);
  });
});
