import { MEMORY_LIMIT, type Memory } from '@atlas/shared';
import type { Db } from './store/db.ts';
import { ConflictError } from './kanban.ts';

export const SHARED = 'shared';

/** Small notes per agent, plus one shared by all agents; always in the system prompt (design §8). */
export class Memories {
  constructor(private db: Db) {}

  get(agentId: string): Memory {
    const r = this.db.prepare('SELECT * FROM memory WHERE agent_id = ?').get(agentId) as
      | { agent_id: string; text: string; updated_by: string; updated_at: string }
      | undefined;
    return r ? { agentId, text: r.text, updatedBy: r.updated_by, updatedAt: r.updated_at } : { agentId, text: '', updatedBy: '', updatedAt: null };
  }

  set(agentId: string, text: string, by: string): Memory {
    if (text.length > MEMORY_LIMIT)
      throw new ConflictError(`memory is limited to ${MEMORY_LIMIT} characters (got ${text.length}): shorten or merge entries`);
    this.db
      .prepare(
        `INSERT INTO memory (agent_id, text, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(agentId, text, by, new Date().toISOString());
    return this.get(agentId);
  }
}
