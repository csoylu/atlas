import { z } from 'zod';
import { MEMORY_LIMIT } from '@atlas/shared';
import type { Kanban } from './kanban.ts';
import type { Memories } from './memory.ts';
import { describeWhen, type Schedules } from './schedules.ts';
import { SHARED } from './memory.ts';
import type { ToolSpec } from './providers/types.ts';

export interface TeamToolContext {
  kanban: Kanban;
  memories: Memories;
  schedules: Schedules;
  agentId: string;
  cardId: string;
  /** Get the card's agent to read a new message (chat run, or next turn of a running one). */
  deliver(cardId: string): void;
}

interface TeamTool<S extends z.ZodType> {
  description: string;
  input: S;
  run(input: z.infer<S>, ctx: TeamToolContext): string;
}
const tool = <S extends z.ZodType>(t: TeamTool<S>) => t;

export const TEAM_TOOLS = {
  memory_edit: tool({
    description:
      `Edit your memory (always in your instructions, max ${MEMORY_LIMIT} chars) or the memory shared by all agents. ` +
      'Keep durable facts only: conventions, Can\'s preferences, where things are. Not progress or logs. ' +
      'mode replace rewrites it whole (use it to prune), append adds a line.',
    input: z.object({
      scope: z.enum(['self', 'shared']).default('self'),
      mode: z.enum(['replace', 'append']).default('append'),
      text: z.string(),
    }),
    run: ({ scope, mode, text }, { memories, agentId }) => {
      const id = scope === 'shared' ? SHARED : agentId;
      const cur = memories.get(id).text;
      const next = mode === 'replace' ? text : cur ? `${cur}\n${text}` : text;
      const m = memories.set(id, next.trim(), agentId);
      return `${scope} memory saved (${m.text.length}/${MEMORY_LIMIT} chars)`;
    },
  }),
  card_message: tool({
    description:
      'Write in another card\'s chat (e.g. to ask the agent working on it a question or hand over information). ' +
      'Its agent reads it and replies there; the reply does not come back to you automatically.',
    input: z.object({ id: z.string(), text: z.string().min(1) }),
    run: ({ id, text }, ctx) => {
      if (id === ctx.cardId) throw new Error('that is your own card: just answer here');
      ctx.kanban.appendMessage(id, 'user', ctx.agentId, [{ type: 'text', text: `[from @${ctx.agentId}, card ${ctx.cardId}] ${text}` }]);
      ctx.deliver(id);
      return `message posted on ${id}`;
    },
  }),
  schedule_list: tool({
    description: 'List schedules: what runs when, for which agent, and the card each one last posted on.',
    input: z.object({}),
    run: (_i, { schedules }) => {
      const all = schedules.list();
      if (!all.length) return '(no schedules)';
      return all
        .map((s) =>
          [
            `${s.id} @${s.agentId} "${s.title}": ${describeWhen(s)}`,
            s.enabled ? `next ${s.nextRunAt}` : 'disabled',
            s.createCard ? 'new card each time' : `own card ${s.chatCardId ?? '(created on first run)'}`,
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
      'new_card_each_time: true = a fresh card per run; false (default) = one card for the schedule, reopened each run, ' +
      'so the agent sees what earlier runs did. Tell Can what you scheduled.',
    input: z.object({
      prompt: z.string().min(1),
      title: z.string().max(200).optional(),
      cron: z.string().optional(),
      at: z.string().optional(),
      timezone: z.string().optional(),
      agent: z.string().optional(),
      new_card_each_time: z.boolean().default(false),
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
          createCard: i.new_card_each_time,
        },
        agentId,
      );
      return `scheduled ${s.id} "${s.title}" for @${s.agentId}: ${describeWhen(s)}, first run ${s.nextRunAt}`;
    },
  }),
  schedule_delete: tool({
    description: 'Delete a schedule by id. Its cards stay.',
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

export const isTeamTool = (name: string) => name in TEAM_TOOLS;

export function runTeamTool(name: string, input: unknown, ctx: TeamToolContext): { output: string; isError: boolean } {
  const t = (TEAM_TOOLS as Record<string, TeamTool<z.ZodType>>)[name]!;
  const parsed = t.input.safeParse(input);
  if (!parsed.success) return { output: `invalid input for ${name}: ${parsed.error.message}`, isError: true };
  try {
    return { output: t.run(parsed.data, ctx), isError: false };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}
