import { z } from 'zod';
import { currentToolName, MEMORY_BUDGET, MEMORY_BUDGET_GLOBAL, MEMORY_TEXT_MAX, MemoryKind, TODO_LIMIT, TodoItem, type Memory } from '@atlas/shared';
import { renderTodos } from './context.ts';
import type { Kanban } from './kanban.ts';
import { agentScope, GLOBAL, inView, kindTag, memoryRef, parseMemoryRef, SHARED, type Memories, type Source, type View } from './memory.ts';
import { describeTrigger, oneStep, type Workflows } from './workflows.ts';
import type { ToolSpec } from './providers/types.ts';
import { ProjectArg } from './cardTools.ts';

export interface TeamToolContext {
  kanban: Kanban;
  memories: Memories;
  workflows: Workflows;
  agentId: string;
  cardId: string;
  /** The board card being worked on (null in a direct chat): project memories belong to it. */
  workCard?: string | null;
  /** The message the tool call is in: where a new memory was learned. */
  source?: Source | null;
  /** Get the card's agent to read a new message (chat run, or next turn of a running one). */
  deliver(cardId: string): void;
}

const memoryId = z.union([z.string(), z.number().int()]).describe('memory id, e.g. m12');
const scopeName = (m: Memory) => (m.scope === SHARED ? 'shared' : m.scope === GLOBAL ? 'global' : 'yours');
const memoryLine = (m: Memory) =>
  `- [${memoryRef(m.id)} · ${kindTag(m.kind)} · ${scopeName(m)}${m.status !== 'active' ? ` · ${m.status}` : ''} · ${m.confirmedAt.slice(0, 10)}] ${m.text}`;
/** The run's view (#215): this agent in its task's project. */
const viewOf = (ctx: TeamToolContext): View => ({ agentId: ctx.agentId, projectId: ctx.kanban.get(ctx.cardId).projectId });
/** A memory this run may change: a global one, its project's shared ones, its own there. Another project's is « not found ». */
function ownMemory(ctx: TeamToolContext, ref: string | number): Memory {
  const id = parseMemoryRef(ref);
  const m = ctx.memories.get(id);
  if (!inView(m, viewOf(ctx))) {
    // Another agent's or another project's memory: say no more than that it isn't yours to change.
    if (m.projectId === viewOf(ctx).projectId) throw new Error(`${memoryRef(m.id)} belongs to ${m.scope}: you can change only yours, shared and global ones`);
    throw new Error(`memory ${memoryRef(id)} not found`);
  }
  return m;
}
/** self / shared / global → the stored scope. */
const scopeOf = (s: 'self' | 'shared' | 'global', agentId: string) => (s === 'shared' ? SHARED : s === 'global' ? GLOBAL : agentScope(agentId));
const budgetNote = (ctx: TeamToolContext) =>
  ` · always-on ${ctx.memories.used(viewOf(ctx))}/${MEMORY_BUDGET} chars (global ${ctx.memories.usedGlobal()}/${MEMORY_BUDGET_GLOBAL})`;
const ScopeArg = z
  .enum(['self', 'shared', 'global'])
  .describe("self: you in this project; shared: every agent of this project; global: the user's own rules and preferences, for every project");

interface TeamTool<S extends z.ZodType> {
  description: string;
  input: S;
  run(input: z.infer<S>, ctx: TeamToolContext): string;
}
const tool = <S extends z.ZodType>(t: TeamTool<S>) => t;

export const TEAM_TOOLS = {
  todo_write: tool({
    description:
      'Your todo list for this conversation: plan multi-step work and track it. Send the FULL list each call (it replaces ' +
      'the previous one): items {content, status: pending | in_progress | completed}, one in_progress at a time. Mark ' +
      'items completed as you finish them. It survives context compaction. Skip it for small, one-step tasks.',
    input: z.object({ todos: z.array(TodoItem).max(TODO_LIMIT) }),
    run: ({ todos }, { kanban, cardId }) => {
      kanban.setTodos(cardId, todos);
      if (!todos.length) return 'todo list cleared';
      const done = todos.filter((t) => t.status === 'completed').length;
      return `todo list saved (${done}/${todos.length} done):\n${renderTodos(todos)}`;
    },
  }),
  memory_add: tool({
    description:
      `Save one durable memory (one idea, ≤ ${MEMORY_TEXT_MAX} chars). kind: rule (how to work) and preference (the user's) are ` +
      `always in your instructions (budget ${MEMORY_BUDGET} chars: global + this project + yours, global at most ${MEMORY_BUDGET_GLOBAL}); ` +
      'fact (where things are, how things work) and project (task notes: about the current task, stale when it ends) are ' +
      'recalled when a conversation matches them. scope: self (you, in this project) or shared (every agent of this ' +
      "project: its repo, setup, conventions); global only for the user's own rules and preferences that hold in every " +
      'project (how they want to be addressed, how they like to work), never for facts about one repo. Not progress or ' +
      'logs. If similar memories exist, nothing is saved and they are listed: call again with update: <id> to change one, ' +
      'or new: true if yours is really different.',
    input: z.object({
      kind: MemoryKind,
      scope: ScopeArg.default('self'),
      text: z.string().trim().min(1).max(MEMORY_TEXT_MAX),
      update: memoryId.optional().describe('id of a similar memory to replace with this text'),
      new: z.boolean().optional().describe('true: save even though similar memories exist'),
    }),
    run: (i, ctx) => {
      const view = viewOf(ctx);
      if (i.update !== undefined) {
        const m = ctx.memories.update(ownMemory(ctx, i.update).id, { text: i.text, kind: i.kind }, ctx.agentId);
        return `updated ${memoryRef(m.id)} (${kindTag(m.kind)}, ${scopeName(m)})${budgetNote(ctx)}`;
      }
      const scope = scopeOf(i.scope, ctx.agentId);
      if (!i.new) {
        const similar = ctx.memories.similar(view, i.text);
        if (similar.length)
          throw new Error(
            ['Nothing saved: similar memories exist.', ...similar.map(memoryLine), 'Call memory_add again with update: <id> to replace one, or new: true if yours is different.'].join('\n'),
          );
      }
      const m = ctx.memories.add(
        { kind: i.kind, scope, ...(scope === GLOBAL ? {} : { projectId: view.projectId }), text: i.text, cardId: i.kind === 'project' ? ctx.workCard : null },
        ctx.agentId,
        ctx.source,
      );
      return `saved ${memoryRef(m.id)} (${kindTag(m.kind)}, ${scopeName(m)}${m.cardId ? `, until ${ctx.kanban.ref(m.cardId)} ends` : ''})${budgetNote(ctx)}`;
    },
  }),
  memory_update: tool({
    description:
      'Rewrite one of your, this project\'s shared or the global memories (id like m12). The same text again just confirms ' +
      "it is still true. scope moves it: self (you in this project), shared (this project), global (only the user's own " +
      'rules and preferences that hold in every project).',
    input: z.object({ id: memoryId, text: z.string().trim().min(1).max(MEMORY_TEXT_MAX), kind: MemoryKind.optional(), scope: ScopeArg.optional() }),
    run: ({ id, text, kind, scope }, ctx) => {
      const before = ownMemory(ctx, id);
      const to = scope ? scopeOf(scope, ctx.agentId) : before.scope;
      const move = to !== before.scope ? { scope: to, ...(to !== GLOBAL ? { projectId: viewOf(ctx).projectId } : {}) } : {};
      const m = ctx.memories.update(before.id, { text, ...(kind ? { kind } : {}), ...move, ...(before.status !== 'active' ? { status: 'active' as const } : {}) }, ctx.agentId);
      const same = m.text === before.text && m.kind === before.kind && m.scope === before.scope && before.status === 'active';
      return `${same ? 'confirmed' : 'updated'} ${memoryRef(m.id)}${m.scope !== before.scope ? ` (now ${scopeName(m)})` : ''}${budgetNote(ctx)}`;
    },
  }),
  memory_forget: tool({
    description: 'Forget a memory that is wrong or outdated (id like m12). It is archived, the user can restore it.',
    input: z.object({ id: memoryId }),
    run: ({ id }, ctx) => {
      const m = ctx.memories.forget(ownMemory(ctx, id).id, ctx.agentId);
      return `forgot ${memoryRef(m.id)}${budgetNote(ctx)}`;
    },
  }),
  memory_search: tool({
    description: "Search your, this project's shared and the global memories by keywords (facts and task notes not recalled in your instructions, stale ones too).",
    input: z.object({ query: z.string().trim().min(1) }),
    run: ({ query }, ctx) => {
      const found = ctx.memories.search(viewOf(ctx), query);
      return found.length ? found.map(memoryLine).join('\n') : `no memory matches "${query}"`;
    },
  }),
  task_message: tool({
    description:
      'Write in another task\'s chat (e.g. to ask the agent working on it a question or hand over information). ' +
      'Its agent reads it and replies there; the reply does not come back to you automatically.',
    input: z.object({ id: z.union([z.string(), z.number().int()]).transform(String).describe('task number (#12 or 12) or id'), text: z.string().min(1) }),
    run: ({ id: ref, text }, ctx) => {
      const id = ctx.kanban.reach(ctx.agentId, ctx.cardId, ctx.kanban.resolve(ref)).id;
      if (id === ctx.cardId) throw new Error('that is your own task: just answer here');
      ctx.kanban.appendMessage(id, 'user', ctx.agentId, [{ type: 'text', text: `[from @${ctx.agentId}, task ${ctx.kanban.ref(ctx.cardId)}] ${text}` }]);
      ctx.deliver(id);
      return `message posted on ${ctx.kanban.ref(id)}`;
    },
  }),
  agent_message: tool({
    description:
      'Write to another agent, even one with no task. It lands in its one active task if it has exactly one, else in ' +
      'its main chat, and wakes it. When it has answered, its answer comes back here as a note ("reply from @agent: …").',
    input: z.object({ agent: z.string().trim().min(1).describe('agent id, e.g. zurich'), text: z.string().trim().min(1) }),
    run: ({ agent, text }, ctx) => {
      const to = agent.replace(/^@/, '');
      ctx.kanban.reachAgent(ctx.agentId, ctx.cardId, to);
      const target = ctx.kanban.sendAgentMessage(ctx.agentId, ctx.cardId, to, text);
      ctx.deliver(target.id);
      return `message sent to @${to} (${target.board === 'direct' ? 'its main chat' : `its task ${ctx.kanban.ref(target.id)}`}); its answer will come back here`;
    },
  }),
  // Schedules are one-step workflows since #170 (« trigger → one agent step »): same tools, same inputs.
  schedule_list: tool({
    description: "List this project's schedules (and global ones): what runs when, for which agent, and the task each one last posted on.",
    input: z.object({ project: ProjectArg }),
    run: ({ project }, { workflows, kanban, agentId, cardId }) => {
      const all = workflows.list({ project: kanban.scope(agentId, cardId, project) });
      if (!all.length) return '(no schedules)';
      return all
        .map((w) => {
          const one = oneStep(w);
          const trigger = w.nodes.find((n) => n.kind === 'trigger')!;
          const agent = one?.step.config.agentId ?? w.nodes.flatMap((n) => (n.kind === 'agent' && n.config.agentId ? [n.config.agentId] : []))[0] ?? 'nobody';
          const last = w.lastRun;
          return [
            `${w.id} @${agent} "${w.name}": ${trigger.kind === 'trigger' ? describeTrigger(trigger.config) : ''}`,
            w.enabled ? (w.nextRunAt ? `next ${w.nextRunAt}` : 'no next run') : 'disabled',
            one
              ? one.step.config.newTaskEachRun
                ? 'new task each time'
                : `own task ${((own) => (own ? kanban.ref(own) : '(created on first run)'))(workflows.ownTask(w.id, one.step.id))}`
              : `workflow of ${w.nodes.length - 1} steps (edit it in Workflows, not with these tools)`,
            last && last.state === 'failed' ? `LAST RUN FAILED: ${last.reason}` : '',
            w.lastError ? `LAST RUN FAILED: ${w.lastError}` : '',
          ]
            .filter(Boolean)
            .join(' · ');
        })
        .join('\n');
    },
  }),
  schedule_create: tool({
    description:
      'Schedule a prompt for an agent (yourself by default): cron for repeating (5 fields, e.g. "0 9 * * 1-5" = ' +
      'weekdays 09:00, in timezone; default the engine\'s zone) or at for once (ISO time with offset). ' +
      'new_task_each_time: true = a fresh task per run; false (default) = one task for the schedule, reopened each run, ' +
      'so the agent sees what earlier runs did. Tell the user what you scheduled.',
    input: z.object({
      prompt: z.string().min(1),
      title: z.string().max(200).optional(),
      cron: z.string().optional(),
      at: z.string().optional(),
      timezone: z.string().optional(),
      agent: z.string().optional(),
      new_task_each_time: z.boolean().default(false),
      project: ProjectArg,
    }),
    run: (i, { workflows, agentId, kanban, cardId }) => {
      if (!!i.cron === !!i.at) throw new Error('give exactly one of cron or at');
      const w = workflows.createOneStep(
        {
          agentId: (i.agent ?? agentId).replace(/^@/, ''),
          title: i.title,
          prompt: i.prompt,
          kind: i.cron ? 'cron' : 'at',
          cron: i.cron ?? null,
          at: i.at ?? null,
          timezone: i.timezone,
          createCard: i.new_task_each_time,
          projectId: kanban.scope(agentId, cardId, i.project),
        },
        agentId,
      );
      const one = oneStep(w)!;
      return `scheduled ${w.id} "${w.name}" for @${one.step.config.agentId}: ${describeTrigger(one.trigger.config)}, first run ${w.nextRunAt}`;
    },
  }),
  schedule_delete: tool({
    description: 'Delete a schedule by id. Its tasks stay.',
    input: z.object({ id: z.string() }),
    run: ({ id }, { workflows, agentId, kanban, cardId }) => {
      const w = workflows.get(id);
      if (w.projectId) kanban.scope(agentId, cardId, w.projectId);
      if (!oneStep(w)) throw new Error(`${id} is a workflow of several steps: Master deletes it in Workflows`);
      workflows.remove(id, agentId);
      return `schedule ${id} deleted`;
    },
  }),
} satisfies Record<string, TeamTool<z.ZodType>>;

export function teamToolSpecs(): ToolSpec[] {
  return Object.entries(TEAM_TOOLS).map(([name, t]) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
    return { name, description: t.description, input_schema: schema };
  });
}

export const isTeamTool = (name: string) => currentToolName(name) in TEAM_TOOLS;

export function runTeamTool(name: string, input: unknown, ctx: TeamToolContext): { output: string; isError: boolean } {
  const t = (TEAM_TOOLS as Record<string, TeamTool<z.ZodType>>)[currentToolName(name)]!;
  const parsed = t.input.safeParse(input);
  if (!parsed.success) return { output: `invalid input for ${name}: ${parsed.error.message}`, isError: true };
  try {
    return { output: t.run(parsed.data, ctx), isError: false };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}
