import { join, resolve } from 'node:path';
import { CreateAgent, UpdateAgent, type Agent } from '@atlas/shared';
import type { Db } from './store/db.ts';
import { ConflictError, NotFoundError } from './kanban.ts';

interface AgentRow {
  id: string;
  role_prompt: string;
  model_id: string;
  workdir: string | null;
  enabled: number;
  max_runs: number;
}
const toAgent = (r: AgentRow): Agent => ({
  id: r.id,
  rolePrompt: r.role_prompt,
  modelId: r.model_id,
  workdir: r.workdir,
  enabled: r.enabled === 1,
  maxRuns: r.max_runs,
});

/** An agent's working directory: its configured path, or data/workspaces/<id>. */
export function workdirOf(agent: Pick<Agent, 'id' | 'workdir'>, dataDir: string): string {
  return resolve(agent.workdir ?? join(dataDir, 'workspaces', agent.id));
}

export class Agents {
  constructor(private db: Db) {}

  list(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY id').all() as AgentRow[]).map(toAgent);
  }

  get(id: string): Agent {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    if (!row) throw new NotFoundError(`agent ${id} does not exist`);
    return toAgent(row);
  }

  create(input: CreateAgent): Agent {
    const c = CreateAgent.parse(input);
    if (this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(c.id)) throw new ConflictError(`agent ${c.id} already exists`);
    if (!this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(c.modelId)) throw new ConflictError(`model ${c.modelId} does not exist`);
    this.db
      .prepare('INSERT INTO agents (id, role_prompt, model_id, workdir, max_runs) VALUES (?, ?, ?, ?, ?)')
      .run(c.id, c.rolePrompt, c.modelId, c.workdir, c.maxRuns);
    return this.get(c.id);
  }

  /** Delete an agent. Refused while open cards are assigned to it, or it triages (reassign first). */
  remove(id: string): void {
    this.get(id);
    const cards = this.db.prepare("SELECT id FROM cards WHERE assignee = ? AND status NOT IN ('done', 'archived')").all(id) as { id: string }[];
    if (cards.length) throw new ConflictError(`@${id} still has open cards: ${cards.map((c) => c.id).join(', ')}`);
    if (this.db.prepare("SELECT 1 FROM settings WHERE key = 'triage_agent' AND value = ?").get(id))
      throw new ConflictError(`@${id} is the triage agent: pick another one first`);
    this.db.transaction(() => {
      // Their direct chat goes with them (kept in the database, archived).
      this.db.prepare("UPDATE cards SET status = 'archived' WHERE board = 'direct' AND assignee = ?").run(id);
      this.db.prepare("UPDATE cards SET assignee = NULL WHERE assignee = ?").run(id);
      this.db.prepare('DELETE FROM memory WHERE agent_id = ?').run(id);
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
