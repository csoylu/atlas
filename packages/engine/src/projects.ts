import { execFile } from 'node:child_process';
import { CreateProject, PROJECT_HUES, UpdateProject, type CloneState, type Project, type ProjectMember, type RepoCheck } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { ConflictError, InvalidError, NotFoundError } from './kanban.ts';

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
  joined_at: string;
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

export class Projects {
  constructor(
    private db: Db,
    private bus: Bus,
    private gh: GhRun,
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
    return this.emit(id);
  }

  update(id: string, patch: UpdateProject): Project {
    const p = UpdateProject.parse(patch);
    const before = this.get(id);
    this.db
      .transaction(() => {
        if (before.status === 'archived') throw new ConflictError(`project ${before.name} is archived: restore it to edit it`);
        if (p.name !== undefined && p.name !== before.name) {
          if (this.db.prepare('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE AND id != ?').get(p.name, before.id)) throw new ConflictError(`a project named ${p.name} exists already`);
          this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(p.name, before.id);
        }
        if (p.repo !== undefined && p.repo !== before.repo) {
          if (before.repo) throw new ConflictError(`the repo of ${before.name} is fixed (${before.repo}): another repo is another project`);
          if (p.repo && this.db.prepare('SELECT 1 FROM projects WHERE repo = ? COLLATE NOCASE').get(p.repo)) throw new ConflictError(`another project already has the repo ${p.repo}`);
          this.db.prepare('UPDATE projects SET repo = ? WHERE id = ?').run(p.repo, before.id);
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
    return this.emit(p.id);
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
   * Inside a transaction. The default project's members use their own workdir (ready at once, as before projects);
   * another project's workspace is cloned by #214: until then it is pending and runs there fail loudly.
   */
  private addMember(projectId: string, agentId: string): void {
    const def = defaultProjectOrNull(this.db);
    const first = !def || def === projectId;
    this.db
      .prepare('INSERT INTO project_members (project_id, agent_id, workspace, clone_state, joined_at) VALUES (?, ?, NULL, ?, ?)')
      .run(projectId, agentId, first ? 'ready' : 'pending', new Date().toISOString());
  }

  private removeMember(projectId: string, agentId: string): void {
    if (leadOf(this.db, projectId) === agentId) throw new ConflictError(`@${agentId} leads this project: choose another lead first`);
    const open = this.db
      .prepare("SELECT number FROM cards WHERE project_id = ? AND assignee = ? AND board = 'main' AND status NOT IN ('done', 'closed', 'archived') ORDER BY number")
      .all(projectId, agentId) as { number: number }[];
    if (open.length) throw new ConflictError(`@${agentId} still has open tasks in this project: ${open.map((r) => '#' + r.number).join(', ')}. Reassign or finish them first.`);
    this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND agent_id = ?').run(projectId, agentId);
  }

  private toProject(r: ProjectRow, def: string | null): Project {
    const members = (this.db.prepare('SELECT * FROM project_members WHERE project_id = ? ORDER BY joined_at, rowid').all(r.id) as MemberRow[]).map(
      (m): ProjectMember => ({ agentId: m.agent_id, workspace: m.workspace, cloneState: m.clone_state, cloneError: m.clone_error, joinedAt: m.joined_at }),
    );
    return { id: r.id, name: r.name, repo: r.repo, ciJob: r.ci_job, changelog: r.changelog === 1, lead: r.lead, colour: r.colour, status: r.status, createdAt: r.created_at, archivedAt: r.archived_at, members, isDefault: r.id === def };
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
