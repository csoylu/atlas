import { searchSummary } from './context.ts';
import { imageLine } from './images.ts';
import { z } from 'zod';
import { BLOCK_KINDS, cardRef, currentToolName, type Card } from '@atlas/shared';
import type { Kanban } from './kanban.ts';
import type { ToolSpec } from './providers/types.ts';
import type { Secrets } from './secrets.ts';

/** How a card tool ended the run, if it did (design §4: a work run ends only through one of these). */
export type Terminal = 'complete' | 'block' | 'review' | null;

export interface CardToolContext {
  kanban: Kanban;
  agentId: string;
  /** The card this run works on. */
  cardId: string;
  /** « Needs secret X » on task_block (#207); omitted = the field is refused. */
  secrets?: Secrets;
}

interface CardTool<S extends z.ZodType> {
  description: string;
  input: S;
  terminal?: Exclude<Terminal, null>;
  run(input: z.infer<S>, ctx: CardToolContext): string;
}
const tool = <S extends z.ZodType>(t: CardTool<S>) => t;

const Editable = z.enum(['triage', 'todo', 'ready', 'closed', 'archived']);

/** One line about a card, for agents. `refOf` names a parent (its #number; the id if it's gone). */
export function describeCard(c: Card, refOf: (id: string) => string = (id) => id): string {
  const bits = [`${cardRef(c)} [${c.status}]`, c.assignee ? `@${c.assignee}` : 'unassigned', `P${c.priority}`, c.title];
  if (c.parents.length) bits.push(`(parents: ${c.parents.map(refOf).sort((x, y) => x.localeCompare(y, 'en', { numeric: true })).join(', ')})`);
  return bits.join(' ');
}

/** describeCard with parents named by their #number. */
export const describeWith = (kanban: Kanban) => (c: Card) => describeCard(c, (id) => kanban.ref(id));

/** Card ids the tools take: "#12", "12" or the internal id. */
const CardId = z.union([z.string(), z.number().int()]).transform(String).describe('task number (#12 or 12) or id');

export const CARD_TOOLS = {
  task_list: tool({
    description: 'List tasks (archived excluded), optionally filtered by status.',
    input: z.object({ status: z.string().optional() }),
    run: ({ status }, { kanban }) => {
      const cards = kanban.list().filter((c) => !status || c.status === status);
      return cards.length ? cards.map(describeWith(kanban)).join('\n') : '(no tasks)';
    },
  }),
  task_show: tool({
    description: 'Show a task: fields, description, parents, block.',
    input: z.object({ id: CardId }),
    run: ({ id }, { kanban }) => {
      const c = kanban.get(kanban.resolve(id));
      return [describeWith(kanban)(c), c.block ? `blocked (${c.block.kind}): ${c.block.reason}` : '', '', c.body || '(no description)']
        .filter((l, i) => l || i > 1)
        .join('\n');
    },
  }),
  task_create: tool({
    description:
      'Create a task. Give a clear title, a body with context and acceptance criteria, an assignee, and parents for ' +
      'tasks that must finish first. Status defaults to ready (it waits in todo automatically while a parent is open). ' +
      'Created from a direct chat, the chat is told when the task finishes, closes, is stopped or needs the user.',
    input: z.object({
      title: z.string().min(1).max(200),
      body: z.string().default(''),
      assignee: z.string().nullable().optional(),
      priority: z.number().int().min(0).max(3).default(0),
      parents: z.array(CardId).default([]),
      status: Editable.default('ready'),
    }),
    run: (i, { kanban, agentId, cardId }) => {
      const origin = kanban.get(cardId).board === 'direct' ? cardId : null;
      const c = kanban.create({ ...i, assignee: i.assignee ?? null }, agentId, origin);
      return `created ${describeWith(kanban)(c)}`;
    },
  }),
  task_update: tool({
    description:
      'Edit a task: title, body, assignee, priority, parents, or status (triage, todo, ready, closed, archived). closed = ' +
      'cancelled, nothing more is done (stops its run; e.g. the user changed their mind). It does not count as done for ' +
      'child tasks.',
    input: z.object({
      id: CardId,
      title: z.string().min(1).max(200).optional(),
      body: z.string().optional(),
      assignee: z.string().nullable().optional(),
      priority: z.number().int().min(0).max(3).optional(),
      parents: z.array(CardId).optional(),
      status: Editable.optional(),
    }),
    run: ({ id, ...patch }, { kanban, agentId }) => `updated ${describeWith(kanban)(kanban.update(kanban.resolve(id), patch, agentId))}`,
  }),
  task_complete: tool({
    description: 'Finish your current task: the work is done and verified. The summary is the handoff (what changed, how it was checked).',
    input: z.object({ summary: z.string().min(1) }),
    terminal: 'complete',
    run: ({ summary }, { kanban, agentId, cardId }) => {
      const open = kanban.get(cardId).prs.filter((p) => p.state === 'open');
      if (open.length)
        throw new Error(
          `${open.map((p) => `PR #${p.number}`).join(', ')} still open: the task finishes by itself when ${open.length > 1 ? 'they merge' : 'it merges'} (task_request_review hands it to QA).`,
        );
      kanban.update(cardId, { status: 'done' }, agentId, summary);
      kanban.event(cardId, 'completed', { by: agentId, summary });
      return 'task done';
    },
  }),
  task_block: tool({
    description:
      'Stop and wait. kind: needs_input (a question for the user; give options, recommended first), capability (missing ' +
      'access or tool), dependency (waiting on other Atlas tasks: give waits_on, e.g. ["#12"]; the task waits in todo and ' +
      'restarts by itself when they are done), transient (retry later by itself; set retry_in_minutes). Only needs_input ' +
      'and capability reach the user: if the work you wait on is not a task yet, create it (task_create) first; if only ' +
      'the user can clear it, use needs_input. Missing a secret (API key, token) only the user can give: kind capability ' +
      'with secret: "NAME" (and secret_description): the user sees it in Settings → Secrets, and the task restarts by ' +
      'itself once they add the value.',
    input: z.object({
      kind: z.enum(BLOCK_KINDS),
      question: z.string().min(1),
      options: z.array(z.string()).max(4).default([]),
      retry_in_minutes: z.number().positive().max(24 * 60).optional(),
      waits_on: z.array(CardId).optional(),
      secret: z.string().optional().describe('the env var name of a secret you need and cannot make (A-Z, 0-9, _), e.g. DUNE_API_KEY'),
      secret_description: z.string().max(500).optional().describe('what the secret is, shown to the user'),
    }),
    terminal: 'block',
    run: ({ kind, question, options, retry_in_minutes, waits_on, secret, secret_description }, { kanban, agentId, cardId, secrets }) => {
      if (secret !== undefined) {
        if (kind !== 'capability' && kind !== 'needs_input') throw new Error('secret goes with kind capability (or needs_input): only the user can add a value');
        if (!secrets) throw new Error('secrets are not available here');
        if (kanban.get(cardId).board === 'direct') throw new Error('a direct chat does not block: ask the user for the secret in the chat (Settings → Secrets)');
        // The row first (idempotent): a crash before the block re-runs the task, which blocks again on the same row.
        secrets.need(agentId, cardId, secret, secret_description);
        const reason = `${question}\n\nNeeds secret ${secret}: add its value in Settings → Secrets; the task restarts by itself.`;
        kanban.block(cardId, { kind, reason, options, until: null }, agentId);
        return `task blocked (${kind}) until the user adds the value of ${secret} in Settings → Secrets; it restarts by itself then`;
      }
      if (kind === 'dependency') {
        if (!waits_on?.length)
          throw new Error('kind=dependency needs waits_on: the task number(s) this one waits on, e.g. ["#12"]. Create a task for that work first, or use needs_input if only the user can clear it.');
        const c = kanban.waitOn(cardId, waits_on, question, agentId);
        return `task waits in todo on ${c.parents.map((p) => kanban.ref(p)).join(', ')}; it restarts by itself when they are done`;
      }
      if (kind === 'transient') {
        const at = new Date(Date.now() + (retry_in_minutes ?? 15) * 60_000).toISOString();
        kanban.retryLater(cardId, { reason: question, at }, agentId);
        return `task waits in todo and retries at ${at}`;
      }
      kanban.block(cardId, { kind, reason: question, options, until: null }, agentId);
      return `task blocked (${kind})`;
    },
  }),
  task_request_review: tool({
    description:
      'Hand your open pull request(s) to QA: the task goes In review, the reviewer agent checks it once CI is green, and ' +
      'the task moves by itself: merged → done, CI red / conflict / validation failed → back to you with the reason. ' +
      'prs: the GitHub PR urls. Work with no pull request (mockup, report) ends with task_complete instead; a question ' +
      'for the user is task_block.',
    input: z.object({
      summary: z.string().min(1),
      prs: z.array(z.string()).min(1, 'give the url of your open pull request (no PR: use task_complete)').describe('GitHub pull request urls, e.g. https://github.com/owner/repo/pull/12'),
    }),
    terminal: 'review',
    run: ({ summary, prs }, { kanban, agentId, cardId }) => {
      const c = kanban.requestReview(cardId, prs, agentId, summary);
      return `in review: ${c.prs.map((p) => `PR #${p.number}`).join(', ')} ${c.reviewer ? `waits for @${c.reviewer}` : 'has no reviewer (no review agent set: tell the user)'}`;
    },
  }),
  history_search: tool({
    description:
      "Read your own conversation's full transcript, including parts summarized or omitted from your context to save " +
      'room, and in a chat the threads of the tasks created from it. query: find messages containing the text ' +
      '(case-insensitive), here and in those threads. seq: read one message in full (seq numbers appear in search ' +
      'results and in "#n" references of the summary). task: a task id (#12) to read or search that thread only.',
    input: z
      .object({ query: z.string().min(2).optional(), seq: z.number().int().positive().optional(), task: z.string().optional() })
      .refine((i) => i.query || i.seq, 'give a query or a seq'),
    run: ({ query, seq, task }, { kanban, cardId }) => {
      // The threads of this chat: tasks created from it (v3 main chat).
      const threads = kanban.list({ includeArchived: true }).filter((c) => c.originCard === cardId);
      let target = cardId;
      if (task) {
        target = kanban.resolve(task);
        if (target !== cardId && !threads.some((c) => c.id === target)) throw new Error(`${task} is not a task created from this conversation`);
      }
      const read = (id: string) => {
        // Messages the user rewound (hidden from the chat) can still be found, marked as such.
        const messages = kanban.messages(id, { rewound: true });
        // Earlier searches would match themselves: leave them out.
        const own = new Set(messages.flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_use' && b.name === 'history_search' ? [b.id] : []))));
        return { messages, own };
      };
      const tag = (m: { rewound?: boolean }) => (m.rewound ? ' [rewound by the user: not part of the conversation]' : '');
      const textOf = (m: ReturnType<typeof read>['messages'][number], own: Set<string>) =>
        m.content
          .flatMap((b) => {
            if (b.type === 'text') return [b.text];
            if (b.type === 'tool_use') return own.has(b.id) ? [] : [`→ ${b.name} ${JSON.stringify(b.input)}`];
            if (b.type === 'tool_result') return own.has(b.tool_use_id) ? [] : [`← ${b.content}`, ...(b.images ?? []).map(imageLine)];
            if (b.type === 'image') return [imageLine(b)];
            if (b.type === 'server_tool_use') return [`→ ${b.name} ${JSON.stringify(b.input)}`];
            if (b.type === 'web_search_tool_result') return [`← ${searchSummary(b.content)}`];
            return [];
          })
          .join('\n');
      if (seq) {
        const { messages, own } = read(target);
        const m = messages.find((x) => x.seq === seq);
        if (!m) throw new Error(`no message #${seq} (this transcript has ${messages.length})`);
        const t = textOf(m, own);
        return `#${m.seq} ${m.author}${tag(m)} (${m.at}):\n${t.length > 20_000 ? t.slice(0, 20_000) + `\n… (${t.length - 20_000} more chars)` : t}`;
      }
      const q = query!.toLowerCase();
      const ids = task ? [target] : [cardId, ...threads.map((c) => c.id)];
      const hits = ids.flatMap((id) => {
        const { messages, own } = read(id);
        const where = id === cardId ? '' : `${kanban.ref(id)} `;
        return messages.flatMap((m) => {
          const t = textOf(m, own);
          const i = t.toLowerCase().indexOf(q);
          return i < 0 ? [] : [{ at: m.at, line: `${where}#${m.seq} ${m.author}${tag(m)}: …${t.slice(Math.max(0, i - 150), i + q.length + 150).replace(/\s+/g, ' ')}…` }];
        });
      });
      if (!hits.length) return `no message contains "${query}"`;
      hits.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const lines = hits.map((h) => h.line);
      const note = ids.length > 1 ? '\n(lines starting with a task id are in that thread: read one with seq and task)' : '';
      return (lines.length > 15 ? lines.slice(-15) : lines).join('\n') + (lines.length > 15 ? `\n(${lines.length - 15} older matches not shown)` : '') + note;
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
  return currentToolName(name) in CARD_TOOLS;
}

export function runCardTool(name: string, input: unknown, ctx: CardToolContext): { output: string; isError: boolean; terminal: Terminal } {
  const t = (CARD_TOOLS as Record<string, CardTool<z.ZodType>>)[currentToolName(name)]!;
  const parsed = t.input.safeParse(input);
  if (!parsed.success) return { output: `invalid input for ${name}: ${parsed.error.message}`, isError: true, terminal: null };
  try {
    return { output: t.run(parsed.data, ctx), isError: false, terminal: t.terminal ?? null };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true, terminal: null };
  }
}
