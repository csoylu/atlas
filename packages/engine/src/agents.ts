import { join, resolve } from 'node:path';
import { cardRef, CreateAgent, UpdateAgent, type Agent } from '@atlas/shared';
import type { Db } from './store/db.ts';
import { ConflictError, NotFoundError } from './kanban.ts';

interface AgentRow {
  id: string;
  role_prompt: string;
  model_id: string;
  workdir: string | null;
  enabled: number;
  max_runs: number;
  /** From project_members (the default project's row), see Agents.SELECT. */
  main_chat: string | null;
}
const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  rolePrompt: r.role_prompt,
  modelId: r.model_id,
  workdir: r.workdir,
  enabled: r.enabled === 1,
  maxRuns: r.max_runs,
  mainChat: r.main_chat,
});

/**
 * An agent's own working directory: its configured path, or data/workspaces/<id>. It is the workspace of its home
 * project (the first one); a run takes its project's workspace (projects.ts workspaceOf).
 */
export function workdirOf(agent: Pick<Agent, 'id' | 'workdir'>, dataDir: string): string {
  return resolve(agent.workdir ?? join(dataDir, 'workspaces', agent.id));
}

/** An agent with its main chat in the default project (#214: one main chat per project, on project_members). */
const SELECT = `SELECT a.*, (SELECT m.main_chat FROM project_members m WHERE m.agent_id = a.id AND m.project_id =
  (SELECT id FROM projects WHERE status = 'active' ORDER BY created_at, rowid LIMIT 1)) AS main_chat FROM agents a`;

export class Agents {
  constructor(private db: Db) {}

  list(): Agent[] {
    return (this.db.prepare(`${SELECT} ORDER BY a.id`).all() as AgentRow[]).map(toAgent);
  }

  get(id: string): Agent {
    const row = this.db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as AgentRow | undefined;
    if (!row) throw new NotFoundError(`agent ${id} does not exist`);
    return toAgent(row);
  }

  create(input: CreateAgent): Agent {
    const c = CreateAgent.parse(input);
    if (this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(c.id)) throw new ConflictError(`agent ${c.id} already exists`);
    if (!this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(c.modelId)) throw new ConflictError(`model ${c.modelId} does not exist`);
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO agents (id, role_prompt, model_id, workdir, max_runs) VALUES (?, ?, ?, ?, ?)')
        .run(c.id, c.rolePrompt, c.modelId, c.workdir, c.maxRuns);
      // A new agent joins the default project, in its own workdir (#213): with one project, everyone is in it.
      this.db
        .prepare(
          `INSERT INTO project_members (project_id, agent_id, clone_state, home, joined_at)
           SELECT id, ?, 'ready', 1, ? FROM projects WHERE status = 'active' ORDER BY created_at, rowid LIMIT 1`,
        )
        .run(c.id, new Date().toISOString());
    })();
    return this.get(c.id);
  }

  /** Delete an agent. Refused while open cards are assigned to it (a running one included: no implicit kill), or it
   * triages (reassign first). Done, closed (cancelled) and archived cards don't count. */
  remove(id: string): void {
    this.get(id);
    const cards = this.db
      .prepare("SELECT id, number FROM cards WHERE assignee = ? AND status NOT IN ('done', 'closed', 'archived') ORDER BY number")
      .all(id) as { id: string; number: number | null }[];
    if (cards.length)
      throw new ConflictError(`@${id} still has open tasks: ${cards.map(cardRef).join(', ')}. Reassign, finish or close them first.`);
    const leads = this.db.prepare('SELECT name FROM projects WHERE lead = ? ORDER BY created_at').all(id) as { name: string }[];
    if (leads.length)
      throw new ConflictError(`@${id} leads ${leads.map((p) => p.name).join(', ')} (the triage agent): pick another one in Settings → Board first.`);
    this.db.transaction(() => {
      // Their direct chat goes with them (kept in the database, archived).
      this.db.prepare("UPDATE cards SET status = 'archived' WHERE board = 'direct' AND assignee = ?").run(id);
      this.db.prepare("UPDATE cards SET assignee = NULL WHERE assignee = ?").run(id);
      // Their memories are archived, never deleted (Settings → Memory still shows them).
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO memory_changes (memory_id, at, by, action, before_text, before_kind, before_scope, before_status, before_pinned)
           SELECT id, ?, 'user', 'forget', text, kind, scope, status, pinned FROM memories WHERE scope = ? AND status != 'archived'`,
        )
        .run(now, `agent:${id}`);
      this.db.prepare("UPDATE memories SET status = 'archived', updated_at = ?, updated_by = 'user' WHERE scope = ? AND status != 'archived'").run(now, `agent:${id}`);
      this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    })();
  }

  update(id: string, patch: UpdateAgent): Agent {
    const p = UpdateAgent.parse(patch);
    this.get(id);
    const cols: Record<string, unknown> = {};
    if (p.rolePrompt !== undefined) cols.role_prompt = p.rolePrompt;
    if (p.modelId !== undefined) {
      if (!this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(p.modelId)) throw new NotFoundError(`model ${p.modelId} does not exist`);
      cols.model_id = p.modelId;
    }
    if (p.workdir !== undefined) cols.workdir = p.workdir;
    if (p.enabled !== undefined) cols.enabled = p.enabled ? 1 : 0;
    if (p.maxRuns !== undefined) cols.max_runs = p.maxRuns;
    if (Object.keys(cols).length) {
      const set = Object.keys(cols).map((k) => `${k} = @${k}`).join(', ');
      this.db.prepare(`UPDATE agents SET ${set} WHERE id = @id`).run({ ...cols, id });
    }
    return this.get(id);
  }
}
