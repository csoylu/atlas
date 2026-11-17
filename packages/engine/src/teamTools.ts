import { z } from 'zod';
import { currentToolName, MEMORY_BUDGET, MEMORY_TEXT_MAX, MemoryKind, TODO_LIMIT, TodoItem, type Memory } from '@atlas/shared';
import { renderTodos } from './context.ts';
import type { Kanban } from './kanban.ts';
import { agentScope, memoryRef, parseMemoryRef, SHARED, type Memories, type Source } from './memory.ts';
import { describeWhen, type Schedules } from './schedules.ts';
import type { ToolSpec } from './providers/types.ts';

export interface TeamToolContext {
  kanban: Kanban;
  memories: Memories;
  schedules: Schedules;
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
const memoryLine = (m: Memory) =>
  `- [${memoryRef(m.id)} · ${m.kind} · ${m.scope === SHARED ? 'shared' : 'yours'}${m.status !== 'active' ? ` · ${m.status}` : ''} · ${m.confirmedAt.slice(0, 10)}] ${m.text}`;
/** A memory this agent may change: its own or a shared one. */
function ownMemory(ctx: TeamToolContext, ref: string | number): Memory {
  const m = ctx.memories.get(parseMemoryRef(ref));
  if (m.scope !== SHARED && m.scope !== agentScope(ctx.agentId)) throw new Error(`${memoryRef(m.id)} belongs to ${m.scope}: you can change only yours and shared ones`);
  return m;
}
const budgetNote = (ctx: TeamToolContext) => ` · always-on ${ctx.memories.used(ctx.agentId)}/${MEMORY_BUDGET} chars`;

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
      `always in your instructions (budget ${MEMORY_BUDGET} chars, own + shared); fact (where things are, how things work) and ` +
      'project (about the current task: goes stale when it ends) are recalled when a conversation matches them. ' +
      'scope: self (you, your workdir) or shared (every agent). Not progress or logs. If similar memories exist, nothing is ' +
      'saved and they are listed: call again with update: <id> to change one, or new: true if yours is really different.',
    input: z.object({
      kind: MemoryKind,
      scope: z.enum(['self', 'shared']).default('self'),
      text: z.string().trim().min(1).max(MEMORY_TEXT_MAX),
      update: memoryId.optional().describe('id of a similar memory to replace with this text'),
      new: z.boolean().optional().describe('true: save even though similar memories exist'),
    }),
    run: (i, ctx) => {
      if (i.update !== undefined) {
        const m = ctx.memories.update(ownMemory(ctx, i.update).id, { text: i.text, kind: i.kind }, ctx.agentId);
        return `updated ${memoryRef(m.id)} (${m.kind}, ${m.scope})${budgetNote(ctx)}`;
      }
      const scope = i.scope === 'shared' ? SHARED : agentScope(ctx.agentId);
      if (!i.new) {
        const similar = ctx.memories.similar([agentScope(ctx.agentId), SHARED], i.text);
        if (similar.length)
          throw new Error(
            ['Nothing saved: similar memories exist.', ...similar.map(memoryLine), 'Call memory_add again with update: <id> to replace one, or new: true if yours is different.'].join('\n'),
          );
      }
      const m = ctx.memories.add({ kind: i.kind, scope, text: i.text, cardId: i.kind === 'project' ? ctx.workCard : null }, ctx.agentId, ctx.source);
      return `saved ${memoryRef(m.id)} (${m.kind}, ${m.scope}${m.cardId ? `, until ${ctx.kanban.ref(m.cardId)} ends` : ''})${budgetNote(ctx)}`;
    },
  }),
  memory_update: tool({
    description: 'Rewrite one of your or the shared memories (id like m12). The same text again just confirms it is still true.',
    input: z.object({ id: memoryId, text: z.string().trim().min(1).max(MEMORY_TEXT_MAX), kind: MemoryKind.optional() }),
    run: ({ id, text, kind }, ctx) => {
      const before = ownMemory(ctx, id);
      const m = ctx.memories.update(before.id, { text, ...(kind ? { kind } : {}), ...(before.status !== 'active' ? { status: 'active' as const } : {}) }, ctx.agentId);
      return `${m.text === before.text && m.kind === before.kind && before.status === 'active' ? 'confirmed' : 'updated'} ${memoryRef(m.id)}${budgetNote(ctx)}`;
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
    description: 'Search your and the shared memories by keywords (facts and project notes not recalled in your instructions, stale ones too).',
    input: z.object({ query: z.string().trim().min(1) }),
    run: ({ query }, { memories, agentId }) => {
      const found = memories.search(agentId, query);
      return found.length ? found.map(memoryLine).join('\n') : `no memory matches "${query}"`;
    },
  }),
  task_message: tool({
    description:
      'Write in another task\'s chat (e.g. to ask the agent working on it a question or hand over information). ' +
      'Its agent reads it and replies there; the reply does not come back to you automatically.',
    input: z.object({ id: z.union([z.string(), z.number().int()]).transform(String).describe('task number (#12 or 12) or id'), text: z.string().min(1) }),
    run: ({ id: ref, text }, ctx) => {
      const id = ctx.kanban.resolve(ref);
      if (id === ctx.cardId) throw new Error('that is your own task: just answer here');
      ctx.kanban.appendMessage(id, 'user', ctx.agentId, [{ type: 'text', text: `[from @${ctx.agentId}, task ${ctx.kanban.ref(ctx.cardId)}] ${text}` }]);
      ctx.deliver(id);
      return `message posted on ${ctx.kanban.ref(id)}`;
    },
  }),
  schedule_list: tool({
    description: 'List schedules: what runs when, for which agent, and the task each one last posted on.',
    input: z.object({}),
    run: (_i, { schedules, kanban }) => {
      const all = schedules.list();
      if (!all.length) return '(no schedules)';
      return all
        .map((s) =>
          [
            `${s.id} @${s.agentId} "${s.title}": ${describeWhen(s)}`,
            s.enabled ? `next ${s.nextRunAt}` : 'disabled',
            s.createCard ? 'new task each time' : `own task ${s.chatCardId ? kanban.ref(s.chatCardId) : '(created on first run)'}`,
            s.lastError ? `LAST RUN FAILED: ${s.lastError}` : '',
          ]
            .filter(Boolean)
            .join(' · '),
        )
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
    }),
    run: (i, { schedules, agentId }) => {
      if (!!i.cron === !!i.at) throw new Error('give exactly one of cron or at');
      const s = schedules.create(
        {
          agentId: i.agent ?? agentId,
          title: i.title,
          prompt: i.prompt,
          kind: i.cron ? 'cron' : 'at',
          cron: i.cron ?? null,
          at: i.at ?? null,
          timezone: i.timezone,
          createCard: i.new_task_each_time,
        },
        agentId,
      );
      return `scheduled ${s.id} "${s.title}" for @${s.agentId}: ${describeWhen(s)}, first run ${s.nextRunAt}`;
    },
  }),
  schedule_delete: tool({
    description: 'Delete a schedule by id. Its tasks stay.',
    input: z.object({ id: z.string() }),
    run: ({ id }, { schedules }) => {
      schedules.remove(id);
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
