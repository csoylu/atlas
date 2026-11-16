import type { ContentBlock, Message, TodoItem } from '@atlas/shared';
import type { ModelRequest } from './providers/types.ts';

export const INTERRUPTED = 'interrupted by a restart or a stop before this tool finished; re-run it if still needed';

/**
 * Build the model's view of a transcript (design §8; compaction below):
 * - a user message posted while the model was producing an answer is placed after that answer,
 * - consecutive messages of one role are merged, tool results first,
 * - every tool_use gets a tool_result; missing ones (restart, stop) get a synthetic one.
 */
export function buildMessages(messages: (Message & { contextUpto?: number | null })[]): ModelRequest['messages'] {
  const pos = new Map<string, number>();
  for (const m of messages) pos.set(m.id, m.seq);
  for (const a of messages) {
    if (a.role !== 'assistant' || a.contextUpto == null) continue;
    for (const u of messages)
      if (u.role === 'user' && u.seq > a.contextUpto && u.seq < a.seq) pos.set(u.id, Math.max(pos.get(u.id)!, a.seq + 0.5));
  }
  const ordered = [...messages].sort((x, y) => pos.get(x.id)! - pos.get(y.id)!);

  const out: ModelRequest['messages'] = [];
  for (const m of ordered) {
    const last = out.at(-1);
    if (last && last.role === m.role) last.content.push(...m.content);
    else out.push({ role: m.role, content: [...m.content] });
  }
  for (let i = 0; i < out.length; i++) {
    const m = out[i]!;
    if (m.role !== 'assistant') continue;
    const uses = m.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) continue;
    let next = out[i + 1];
    if (!next || next.role !== 'user') {
      next = { role: 'user', content: [] };
      out.splice(i + 1, 0, next);
    }
    const have = new Set(next.content.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])));
    for (const u of uses) if (!have.has(u.id)) next.content.push({ type: 'tool_result', tool_use_id: u.id, content: INTERRUPTED, is_error: true });
    const rank = (b: ContentBlock) => (b.type === 'tool_result' ? 0 : 1);
    next.content.sort((a, b) => rank(a) - rank(b));
  }
  return out;
}

/** The agent owes a turn when the model's view ends with a user message. */
export function needsTurn(view: ModelRequest['messages']): boolean {
  return view.at(-1)?.role === 'user';
}

// ── Compaction (design §8) ────────────────────────────────────────────────────────────────────────────────────────
// The transcript is never changed. The view sent to the model is: a summary of the oldest part (stored on the
// conversation with the seq it covers) + the messages after it. Past COMPACT_AT of the context window the runner folds
// more of the oldest messages into the summary; if that fails it degrades the view (degrade()) and retries next turn.

type Turn = ModelRequest['messages'][number];
type Msg = Message & { contextUpto?: number | null };

/** Fraction of the context window the view may use; the rest is left for the answer. */
export const COMPACT_AT = 0.7;
/** After a compaction the view should be under this fraction (hysteresis: it doesn't happen again every turn). */
export const COMPACT_TO = 0.5;
/** Pruning keeps the newest messages worth this fraction of the window whole. */
export const PRUNE_TAIL = 0.25;
/** A prune breaks the prompt cache: it is done only if it reclaims at least this fraction of the window. */
export const PRUNE_MIN = 0.05;
export const SUMMARY_LEAD = 'Summary of the earlier part of this conversation (written when it got too long for the context):';
export const TODO_LEAD = 'Your todo list (todo_write), as last written; the call itself was summarized:';
const OMITTED_TOOL = (n: number, seq?: number) => `output omitted to fit the context (${n} chars); history_search can read it${seq ? ` (seq ${seq})` : ''}`;
const OMITTED_INPUT = (n: number, seq?: number) => `input omitted to fit the context (${n} chars)${seq ? `; history_search can read it (seq ${seq})` : ''}`;
/** Tool outputs and inputs above these sizes are replaced by a stub when pruned or degraded. */
const BIG_RESULT = 300;
const BIG_INPUT = 600;
/** Identical tool outputs at least this long are deduplicated when pruned. */
const DEDUPE_MIN = 80;

/** Rough token count (~4 characters per token), on the JSON the provider sends. Errs high for prose, fine here. */
export const estimateTokens = (x: unknown): number => Math.ceil((typeof x === 'string' ? x.length : JSON.stringify(x).length) / 4);

/** The last real prompt size the provider reported for the conversation, and the seq of the last message it included. */
export interface Reading {
  tokens: number;
  upto: number;
}

/**
 * The view's size for the compaction decision: the provider's real count of the last turn + an estimate of only the
 * messages added since. Null without a reading (new conversation, or the view changed since: summary, prune).
 */
export function measuredSize(reading: Reading | null, transcript: Msg[]): number | null {
  if (!reading) return null;
  const added = transcript.filter((m) => m.seq > reading.upto);
  return reading.tokens + (added.length ? estimateTokens(added.map((m) => m.content)) : 0);
}

/**
 * The view: summary (if any) + the messages after the seq it covers, those up to `pruneUpto` pruned (pruneMessages).
 * If the latest todo_write call was folded into the summary, the current list is re-injected after it.
 */
export function compactedView(
  transcript: Msg[],
  summary: string | null,
  uptoSeq: number | null,
  pruneUpto: number | null = null,
  todos: TodoItem[] | null = null,
): Turn[] {
  const rest = uptoSeq == null ? transcript : transcript.filter((m) => m.seq > uptoSeq);
  const view = buildMessages(pruneMessages(rest, pruneUpto));
  const lead: ContentBlock[] = [];
  if (summary) lead.push({ type: 'text', text: `${SUMMARY_LEAD}\n\n${summary}` });
  const todoVisible = rest.some((m) => m.content.some((b) => b.type === 'tool_use' && b.name === 'todo_write'));
  if (todos?.length && !todoVisible) lead.push({ type: 'text', text: `${TODO_LEAD}\n${renderTodos(todos)}` });
  if (!lead.length) return view;
  if (view[0]?.role === 'user') return [{ role: 'user', content: [...lead, ...view[0].content] }, ...view.slice(1)];
  return [{ role: 'user', content: lead }, ...view];
}

/** A todo list as text: one line per item, [x] done, [>] in progress, [ ] pending. */
export function renderTodos(todos: TodoItem[]): string {
  const mark = { completed: '[x]', in_progress: '[>]', pending: '[ ]' } as const;
  return todos.map((t) => `- ${mark[t.status]} ${t.content}`).join('\n');
}

/**
 * Prune (Hermes "proactive prune"): in the messages up to `upto`, deterministically (the same transcript gives the same
 * view, so the prompt cache holds between prunes):
 * - a tool output identical to a later one in the region becomes a pointer to it,
 * - big tool outputs and big tool inputs become « omitted … history_search can read it » stubs (todo_write inputs stay:
 *   the list is small and the agent needs it),
 * - provider web searches become one line of text.
 * The messages after `upto` (the protected recent tail) and user / assistant text stay whole. Returns copies.
 */
export function pruneMessages(messages: Msg[], upto: number | null): Msg[] {
  if (upto == null) return messages;
  const latest = new Map<string, string>(); // output → where its latest copy in the region is ("seq:index")
  for (const m of messages)
    if (m.seq <= upto) m.content.forEach((b, i) => b.type === 'tool_result' && b.content.length >= DEDUPE_MIN && latest.set(b.content, `${m.seq}:${i}`));
  return messages.map((m) => {
    if (m.seq > upto) return m;
    const content = m.content.map((b, i): ContentBlock => {
      if (b.type === 'tool_result') {
        const at = latest.get(b.content);
        if (b.content.length > BIG_RESULT) return { ...b, content: OMITTED_TOOL(b.content.length, m.seq) };
        if (at && at !== `${m.seq}:${i}`) return { ...b, content: `same output as the later call in #${at.split(':')[0]}` };
        return b;
      }
      if (b.type === 'tool_use' && b.name !== 'todo_write') {
        const n = JSON.stringify(b.input).length;
        return n > BIG_INPUT ? { ...b, input: { omitted: OMITTED_INPUT(n, m.seq) } } : b;
      }
      if (b.type === 'server_tool_use') return { type: 'text', text: `(searched the web: ${JSON.stringify(b.input)})` };
      if (b.type === 'web_search_tool_result') return { type: 'text', text: `(${searchSummary(b.content)}; results omitted to fit the context)` };
      return b;
    });
    return content.every((b, i) => b === m.content[i]) ? m : { ...m, content };
  });
}

/**
 * Where to prune: every message up to the returned seq, keeping whole the newest messages worth `tail` tokens (and
 * always the newest two). Null if the whole conversation fits in the tail.
 */
export function pickPrune(messages: Msg[], tail: number): number | null {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateTokens(messages[i]!.content);
    if (acc > tail && i < messages.length - 2) return messages[i]!.seq;
  }
  return null;
}

/** One message as plain text for the summarizer: tool inputs and outputs shortened. */
export function renderForSummary(messages: Msg[]): string {
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);
  return messages
    .map((m) => {
      const parts = m.content.flatMap((b) => {
        if (b.type === 'text') return [b.text];
        if (b.type === 'tool_use') return [`→ ${b.name} ${cap(JSON.stringify(b.input), 400)}`];
        if (b.type === 'tool_result') return [`← ${b.is_error ? 'error: ' : ''}${cap(b.content, 1200)}`];
        if (b.type === 'server_tool_use') return [`→ ${b.name} (run by the provider) ${cap(JSON.stringify(b.input), 400)}`];
        if (b.type === 'web_search_tool_result') return [`← ${searchSummary(b.content)}`];
        return []; // thinking: the model's private notes, not part of the record
      });
      return `#${m.seq} ${m.author}:\n${parts.join('\n')}`;
    })
    .join('\n\n');
}

/** One line for a web search result: the pages found, or its error. */
export function searchSummary(content: unknown): string {
  if (!Array.isArray(content)) return `web search failed: ${(content as { error_code?: string } | null)?.error_code ?? 'unknown error'}`;
  const pages = content.flatMap((r: { title?: string; url?: string }) => (r?.url ? [`${r.title ?? ''} <${r.url}>`] : []));
  return `web search: ${pages.length} results${pages.length ? ': ' + pages.slice(0, 8).join('; ') : ''}`;
}

/**
 * Where to fold: the summary will cover every message with seq ≤ the returned seq. Folds just enough that the rest
 * costs ≤ `keep` tokens, but at most `chunk` tokens of rendered text per summary call (bigger backlogs take several
 * calls). Cuts only right before an assistant message, so no tool_result is ever separated from its tool_use. Null if
 * nothing can be folded (e.g. the size is all in the newest message: degrade() handles that).
 */
export function pickCut(messages: Msg[], keep: number, chunk: number): number | null {
  const raw = messages.map((m) => estimateTokens(m.content));
  const folded = messages.map((m) => estimateTokens(renderForSummary([m])));
  let total = raw.reduce((a, b) => a + b, 0);
  let foldCost = 0;
  let best: number | null = null;
  for (let i = 1; i < messages.length; i++) {
    total -= raw[i - 1]!;
    foldCost += folded[i - 1]!;
    if (foldCost > chunk) break;
    if (messages[i]!.role !== 'assistant') continue;
    best = messages[i - 1]!.seq;
    if (total <= keep) break;
  }
  return best;
}

/**
 * Fallback when no summary can be made (design §8): shrink the oldest tool outputs and inputs first, then older
 * assistant text, until the view fits `budget`. User messages and the newest two turns are never touched.
 */
export function degrade(view: Turn[], budget: number, overhead: number): Turn[] {
  const out: Turn[] = view.map((t) => ({ role: t.role, content: t.content.map((b) => ({ ...b })) as ContentBlock[] }));
  const size = () => overhead + estimateTokens(out);
  const older = out.slice(0, Math.max(0, out.length - 2));
  const passes: ((b: ContentBlock, t: Turn) => ContentBlock | null)[] = [
    (b) => (b.type === 'tool_result' && b.content.length > BIG_RESULT ? { ...b, content: OMITTED_TOOL(b.content.length) } : null),
    // Provider web searches: the pair becomes plain text (their results can't be shortened, only dropped).
    (b) =>
      b.type === 'server_tool_use'
        ? { type: 'text', text: `(searched the web: ${JSON.stringify(b.input)})` }
        : b.type === 'web_search_tool_result'
          ? { type: 'text', text: `(${searchSummary(b.content)}; results omitted to fit the context)` }
          : null,
    (b) => {
      if (b.type !== 'tool_use') return null;
      const n = JSON.stringify(b.input).length;
      return n > BIG_INPUT ? { ...b, input: { omitted: OMITTED_INPUT(n) } } : null;
    },
    (b, t) =>
      t.role === 'assistant' && b.type === 'text' && b.text.length > 400
        ? { type: 'text', text: `${b.text.slice(0, 200)}… (${b.text.length - 200} chars omitted to fit the context)` }
        : null,
  ];
  for (const pass of passes)
    for (const t of older)
      for (let i = 0; i < t.content.length; i++) {
        if (size() <= budget) return out;
        const r = pass(t.content[i]!, t);
        if (r) t.content[i] = r;
      }
  return out;
}
