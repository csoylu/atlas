import { z } from 'zod';
import { MEMORY_BUDGET, MEMORY_BUDGET_GLOBAL, MEMORY_TEXT_MAX, MemoryKind, MemoryScope, ProposalAction, type Card, type Memory, type MemoryProposal, type ProposalStatus } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import type { Agents } from './agents.ts';
import { ConflictError, InvalidError, NotFoundError, type Kanban } from './kanban.ts';
import { GLOBAL, kindTag, memoryRef, parseMemoryRef, SHARED, type Memories } from './memory.ts';
import { localTimeZone, type Workflows } from './workflows.ts';
import type { ToolSpec } from './providers/types.ts';

/**
 * Weekly memory cleanup (#83, design §8). A built-in schedule gives an agent a fresh card each week; on that card it
 * gets two more tools: memory_review (every memory of every agent) and memory_propose (one change). Proposals wait in
 * SQLite; the card's Inbox item lists them, the user approves or rejects each one. Approving applies it in one
 * transaction; nothing changes before that.
 */
export const CLEANUP_SCHEDULE = 'sch_memory_cleanup';
/** Workflows act as 'workflow:<id>' (#170); cards from before were created by 'schedule:<id>'. */
export const CLEANUP_BY = 'workflow:' + CLEANUP_SCHEDULE;
export const isCleanupCard = (card: Pick<Card, 'createdBy'>) => card.createdBy === CLEANUP_BY || card.createdBy === 'schedule:' + CLEANUP_SCHEDULE;

export const CLEANUP_PROMPT = [
  "Weekly memory cleanup. Call memory_review to read this project's memories (and the global ones), then file one memory_propose per change:",
  '- merge duplicates and near-duplicates into one clear text (≤ 500 chars; keep every specific detail);',
  '- resolve contradictions: say which memory wins and why (if you cannot tell, propose archiving the older one and say so);',
  '- archive stale or obsolete memories: task notes of finished tasks, facts about work that is over;',
  '- fix a wrong kind (a fact filed as a rule…) or scope (an agent memory every agent needs → shared; a shared one only one agent uses → agent:<id>);',
  '- where an always-on total is near its budget, propose merges, or kind fact for long rules that are only sometimes relevant.',
  'Skip what is pending or was rejected (memory_review lists them). Change nothing yourself: no memory_add, memory_update or',
  'memory_forget in this run. Master approves or rejects each proposal in the Inbox. Nothing to clean up is a fine result.',
  'End with task_complete: one line, the number of proposals by type.',
].join('\n');

interface Row {
  id: number;
  card_id: string;
  action: MemoryProposal['action'];
  memory_ids: string;
  text: string | null;
  kind: MemoryKind | null;
  scope: string | null;
  reason: string;
  status: ProposalStatus;
  created_by: string;
  created_at: string;
  decided_at: string | null;
}

export const proposalRef = (id: number) => `p${id}`;

export const ProposeInput = z
  .object({
    action: ProposalAction,
    ids: z.array(z.union([z.string(), z.number().int()])).min(1).describe('memory ids, e.g. ["m3", "m7"]; merge: the first one is kept'),
    text: z.string().trim().min(1).max(MEMORY_TEXT_MAX).optional().describe('merge (required) and update: the new text'),
    kind: MemoryKind.optional().describe('merge and update: a new kind'),
    scope: MemoryScope.optional().describe("merge and update: a new scope in this project, shared or agent:<id> (global: Master's call, not a proposal)"),
    reason: z.string().trim().min(1).max(500).describe('why, in one sentence Master can judge'),
  })
  .strict();
export type ProposeInput = z.infer<typeof ProposeInput>;

export class MemoryCleanup {
  constructor(
    private db: Db,
    private bus: Bus,
    private memories: Memories,
  ) {}

  /** The built-in one-step workflow, created at startup if missing (Mondays 09:00, engine's zone): turn it off to stop it. */
  ensureSchedule(workflows: Workflows, agents: Agents): void {
    if (this.db.prepare('SELECT 1 FROM workflows WHERE id = ?').get(CLEANUP_SCHEDULE)) return;
    const all = agents.list();
    const agent = all.find((a) => a.id === 'atlas') ?? all[0];
    if (!agent) return;
    workflows.createOneStep(
      { agentId: agent.id, title: 'Memory cleanup', prompt: CLEANUP_PROMPT, kind: 'cron', cron: '0 9 * * 1', timezone: localTimeZone(), createCard: true },
      'system',
      CLEANUP_SCHEDULE,
    );
  }

  get(id: number): MemoryProposal {
    const r = this.db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`proposal ${proposalRef(id)} not found`);
    return this.toProposal(r);
  }

  /** A card's proposals in order, or every pending one. */
  list(o: { cardId?: string; status?: ProposalStatus } = {}): MemoryProposal[] {
    const where: string[] = [];
    const args: string[] = [];
    if (o.cardId) where.push('card_id = ?'), args.push(o.cardId);
    if (o.status) where.push('status = ?'), args.push(o.status);
    const rows = this.db.prepare(`SELECT * FROM memory_proposals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`).all(...args) as Row[];
    return rows.map((r) => this.toProposal(r));
  }

  /** File a proposal. The same pending proposal again (a resumed run re-sending its call) returns the existing one. */
  propose(cardId: string, input: ProposeInput, by: string): { proposal: MemoryProposal; existed: boolean } {
    const p = ProposeInput.parse(input);
    const ids = [...new Set(p.ids.map(parseMemoryRef))];
    // The cleanup card's project and the global ones only (#215): another project's memory is « not found ».
    const projectId = this.projectOfCard(cardId);
    for (const id of ids) {
      const m = this.memories.get(id);
      if (m.scope !== GLOBAL && m.projectId !== projectId) throw new NotFoundError(`memory ${memoryRef(id)} not found`);
    }
    if (p.scope === GLOBAL) throw new InvalidError('moving a memory to global is Master\'s call: not a proposal');
    if (p.action === 'merge' && ids.length < 2) throw new InvalidError('merge needs at least two memories');
    if (p.action === 'merge' && !p.text) throw new InvalidError('merge needs the merged text');
    if (p.action === 'update' && ids.length !== 1) throw new InvalidError('update is about one memory: use merge for several');
    if (p.action === 'update' && !p.text && !p.kind && !p.scope) throw new InvalidError('update needs a new text, kind or scope');
    if (p.action === 'archive' && (p.text || p.kind || p.scope)) throw new InvalidError('archive takes only ids and a reason');
    for (const id of ids) if (this.memories.get(id).status === 'archived') throw new ConflictError(`${memoryRef(id)} is archived already`);
    const [text, kind, scope] = [p.text ?? null, p.kind ?? null, p.scope ?? null];
    const result = this.db.transaction(() => {
      const same = this.db
        .prepare("SELECT id FROM memory_proposals WHERE status = 'pending' AND action = ? AND memory_ids = ? AND text IS ? AND kind IS ? AND scope IS ?")
        .get(p.action, JSON.stringify(ids), text, kind, scope) as { id: number } | undefined;
      if (same) return { id: same.id, existed: true };
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO memory_proposals (card_id, action, memory_ids, text, kind, scope, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(cardId, p.action, JSON.stringify(ids), text, kind, scope, p.reason, by, new Date().toISOString());
      return { id: Number(lastInsertRowid), existed: false };
    })();
    return { proposal: result.existed ? this.get(result.id) : this.emit(result.id), existed: result.existed };
  }

  /**
   * Apply it, in one transaction. Refused (nothing changes) when a memory changed since the proposal: it was written
   * about another text.
   */
  approve(id: number, by: string): MemoryProposal {
    const p = this.get(id);
    try {
      this.db.transaction(() => {
        this.checkPending(id);
        const changed = this.db
          .prepare(
            `SELECT DISTINCT memory_id FROM memory_changes WHERE memory_id IN (${p.memoryIds.map(() => '?').join(', ')}) AND at > ? AND action != 'confirm' ORDER BY memory_id`,
          )
          .all(...p.memoryIds, p.createdAt) as { memory_id: number }[];
        if (changed.length)
          throw new ConflictError(`${changed.map((c) => memoryRef(c.memory_id)).join(', ')} changed after this proposal: reject it, the next cleanup looks again`);
        // A new scope stays in the cleanup card's project (a global memory moved to shared lands there).
        const edit = {
          ...(p.text ? { text: p.text } : {}),
          ...(p.kind ? { kind: p.kind } : {}),
          ...(p.scope ? { scope: p.scope, ...(p.scope !== GLOBAL ? { projectId: this.projectOfCard(p.cardId) } : {}) } : {}),
        };
        const [first, ...rest] = p.memoryIds;
        if (p.action === 'archive') for (const m of p.memoryIds) this.memories.forget(m, by);
        else {
          // Archive first: a merge's budget check then sees the others gone.
          for (const m of rest) this.memories.forget(m, by);
          this.memories.update(first!, { ...edit, status: 'active' }, by);
        }
        this.db.prepare("UPDATE memory_proposals SET status = 'approved', decided_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      })();
    } catch (e) {
      // Rolled back: the memory.updated events sent inside the transaction described changes that never happened.
      for (const m of p.memoryIds) this.bus.emit({ type: 'memory.updated', memory: this.memories.get(m) });
      throw e;
    }
    return this.emit(id);
  }

  reject(id: number): MemoryProposal {
    this.db.transaction(() => {
      this.checkPending(id);
      this.db.prepare("UPDATE memory_proposals SET status = 'rejected', decided_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    })();
    return this.emit(id);
  }

  /** The project of a cleanup card (the default project when the card is gone). */
  private projectOfCard(cardId: string): string {
    const r = this.db.prepare('SELECT project_id FROM cards WHERE id = ?').get(cardId) as { project_id: string | null } | undefined;
    return r?.project_id ?? (this.db.prepare("SELECT id FROM projects WHERE status = 'active' ORDER BY created_at, rowid LIMIT 1").get() as { id: string }).id;
  }

  /**
   * What memory_review shows: the live memories of one project and the global ones, by scope, the always-on totals of
   * its members, its pending and recently rejected proposals. Nothing of another project (#215).
   */
  review(projectId: string, cardRef: (id: string) => string): string {
    const rows = this.memories.list().filter((m) => m.status !== 'archived' && (m.scope === GLOBAL || m.projectId === projectId));
    const agentIds = (this.db.prepare('SELECT agent_id FROM project_members WHERE project_id = ? ORDER BY agent_id').all(projectId) as { agent_id: string }[]).map((r) => r.agent_id);
    const name = (this.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined)?.name ?? projectId;
    const cardStatus = this.db.prepare('SELECT status FROM cards WHERE id = ?');
    const line = (m: Memory) => {
      const card = m.cardId ? (cardStatus.get(m.cardId) as { status: string } | undefined) : undefined;
      const tags = [
        memoryRef(m.id),
        kindTag(m.kind),
        ...(m.pinned ? ['pinned'] : []),
        ...(m.status !== 'active' ? [m.status] : []),
        `confirmed ${m.confirmedAt.slice(0, 10)}`,
        ...(m.cardId ? [`task ${cardRef(m.cardId)} ${card?.status ?? 'deleted'}`] : []),
      ];
      return `- [${tags.join(' · ')}] ${m.text}`;
    };
    const scopes = [GLOBAL, SHARED, ...agentIds.map((a) => `agent:${a}`), ...new Set(rows.map((m) => m.scope))].filter((s, i, all) => all.indexOf(s) === i);
    const out: string[] = [
      `${rows.length} memories of project ${name} and global ones (active and stale; archived ones left out). Always-on = rules, preferences and pinned, ${MEMORY_BUDGET} chars per agent in a project: global + ${name} + its own (global at most ${MEMORY_BUDGET_GLOBAL}).`,
    ];
    for (const s of scopes) {
      const list = rows.filter((m) => m.scope === s).sort((a, b) => a.id - b.id);
      if (!list.length) continue;
      const agent = s.startsWith('agent:') ? s.slice('agent:'.length) : null;
      const title =
        s === GLOBAL
          ? `## global (Master's own, every project: ${this.memories.usedGlobal()}/${MEMORY_BUDGET_GLOBAL} chars)`
          : s === SHARED
            ? `## shared (${name})`
            : `## ${s} in ${name}${agent ? ` (always-on of @${agent}: ${this.memories.used({ agentId: agent, projectId })}/${MEMORY_BUDGET} chars)` : ''}`;
      out.push('', title, ...list.map(line));
    }
    const mine = (p: MemoryProposal) => this.projectOfCard(p.cardId) === projectId;
    const describe = (p: MemoryProposal) =>
      `- ${proposalRef(p.id)} ${p.action} ${p.memoryIds.map(memoryRef).join(' + ')}${p.kind ? ` kind ${p.kind}` : ''}${p.scope ? ` scope ${p.scope}` : ''}${p.text ? `: "${p.text}"` : ''} (${p.reason})`;
    const pending = this.list({ status: 'pending' }).filter(mine);
    const since = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
    const rejected = this.list({ status: 'rejected' }).filter((p) => mine(p) && (p.decidedAt ?? '') >= since);
    if (pending.length) out.push('', 'Pending (waiting for Master: do not propose again):', ...pending.map(describe));
    if (rejected.length) out.push('', 'Rejected by Master in the last 90 days (do not propose again):', ...rejected.map(describe));
    return out.join('\n');
  }

  private checkPending(id: number): void {
    const r = this.db.prepare('SELECT status FROM memory_proposals WHERE id = ?').get(id) as { status: ProposalStatus } | undefined;
    if (!r) throw new NotFoundError(`proposal ${proposalRef(id)} not found`);
    if (r.status !== 'pending') throw new ConflictError(`proposal ${proposalRef(id)} was ${r.status} already`);
  }

  private toProposal(r: Row): MemoryProposal {
    const ids = JSON.parse(r.memory_ids) as number[];
    return {
      id: r.id,
      cardId: r.card_id,
      action: r.action,
      memoryIds: ids,
      text: r.text,
      kind: r.kind,
      scope: r.scope,
      reason: r.reason,
      status: r.status,
      createdBy: r.created_by,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
      memories: ids.flatMap((id) => {
        try {
          return [this.memories.get(id)];
        } catch (e) {
          if (e instanceof NotFoundError) return [];
          throw e;
        }
      }),
    };
  }

  private emit(id: number): MemoryProposal {
    const proposal = this.get(id);
    this.bus.emit({ type: 'memory.proposal', proposal });
    return proposal;
  }
}

/* ── The two tools of a cleanup card ─────────────────────────────────────────────────────────────── */

export interface CleanupToolContext {
  cleanup: MemoryCleanup;
  kanban: Kanban;
  agents: Agents;
  agentId: string;
  cardId: string;
}

const TOOLS = {
  memory_review: {
    description:
      "Every memory of this task's project and the global ones (active and stale), by scope, with always-on totals, and the proposals pending or rejected. Read it before proposing.",
    input: z.object({}),
    run: (_i: unknown, ctx: CleanupToolContext) => ctx.cleanup.review(ctx.kanban.get(ctx.cardId).projectId, (id) => ctx.kanban.ref(id)),
  },
  memory_propose: {
    description:
      'Propose one memory change for Master to approve in the Inbox (nothing changes before). action: merge (ids: the first ' +
      'is kept with text, and kind/scope if given; the others are archived), update (one id: new text, kind and/or scope), ' +
      'archive (ids). reason: one sentence Master can judge (duplicate of…, contradicts…, task done…).',
    input: ProposeInput,
    run: (i: ProposeInput, ctx: CleanupToolContext) => {
      const { proposal: p, existed } = ctx.cleanup.propose(ctx.cardId, i, ctx.agentId);
      return `${existed ? 'already proposed' : 'proposed'} ${proposalRef(p.id)}: ${p.action} ${p.memoryIds.map(memoryRef).join(' + ')}`;
    },
  },
};

export function cleanupToolSpecs(): ToolSpec[] {
  return Object.entries(TOOLS).map(([name, t]) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
    return { name, description: t.description, input_schema: schema };
  });
}

export const isCleanupTool = (name: string) => name in TOOLS;

export function runCleanupTool(name: string, input: unknown, ctx: CleanupToolContext): { output: string; isError: boolean } {
  const t = TOOLS[name as keyof typeof TOOLS] as { input: z.ZodType; run(i: unknown, ctx: CleanupToolContext): string };
  const parsed = t.input.safeParse(input);
  if (!parsed.success) return { output: `invalid input for ${name}: ${parsed.error.message}`, isError: true };
  try {
    return { output: t.run(parsed.data, ctx), isError: false };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}
