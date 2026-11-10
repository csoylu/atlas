import { z } from 'zod';
import { BLOCK_KINDS, type Card } from '@atlas/shared';
import type { Kanban } from './kanban.ts';
import type { ToolSpec } from './providers/types.ts';

/** How a card tool ended the run, if it did (design §4: a work run ends only through one of these). */
export type Terminal = 'complete' | 'block' | 'review' | null;

export interface CardToolContext {
  kanban: Kanban;
  agentId: string;
  /** The card this run works on. */
  cardId: string;
}

interface CardTool<S extends z.ZodType> {
  description: string;
  input: S;
  terminal?: Exclude<Terminal, null>;
  run(input: z.infer<S>, ctx: CardToolContext): string;
}
const tool = <S extends z.ZodType>(t: CardTool<S>) => t;

const Editable = z.enum(['triage', 'todo', 'ready', 'archived']);

export function describeCard(c: Card): string {
  const bits = [`${c.id} [${c.status}]`, c.assignee ? `@${c.assignee}` : 'unassigned', `P${c.priority}`, c.title];
  if (c.parents.length) bits.push(`(parents: ${c.parents.join(', ')})`);
  return bits.join(' ');
}

export const CARD_TOOLS = {
  card_list: tool({
    description: 'List cards on the board (archived excluded), optionally filtered by status.',
    input: z.object({ status: z.string().optional() }),
    run: ({ status }, { kanban }) => {
      const cards = kanban.list().filter((c) => !status || c.status === status);
      return cards.length ? cards.map(describeCard).join('\n') : '(no cards)';
    },
  }),
  card_show: tool({
    description: 'Show a card: fields, description, parents, block.',
    input: z.object({ id: z.string() }),
    run: ({ id }, { kanban }) => {
      const c = kanban.get(id);
      return [describeCard(c), c.block ? `blocked (${c.block.kind}): ${c.block.reason}` : '', '', c.body || '(no description)']
        .filter((l, i) => l || i > 1)
        .join('\n');
    },
  }),
  card_create: tool({
    description:
      'Create a card. Give a clear title, a body with context and acceptance criteria, an assignee, and parents for ' +
      'cards that must finish first. Status defaults to ready (it waits in todo automatically while a parent is open).',
    input: z.object({
      title: z.string().min(1).max(200),
      body: z.string().default(''),
      assignee: z.string().nullable().optional(),
      priority: z.number().int().min(0).max(3).default(0),
      parents: z.array(z.string()).default([]),
      status: Editable.default('ready'),
    }),
    run: (i, { kanban, agentId }) => {
      const c = kanban.create({ ...i, assignee: i.assignee ?? null }, agentId);
      return `created ${describeCard(c)}`;
    },
  }),
  card_update: tool({
    description: 'Edit a card: title, body, assignee, priority, parents, or status (triage, todo, ready, archived).',
    input: z.object({
      id: z.string(),
      title: z.string().min(1).max(200).optional(),
      body: z.string().optional(),
      assignee: z.string().nullable().optional(),
      priority: z.number().int().min(0).max(3).optional(),
      parents: z.array(z.string()).optional(),
      status: Editable.optional(),
    }),
    run: ({ id, ...patch }, { kanban, agentId }) => `updated ${describeCard(kanban.update(id, patch, agentId))}`,
  }),
  card_complete: tool({
    description: 'Finish your current card: the work is done and verified. The summary is the handoff (what changed, how it was checked).',
    input: z.object({ summary: z.string().min(1) }),
    terminal: 'complete',
    run: ({ summary }, { kanban, agentId, cardId }) => {
      kanban.update(cardId, { status: 'done' }, agentId);
      kanban.event(cardId, 'completed', { by: agentId, summary });
      return 'card done';
    },
  }),
  card_block: tool({
    description:
      'Stop and wait. kind: needs_input (a question for Can; give options, recommended first), dependency (waiting ' +
      'on other work), capability (missing access or tool), transient (retry later; set retry_in_minutes).',
    input: z.object({
      kind: z.enum(BLOCK_KINDS),
      question: z.string().min(1),
      options: z.array(z.string()).max(4).default([]),
      retry_in_minutes: z.number().positive().max(24 * 60).optional(),
    }),
    terminal: 'block',
    run: ({ kind, question, options, retry_in_minutes }, { kanban, agentId, cardId }) => {
      const until = kind === 'transient' ? new Date(Date.now() + (retry_in_minutes ?? 15) * 60_000).toISOString() : null;
      kanban.block(cardId, { kind, reason: question, options, until }, agentId);
      return `card blocked (${kind})`;
    },
  }),
  card_request_review: tool({
    description: 'Hand the finished work to Can for review. The summary says what to look at and how it was verified.',
    input: z.object({ summary: z.string().min(1) }),
    terminal: 'review',
    run: ({ summary }, { kanban, agentId, cardId }) => {
      kanban.update(cardId, { status: 'review' }, agentId);
      kanban.event(cardId, 'review_requested', { by: agentId, summary });
      return 'review requested';
    },
  }),
  history_search: tool({
    description:
      "Read your own card's full transcript, including parts summarized or omitted from your context to save room. " +
      'query: find messages containing the text (case-insensitive). seq: read one message in full (seq numbers ' +
      'appear in search results and in "#n" references of the summary).',
    input: z
      .object({ query: z.string().min(2).optional(), seq: z.number().int().positive().optional() })
      .refine((i) => i.query || i.seq, 'give a query or a seq'),
    run: ({ query, seq }, { kanban, cardId }) => {
      const messages = kanban.messages(cardId);
      // Earlier searches would match themselves: leave them out.
      const own = new Set(messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_use' && b.name === 'history_search' ? [b.id] : []))));
      const textOf = (m: (typeof messages)[number]) =>
        m.content
          .flatMap((b) => {
            if (b.type === 'text') return [b.text];
            if (b.type === 'tool_use') return own.has(b.id) ? [] : [`→ ${b.name} ${JSON.stringify(b.input)}`];
            if (b.type === 'tool_result') return own.has(b.tool_use_id) ? [] : [`← ${b.content}`];
            return [];
          })
          .join('\n');
      if (seq) {
        const m = messages.find((x) => x.seq === seq);
        if (!m) throw new Error(`no message #${seq} (this transcript has ${messages.length})`);
        const t = textOf(m);
        return `#${m.seq} ${m.author} (${m.at}):\n${t.length > 20_000 ? t.slice(0, 20_000) + `\n… (${t.length - 20_000} more chars)` : t}`;
      }
      const q = query!.toLowerCase();
      const hits = messages.flatMap((m) => {
        const t = textOf(m);
        const i = t.toLowerCase().indexOf(q);
        return i < 0 ? [] : [`#${m.seq} ${m.author}: …${t.slice(Math.max(0, i - 150), i + q.length + 150).replace(/\s+/g, ' ')}…`];
      });
      if (!hits.length) return `no message contains "${query}"`;
      return (hits.length > 15 ? hits.slice(-15) : hits).join('\n') + (hits.length > 15 ? `\n(${hits.length - 15} older matches not shown)` : '');
    },
  }),
} satisfies Record<string, CardTool<z.ZodType>>;

export function cardToolSpecs(): ToolSpec[] {
  return Object.entries(CARD_TOOLS).map(([name, t]) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
    return { name, description: t.description, input_schema: schema };
  });
}

export function isCardTool(name: string): boolean {
  return name in CARD_TOOLS;
}

export function runCardTool(name: string, input: unknown, ctx: CardToolContext): { output: string; isError: boolean; terminal: Terminal } {
  const t = (CARD_TOOLS as Record<string, CardTool<z.ZodType>>)[name]!;
  const parsed = t.input.safeParse(input);
  if (!parsed.success) return { output: `invalid input for ${name}: ${parsed.error.message}`, isError: true, terminal: null };
  try {
    return { output: t.run(parsed.data, ctx), isError: false, terminal: t.terminal ?? null };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true, terminal: null };
  }
}
