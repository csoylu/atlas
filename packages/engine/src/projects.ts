import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CreateProject, PROJECT_HUES, UpdateProject, type CloneState, type KeptWorkspace, type Project, type ProjectMember, type RepoCheck } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { ConflictError, InvalidError, NotFoundError, type Kanban } from './kanban.ts';

/**
 * Projects (#213, design §17). A project owns tasks and chats (cards.project_id), artifacts and folders, workflows
 * (null = global) and memories. Agents are global and members of projects; the lead gets the project's new tasks.
 * With one project nothing behaves differently from before projects: everything defaults to it.
 */

interface ProjectRow {
  id: string;
  name: string;
  repo: string | null;
  ci_job: string | null;
  changelog: number;
  lead: string | null;
  colour: number;
  status: 'active' | 'archived';
  created_at: string;
  archived_at: string | null;
}
interface MemberRow {
  project_id: string;
  agent_id: string;
  workspace: string | null;
  clone_state: CloneState;
  clone_error: string | null;
  home: number;
  main_chat: string | null;
  joined_at: string;
}
interface KeptRow {
  project_id: string;
  agent_id: string;
  path: string;
  home: number;
  kept_at: string;
}

/** The agent's own workdir (agents.workdir, else data/workspaces/<id>): its home project's workspace. */
function homeDir(db: Db, dataDir: string, agentId: string): string {
  const a = db.prepare('SELECT workdir FROM agents WHERE id = ?').get(agentId) as { workdir: string | null } | undefined;
  if (!a) throw new NotFoundError(`agent ${agentId} not found`);
  return resolve(a.workdir ?? join(dataDir, 'workspaces', agentId));
}

/** Where a member's clone of a project goes (#214): data/workspaces/<agent>/<project>. */
export const cloneDir = (dataDir: string, agentId: string, projectId: string) => resolve(dataDir, 'workspaces', agentId, projectId);

/**
 * The workspace of `agentId` in `projectId` (#214): the folder a run there works in (file tools, shell, screenshots,
 * served files, instructions). Its own workdir in its home project, its clone elsewhere. Throws, never falls back to
 * another project's folder, when the agent is not a member or the clone is not ready.
 */
export function workspaceOf(db: Db, dataDir: string, agentId: string, projectId: string): string {
  const m = db.prepare('SELECT * FROM project_members WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as MemberRow | undefined;
  const name = () => projectRow(db, projectId).name;
  if (!m) throw new ConflictError(`@${agentId} is not a member of project ${name()}: it has no workspace there`);
  if (m.home) return homeDir(db, dataDir, agentId);
  if (m.clone_state === 'ready' && m.workspace) {
    if (!existsSync(m.workspace)) throw new ConflictError(`@${agentId}'s workspace in project ${name()} (${m.workspace}) is gone from disk: remove the member and add it again to clone it anew`);
    return m.workspace;
  }
  if (m.clone_state === 'failed') throw new ConflictError(`@${agentId}'s workspace in project ${name()} could not be cloned: ${m.clone_error ?? 'unknown error'}. Fix it in Settings → Projects, then try again.`);
  throw new ConflictError(`@${agentId}'s workspace in project ${name()} is not ready yet (${m.clone_state === 'cloning' ? 'cloning' : 'waiting to be cloned'}): try again when it is.`);
}

/**
 * How a workspace is served (#214): `/api/files/<root>/<path>`. The agent's id for its home workspace (links made before
 * projects keep working), `<agent>@<project>` for its workspace in another project (agent ids have no @).
 */
export function filesRoot(db: Db, agentId: string, projectId: string): string {
  const m = db.prepare('SELECT home FROM project_members WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as { home: number } | undefined;
  const k = m ? undefined : (db.prepare('SELECT home FROM kept_workspaces WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as { home: number } | undefined);
  const home = m ? m.home === 1 : k ? k.home === 1 : true;
  return home ? agentId : `${agentId}@${projectId}`;
}

/** The folder behind `/api/files/<root>/…`: a member's workspace (ready), or a removed member's kept one. */
export function filesDir(db: Db, dataDir: string, root: string): { agentId: string; dir: string } {
  const at = root.indexOf('@');
  if (at < 0) return { agentId: root, dir: homeDir(db, dataDir, root) };
  const agentId = root.slice(0, at);
  const projectId = root.slice(at + 1);
  const kept = db.prepare('SELECT path FROM kept_workspaces WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as { path: string } | undefined;
  if (kept && !isMember(db, projectId, agentId)) return { agentId, dir: kept.path };
  return { agentId, dir: workspaceOf(db, dataDir, agentId, projectId) };
}

/** The ready workspaces of an agent, one per project (home first): what the Library re-reads. */
export function workspacesOf(db: Db, dataDir: string, agentId: string): { projectId: string; dir: string }[] {
  const rows = db.prepare('SELECT * FROM project_members WHERE agent_id = ? ORDER BY home DESC, joined_at').all(agentId) as MemberRow[];
  return rows.flatMap((m) => (m.home ? [{ projectId: m.project_id, dir: homeDir(db, dataDir, agentId) }] : m.clone_state === 'ready' && m.workspace ? [{ projectId: m.project_id, dir: m.workspace }] : []));
}

/** The default project: the oldest active one (what a task, chat, artifact or folder gets when none is given). */
export function defaultProjectId(db: Db): string {
  const id = defaultProjectOrNull(db);
  if (!id) throw new ConflictError('there is no active project: restore one in Settings → Projects');
  return id;
}

/** The default project, or null when every project is archived. */
export function defaultProjectOrNull(db: Db): string | null {
  const r = db.prepare("SELECT id FROM projects WHERE status = 'active' ORDER BY created_at, rowid LIMIT 1").get() as { id: string } | undefined;
  return r?.id ?? null;
}

export function projectRow(db: Db, id: string): ProjectRow {
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!r) throw new NotFoundError(`project ${id} not found`);
  return r;
}

export const isMember = (db: Db, projectId: string, agentId: string): boolean =>
  !!db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND agent_id = ?').get(projectId, agentId);

export const leadOf = (db: Db, projectId: string): string | null =>
  (db.prepare('SELECT lead FROM projects WHERE id = ?').get(projectId) as { lead: string | null } | undefined)?.lead ?? null;

/** Refuse writing into an archived project (read-only: nothing is deleted, nothing moves). */
export function assertActive(db: Db, projectId: string, what = 'it'): void {
  const p = projectRow(db, projectId);
  if (p.status === 'archived') throw new ConflictError(`project ${p.name} is archived: ${what} is read-only. Restore the project in Settings → Projects first.`);
}

/**
 * Which project a tool call acts on. `asked` omitted: the run's own project. Another project: only for an agent that
 * leads the run's project or the asked one (#213: crossing projects is the lead's job), else a clear refusal.
 */
export function scopeFor(db: Db, agentId: string, runProject: string, asked: unknown): string {
  if (asked === undefined || asked === null || asked === '') return runProject;
  if (typeof asked !== 'string') throw new InvalidError('project must be a project id or name');
  const target = resolveProject(db, asked);
  if (target === runProject) return target;
  if (leadOf(db, runProject) === agentId || leadOf(db, target) === agentId) return target;
  const run = projectRow(db, runProject).name;
  throw new InvalidError(`you work in project ${run}: only a project's lead can act on another project (${projectRow(db, target).name})`);
}

/** A project by id or name (case-insensitive). */
export function resolveProject(db: Db, ref: string): string {
  const r = db.prepare('SELECT id FROM projects WHERE id = ? OR name = ? COLLATE NOCASE').get(ref.trim(), ref.trim()) as { id: string } | undefined;
  if (!r) throw new NotFoundError(`project ${ref} not found`);
  return r.id;
}

/** The project a new card gets: the asked one (checked), else the default; the assignee must be one of its members. */
export function projectForNewCard(db: Db, asked: string | undefined, assignee: string | null): string {
  const id = asked ? resolveProject(db, asked) : defaultProjectId(db);
  assertActive(db, id, 'it takes no new task');
  if (assignee && !isMember(db, id, assignee)) throw new InvalidError(`@${assignee} is not a member of project ${projectRow(db, id).name}`);
  return id;
}

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'project';

/** `gh` for the repo check: args → stdout. Injected in tests. */
export type GhRun = (args: string[]) => Promise<string>;

export function ghRunner(env: () => Promise<NodeJS.ProcessEnv>, gh = 'gh'): GhRun {
  return async (args) => {
    const e = await env();
    return new Promise((resolve, reject) => {
      execFile(gh, args, { env: e, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('gh not found on PATH (install the GitHub CLI and run gh auth login)'));
          const msg = String(stderr).trim().split('\n').find((l) => l.trim()) ?? err.message;
          return reject(new Error(`gh: ${msg}`));
        }
        resolve(String(stdout));
      });
    });
  };
}

/**
 * Clone `repo` (owner/name) into `dir` (a folder that does not exist yet). `onProgress`: git's receiving percentage.
 * Rejects with a message for Master when it fails. Injected in tests (a local bare repo).
 */
export type CloneRun = (repo: string, dir: string, o: { env: NodeJS.ProcessEnv; signal: AbortSignal; onProgress: (pct: number) => void }) => Promise<void>;

/**
 * Run a clone command (git or gh), reading git's progress from stderr (`Receiving objects:  62% (…)`). The error is the
 * last meaningful stderr line.
 */
export function spawnClone(cmd: string, args: string[], o: Parameters<CloneRun>[2]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { env: { ...o.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'ignore', 'pipe'], signal: o.signal });
    let tail = '';
    child.stderr.on('data', (b: Buffer) => {
      const text = b.toString();
      tail = (tail + text).slice(-4000);
      for (const m of text.matchAll(/Receiving objects:\s+(\d+)%/g)) o.onProgress(Number(m[1]));
    });
    child.on('error', (e: NodeJS.ErrnoException) =>
      fail(e.code === 'ENOENT' ? new Error(`${cmd} not found on PATH${cmd === 'gh' ? ' (install the GitHub CLI and run gh auth login)' : ''}`) : e),
    );
    child.on('close', (code) => {
      if (code === 0) return done();
      const lines = tail.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !/^(Cloning into|remote: (Counting|Compressing|Enumerating|Total)|Receiving|Resolving)/.test(l));
      fail(new Error(lines.at(-1) ?? `${cmd} exited with code ${code}`));
    });
  });
}

/** The default clone: `gh repo clone`, so Master's gh login reads private repos (git through the login-shell env). */
export const ghClone =
  (gh = 'gh'): CloneRun =>
  (repo, dir, o) =>
    spawnClone(gh, ['repo', 'clone', repo, dir, '--', '--progress'], o);

/** A clone failure as the Settings card says it (mockup « Clone failed »). */
function cloneMessage(repo: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/not found|could not resolve|could not read|repository .* does not exist|authentication|permission/i.test(msg))
    return `Can't reach ${repo}: GitHub has no repo by that name, or your GitHub login (gh) can't read it. (${msg})`;
  return `Cloning ${repo} failed: ${msg}`;
}

const nonEmpty = (dir: string) => existsSync(dir) && readdirSync(dir).length > 0;

export interface ProjectsOptions {
  dataDir: string;
  /** How a repo is cloned (default: gh repo clone). */
  clone: CloneRun;
  /** The environment git runs in (#136: the login shell's PATH, Master's gh login). */
  env: () => Promise<NodeJS.ProcessEnv>;
}

export class Projects {
  /** Clones in progress, by `project/agent`: aborted by stop() (the row stays 'cloning' and resumes at the next start). */
  private clones = new Map<string, { ctrl: AbortController; done: Promise<void> }>();
  private progress = new Map<string, number>();
  /** Cards whose run must stop after a member left (set by the engine: runner.stop). */
  onRelease: (cardIds: string[], why: string) => void = () => {};

  constructor(
    private db: Db,
    private bus: Bus,
    private gh: GhRun,
    private kanban: Kanban,
    private o: ProjectsOptions,
  ) {}

  /** Active projects (oldest first), archived ones too with `archived`. */
  list(opts: { archived?: boolean } = {}): Project[] {
    const rows = this.db.prepare(`SELECT * FROM projects ${opts.archived ? '' : "WHERE status = 'active'"} ORDER BY created_at, rowid`).all() as ProjectRow[];
    const def = defaultProjectOrNull(this.db);
    return rows.map((r) => this.toProject(r, def));
  }

  get(id: string): Project {
    return this.toProject(projectRow(this.db, resolveProject(this.db, id)), defaultProjectOrNull(this.db));
  }

  defaultId(): string {
    return defaultProjectId(this.db);
  }

  /** Refuse a write into an archived project (read-only). */
  assertActive(projectId: string, what?: string): void {
    assertActive(this.db, projectId, what);
  }

    isMember(projectId: string, agentId: string): boolean {
    return isMember(this.db, projectId, agentId);
  }

  /** Projects an agent is a member of (active ones). */
  of(agentId: string): Project[] {
    return this.list().filter((p) => p.members.some((m) => m.agentId === agentId));
  }

  create(input: CreateProject): Project {
    const c = CreateProject.parse(input);
    const id = this.db
      .transaction(() => {
        if (this.db.prepare('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE').get(c.name)) throw new ConflictError(`a project named ${c.name} exists already`);
        if (c.repo && this.db.prepare('SELECT 1 FROM projects WHERE repo = ? COLLATE NOCASE').get(c.repo)) throw new ConflictError(`another project already has the repo ${c.repo}`);
        let id = slugOf(c.name);
        for (let n = 2; this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id); n++) id = `${slugOf(c.name)}-${n}`;
        const used = new Set((this.db.prepare('SELECT colour FROM projects').all() as { colour: number }[]).map((r) => r.colour));
        const colour = c.colour ?? PROJECT_HUES.find((h) => !used.has(h)) ?? PROJECT_HUES[used.size % PROJECT_HUES.length]!;
        const members = this.memberList(c.members, c.lead);
        this.db
          .prepare('INSERT INTO projects (id, name, repo, ci_job, changelog, lead, colour, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, c.name, c.repo, c.ciJob, c.changelog ? 1 : 0, c.lead, colour, new Date().toISOString());
        for (const a of members) this.addMember(id, a);
        return id;
      })
      .immediate();
    this.resume();
    return this.emit(id);
  }

  update(id: string, patch: UpdateProject): Project {
    const p = UpdateProject.parse(patch);
    const before = this.get(id);
    this.released = [];
    this.db
      .transaction(() => {
        if (before.status === 'archived') throw new ConflictError(`project ${before.name} is archived: restore it to edit it`);
        if (p.name !== undefined && p.name !== before.name) {
          if (this.db.prepare('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE AND id != ?').get(p.name, before.id)) throw new ConflictError(`a project named ${p.name} exists already`);
          this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(p.name, before.id);
        }
        if (p.repo !== undefined && p.repo !== before.repo) {
          // Fixed once set, except while no member has a workspace of it (« Fix the repo name » after a failed clone).
          const used = before.members.some((m) => m.home || m.cloneState === 'ready' || m.cloneState === 'cloning');
          if (before.repo && used) throw new ConflictError(`the repo of ${before.name} is fixed (${before.repo}): another repo is another project`);
          if (p.repo && this.db.prepare('SELECT 1 FROM projects WHERE repo = ? COLLATE NOCASE AND id != ?').get(p.repo, before.id)) throw new ConflictError(`another project already has the repo ${p.repo}`);
          this.db.prepare('UPDATE projects SET repo = ? WHERE id = ?').run(p.repo, before.id);
          // The failed clones try the new name.
          this.db.prepare("UPDATE project_members SET clone_state = 'pending', clone_error = NULL WHERE project_id = ? AND clone_state = 'failed'").run(before.id);
        }
        if (p.ciJob !== undefined) this.db.prepare('UPDATE projects SET ci_job = ? WHERE id = ?').run(p.ciJob, before.id);
        if (p.changelog !== undefined) this.db.prepare('UPDATE projects SET changelog = ? WHERE id = ?').run(p.changelog ? 1 : 0, before.id);
        if (p.colour !== undefined) this.db.prepare('UPDATE projects SET colour = ? WHERE id = ?').run(p.colour, before.id);
        const lead = p.lead !== undefined ? p.lead : before.lead;
        if (p.lead !== undefined) {
          this.checkAgent(p.lead);
          this.db.prepare('UPDATE projects SET lead = ? WHERE id = ?').run(p.lead, before.id);
        }
        if (p.members !== undefined) {
          const want = new Set(this.memberList(p.members, lead));
          for (const m of before.members) if (!want.has(m.agentId)) this.removeMember(before.id, m.agentId);
          for (const a of want) if (!before.members.some((m) => m.agentId === a)) this.addMember(before.id, a);
        } else if (lead && !this.isMember(before.id, lead)) this.addMember(before.id, lead);
      })
      .immediate();
    this.afterRelease();
    this.resume();
    return this.emit(before.id);
  }

  /**
   * Archive: nothing is deleted. Its workflows are turned off here; the caller stops its runs (the dispatcher starts
   * none in an archived project, and every write to its cards is refused).
   */
  archive(id: string): Project {
    const p = this.get(id);
    if (p.status === 'archived') return p;
    this.db
      .transaction(() => {
        this.db.prepare("UPDATE projects SET status = 'archived', archived_at = ? WHERE id = ?").run(new Date().toISOString(), p.id);
        this.db.prepare('UPDATE workflows SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE project_id = ? AND enabled = 1').run(new Date().toISOString(), p.id);
        if (!this.db.prepare("SELECT 1 FROM projects WHERE status = 'active'").get()) throw new ConflictError(`${p.name} is the last active project: create or restore another one first`);
      })
      .immediate();
    return this.emit(p.id);
  }

  /** Back to active; its workflows stay off (turn them on again one by one). */
  restore(id: string): Project {
    const p = this.get(id);
    this.db.prepare("UPDATE projects SET status = 'active', archived_at = NULL WHERE id = ?").run(p.id);
    this.resume();
    return this.emit(p.id);
  }

  /* ── Workspaces (#214) ───────────────────────────────────────────────── */

  /** The agent's workspace in a project (throws when it has none ready there). */
  workspace(agentId: string, projectId: string): string {
    return workspaceOf(this.db, this.o.dataDir, agentId, projectId);
  }

  /** The folder behind `/api/files/<root>/…`. */
  filesDir(root: string): { agentId: string; dir: string } {
    return filesDir(this.db, this.o.dataDir, root);
  }

  /**
   * Start the clones still to do: pending ones, and those a stopped or killed engine left 'cloning' (their partial
   * folder is thrown away and the clone starts again: never half-ready). Archived projects wait for their restore.
   */
  resume(): void {
    const rows = this.db
      .prepare(
        `SELECT m.project_id, m.agent_id FROM project_members m JOIN projects p ON p.id = m.project_id
         WHERE m.home = 0 AND m.clone_state IN ('pending', 'cloning') AND p.status = 'active' ORDER BY m.joined_at`,
      )
      .all() as { project_id: string; agent_id: string }[];
    for (const r of rows) this.startClone(r.project_id, r.agent_id);
  }

  /** « Try again » on a failed clone. */
  retry(projectId: string, agentId: string): Project {
    const p = this.get(projectId);
    if (p.status === 'archived') throw new ConflictError(`project ${p.name} is archived: restore it first`);
    const m = p.members.find((x) => x.agentId === agentId);
    if (!m) throw new NotFoundError(`@${agentId} is not a member of project ${p.name}`);
    if (m.cloneState !== 'failed') throw new ConflictError(`@${agentId}'s workspace in ${p.name} is ${m.cloneState}: only a failed clone is tried again`);
    this.db.prepare("UPDATE project_members SET clone_state = 'pending', clone_error = NULL WHERE project_id = ? AND agent_id = ?").run(p.id, agentId);
    this.startClone(p.id, agentId);
    return this.emit(p.id);
  }

  /**
   * Delete a removed member's kept workspace from disk: Master's explicit action (never automatic). An agent's own
   * workdir is never deleted from here.
   */
  deleteKept(projectId: string, agentId: string): Project {
    const p = this.get(projectId);
    const k = this.db.prepare('SELECT * FROM kept_workspaces WHERE project_id = ? AND agent_id = ?').get(p.id, agentId) as KeptRow | undefined;
    if (!k) throw new NotFoundError(`no kept workspace of @${agentId} in ${p.name}`);
    if (k.home) throw new ConflictError(`${k.path} is @${agentId}'s own workspace: Atlas never deletes it`);
    if (k.path !== cloneDir(this.o.dataDir, agentId, p.id)) throw new ConflictError(`${k.path} is not a workspace Atlas cloned: delete it yourself`);
    rmSync(k.path, { recursive: true, force: true });
    this.db.prepare('DELETE FROM kept_workspaces WHERE project_id = ? AND agent_id = ?').run(p.id, agentId);
    return this.emit(p.id);
  }

  /** Stop the clones in progress (engine stop): they stay 'cloning' and start again at the next start. */
  async stop(): Promise<void> {
    const running = [...this.clones.values()];
    for (const c of running) c.ctrl.abort(new Error('engine stopping'));
    await Promise.all(running.map((c) => c.done));
  }

  /** Resolves when the member's clone in progress (if any) has finished. */
  async settled(projectId: string, agentId: string): Promise<void> {
    await this.clones.get(`${projectId}/${agentId}`)?.done;
  }

  private startClone(projectId: string, agentId: string): void {
    const key = `${projectId}/${agentId}`;
    if (this.clones.has(key)) return;
    const ctrl = new AbortController();
    const done = this.cloneOne(projectId, agentId, ctrl.signal)
      .catch((e: unknown) => console.error(`clone of ${key} failed`, e))
      .finally(() => {
        this.clones.delete(key);
        this.progress.delete(key);
      });
    this.clones.set(key, { ctrl, done });
  }

  private member(projectId: string, agentId: string): MemberRow | undefined {
    return this.db.prepare('SELECT * FROM project_members WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as MemberRow | undefined;
  }

  private setState(projectId: string, agentId: string, state: CloneState, error: string | null = null): void {
    this.db.prepare('UPDATE project_members SET clone_state = ?, clone_error = ? WHERE project_id = ? AND agent_id = ?').run(state, error, projectId, agentId);
    if (this.member(projectId, agentId)) this.emit(projectId);
  }

  private async cloneOne(projectId: string, agentId: string, signal: AbortSignal): Promise<void> {
    const key = `${projectId}/${agentId}`;
    const m = this.member(projectId, agentId);
    if (!m || m.home || m.clone_state === 'ready' || m.clone_state === 'failed') return;
    const project = projectRow(this.db, projectId);
    const dir = m.workspace ?? cloneDir(this.o.dataDir, agentId, projectId);
    const partial = `${dir}.cloning`;
    // 'cloning' at start = a stopped or killed engine: the partial folder goes; a finished rename means the clone was done.
    const wasCloning = m.clone_state === 'cloning';
    this.db.prepare("UPDATE project_members SET workspace = ?, clone_state = 'cloning', clone_error = NULL WHERE project_id = ? AND agent_id = ?").run(dir, projectId, agentId);
    this.emit(projectId);
    rmSync(partial, { recursive: true, force: true });
    try {
      if (nonEmpty(dir)) {
        if (wasCloning) return this.setState(projectId, agentId, 'ready');
        throw new Error(`the folder ${dir} exists already and is not empty: move it away, then try again`);
      }
      if (!project.repo) {
        mkdirSync(dir, { recursive: true });
        return this.setState(projectId, agentId, 'ready');
      }
      rmSync(dir, { recursive: true, force: true }); // an empty folder: git wants none
      mkdirSync(dirname(dir), { recursive: true });
      const env = await this.o.env();
      await this.o.clone(project.repo, partial, {
        env,
        signal,
        onProgress: (pct) => {
          if (this.progress.get(key) === pct) return;
          this.progress.set(key, pct);
          if (this.member(projectId, agentId)) this.emit(projectId);
        },
      });
      if (!this.member(projectId, agentId)) return rmSync(partial, { recursive: true, force: true }); // removed meanwhile
      renameSync(partial, dir);
      this.setState(projectId, agentId, 'ready');
    } catch (e) {
      rmSync(partial, { recursive: true, force: true });
      if (signal.aborted) return; // engine stopping: still 'cloning', resumed at the next start
      if (!this.member(projectId, agentId)) return;
      this.setState(projectId, agentId, 'failed', project.repo && !/^the folder /.test(e instanceof Error ? e.message : '') ? cloneMessage(project.repo, e) : e instanceof Error ? e.message : String(e));
    }
  }

  /** The New project form's check: does Master's gh login see the repo, its default branch, its instructions. */
  async checkRepo(repo: string): Promise<RepoCheck> {
    const name = RepoNameOrThrow(repo);
    let info: { private?: boolean; default_branch?: string };
    try {
      info = JSON.parse(await this.gh(['api', `repos/${name}`])) as typeof info;
    } catch (e) {
      return { repo: name, found: false, private: null, defaultBranch: null, instructions: [], error: e instanceof Error ? e.message : String(e) };
    }
    const branch = info.default_branch ?? null;
    let instructions: string[] = [];
    try {
      const root = JSON.parse(await this.gh(['api', `repos/${name}/contents/${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`])) as { name: string; type: string }[];
      instructions = root.filter((f) => f.type === 'file' && (f.name === 'CLAUDE.md' || f.name === 'AGENTS.md')).map((f) => f.name);
    } catch (e) {
      // An empty repo has no contents (404): no instructions to show. Anything else is an error.
      if (!/404|empty/i.test(e instanceof Error ? e.message : String(e))) throw e;
    }
    return { repo: name, found: true, private: info.private ?? null, defaultBranch: branch, instructions, error: null };
  }

  private memberList(members: string[], lead: string | null): string[] {
    const all = [...new Set([...(lead ? [lead] : []), ...members])];
    for (const a of all) this.checkAgent(a);
    return all;
  }

  private checkAgent(a: string | null): void {
    if (a && !this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(a)) throw new ConflictError(`agent @${a} does not exist`);
  }

  /**
   * Inside a transaction. The first project's members work in their own workdir (home: ready at once, as before
   * projects); another project's member gets a clone in data/workspaces/<agent>/<project>, made after the commit
   * (resume). A workspace kept from an earlier membership is taken back as it is.
   */
  private addMember(projectId: string, agentId: string): void {
    const def = defaultProjectOrNull(this.db);
    const kept = this.db.prepare('SELECT * FROM kept_workspaces WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as KeptRow | undefined;
    const hasHome = !!this.db.prepare('SELECT 1 FROM project_members WHERE agent_id = ? AND home = 1').get(agentId);
    const home = kept ? kept.home === 1 : (!def || def === projectId) && !hasHome;
    const dir = home ? null : (kept?.path ?? cloneDir(this.o.dataDir, agentId, projectId));
    const ready = home || (!!kept && existsSync(kept.path));
    this.db
      .prepare('INSERT INTO project_members (project_id, agent_id, workspace, clone_state, home, joined_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(projectId, agentId, dir, ready ? 'ready' : 'pending', home ? 1 : 0, new Date().toISOString());
    if (kept) this.db.prepare('DELETE FROM kept_workspaces WHERE project_id = ? AND agent_id = ?').run(projectId, agentId);
  }

  /** Cards to stop after the transaction that released them. */
  private released: { key: string; ids: string[]; why: string }[] = [];

  /**
   * Inside a transaction (#214): the member's open tasks there go back to the lead (triage), its chats there are
   * archived (read-only, still searchable), its running runs there stop (after the commit), and its workspace stays
   * on disk, listed as kept. Other projects are untouched.
   */
  private removeMember(projectId: string, agentId: string): void {
    const lead = leadOf(this.db, projectId);
    if (lead === agentId) throw new ConflictError(`@${agentId} leads this project: choose another lead first`);
    const open = this.db
      .prepare("SELECT number FROM cards WHERE project_id = ? AND assignee = ? AND board = 'main' AND status NOT IN ('done', 'closed', 'archived') ORDER BY number")
      .all(projectId, agentId) as { number: number }[];
    if (open.length && !lead) throw new ConflictError(`@${agentId} still has open tasks in this project: ${open.map((r) => '#' + r.number).join(', ')}, and the project has no lead to take them. Reassign or finish them first.`);
    const m = this.member(projectId, agentId)!;
    const ids = this.kanban.releaseMember(projectId, agentId, 'user');
    // Every run of the agent in this project stops, whatever its card (a done task's chat too).
    const running = this.db
      .prepare("SELECT DISTINCT r.card_id FROM runs r JOIN cards c ON c.id = r.card_id WHERE r.agent_id = ? AND r.status = 'running' AND c.project_id = ?")
      .all(agentId, projectId) as { card_id: string }[];
    for (const r of running) if (!ids.includes(r.card_id)) ids.push(r.card_id);
    this.released.push({ key: `${projectId}/${agentId}`, ids, why: `@${agentId} left project ${projectRow(this.db, projectId).name}` });
    const path = m.home ? homeDir(this.db, this.o.dataDir, agentId) : m.workspace;
    if (path && (m.home || m.clone_state === 'ready'))
      this.db
        .prepare('INSERT OR REPLACE INTO kept_workspaces (project_id, agent_id, path, home, kept_at) VALUES (?, ?, ?, ?, ?)')
        .run(projectId, agentId, path, m.home, new Date().toISOString());
    this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND agent_id = ?').run(projectId, agentId);
  }

  private afterRelease(): void {
    for (const r of this.released.splice(0)) {
      this.clones.get(r.key)?.ctrl.abort(new Error('member removed'));
      for (const id of r.ids) this.kanban.emit(id);
      this.onRelease(r.ids, r.why);
    }
  }

  private toProject(r: ProjectRow, def: string | null): Project {
    const members = (this.db.prepare('SELECT * FROM project_members WHERE project_id = ? ORDER BY joined_at, rowid').all(r.id) as MemberRow[]).map(
      (m): ProjectMember => ({
        agentId: m.agent_id,
        workspace: m.workspace,
        cloneState: m.clone_state,
        cloneError: m.clone_error,
        home: m.home === 1,
        cloneProgress: m.clone_state === 'cloning' ? (this.progress.get(`${r.id}/${m.agent_id}`) ?? null) : null,
        mainChat: m.main_chat,
        joinedAt: m.joined_at,
      }),
    );
    const kept = (this.db.prepare('SELECT * FROM kept_workspaces WHERE project_id = ? ORDER BY kept_at').all(r.id) as KeptRow[]).map(
      (k): KeptWorkspace => ({ agentId: k.agent_id, path: k.path, home: k.home === 1, keptAt: k.kept_at }),
    );
    return { id: r.id, name: r.name, repo: r.repo, ciJob: r.ci_job, changelog: r.changelog === 1, lead: r.lead, colour: r.colour, status: r.status, createdAt: r.created_at, archivedAt: r.archived_at, members, kept, isDefault: r.id === def };
  }

  private emit(id: string): Project {
    const project = this.get(id);
    this.bus.emit({ type: 'project.updated', project });
    return project;
  }
}

function RepoNameOrThrow(repo: string): string {
  const r = repo.trim();
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(r)) throw new InvalidError('a GitHub repo is owner/name');
  return r;
}
