import { IMAGE_KEEP, type ContentBlock, type Message, type TodoItem } from '@atlas/shared';
import { IMAGE_TOKENS, imageLine } from './images.ts';
import type { ModelRequest } from './providers/types.ts';

export const INTERRUPTED = 'interrupted by a restart or a stop before this tool finished; re-run it if still needed';

/**
 * Build the model's view of a transcript (design §8; compaction below):
 * - a user message posted while the model was producing an answer is placed after that answer,
 * - consecutive messages of one role are merged, tool results first,
 * - every tool_use gets a tool_result; missing ones (restart, stop) get a synthetic one.
 */
export function buildMessages(messages: (Message & { contextUpto?: number | null })[], self?: string): ModelRequest['messages'] {
  const pos = new Map<string, number>();
  for (const m of messages) pos.set(m.id, m.seq);
  for (const a of messages) {
    if (a.role !== 'assistant' || a.contextUpto == null) continue;
    for (const u of messages)
      if (u.role === 'user' && u.seq > a.contextUpto && u.seq < a.seq) pos.set(u.id, Math.max(pos.get(u.id)!, a.seq + 0.5));
  }
  const sorted = [...messages].sort((x, y) => pos.get(x.id)! - pos.get(y.id)!);
  const ordered = self ? othersAsContext(sorted, self) : sorted;

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

/** Who wrote a message that is not the running agent's own (othersAsContext): the line that opens it. */
export const otherLead = (author: string) => `[@${author}, another agent, wrote this in the thread (not you):]`;
const OTHER_INPUT = 600;
const OTHER_RESULT = 2000;

/**
 * Two agents in one thread (#221: the reviewer runs in the builder's task thread; atlas reviews zurich's PRs; workflow
 * steps): the provider only knows « user » and « assistant », so another agent's turns replayed as assistant turns read
 * as the running agent's own, and it takes the other's work for its own. Here, for the agent `self`:
 * - an assistant message by another agent becomes a user message opening with otherLead(author): its text, its tool
 *   calls as one line each (input shortened), its web searches as their line; its thinking is left out (private notes,
 *   and a signature only replays for the model that wrote it);
 * - the results of those calls become text lines « ← @author's tool: … » (shortened, pictures as their line).
 * The running agent's own messages, the user's, notes and system messages are unchanged. Returns copies.
 */
export function othersAsContext(messages: Msg[], self: string): Msg[] {
  const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s);
  const other = (m: Msg) => m.role === 'assistant' && m.author !== self && m.author !== 'system';
  if (!messages.some(other)) return messages;
  const foreign = new Map<string, { author: string; name: string }>(); // tool_use id → who called what
  for (const m of messages.filter(other))
    for (const b of m.content) if (b.type === 'tool_use' || b.type === 'server_tool_use') foreign.set(b.id, { author: m.author, name: b.name });
  const out: Msg[] = [];
  for (const m of messages) {
    if (other(m)) {
      const parts = m.content.flatMap((b): string[] => {
        if (b.type === 'text') return b.text.trim() ? [b.text] : [];
        if (b.type === 'tool_use') return [`→ ${b.name} ${cap(JSON.stringify(b.input), OTHER_INPUT)}`];
        if (b.type === 'server_tool_use') return [`→ ${b.name} (run by the provider) ${cap(JSON.stringify(b.input), OTHER_INPUT)}`];
        if (b.type === 'web_search_tool_result') return [`← ${searchSummary(b.content)}`];
        if (b.type === 'image') return [imageLine(b)];
        if (b.type === 'tool_result') return [`← ${cap(b.content, OTHER_RESULT)}`];
        return []; // thinking, redacted_thinking
      });
      if (parts.length) out.push({ ...m, role: 'user', content: [{ type: 'text', text: `${otherLead(m.author)}\n${parts.join('\n')}` }] });
      continue;
    }
    if (m.role === 'user' && m.content.some((b) => b.type === 'tool_result' && foreign.has(b.tool_use_id))) {
      const content = m.content.map((b): ContentBlock => {
        if (b.type !== 'tool_result' || !foreign.has(b.tool_use_id)) return b;
        const who = foreign.get(b.tool_use_id)!;
        const pics = (b.images ?? []).map(imageLine);
        return { type: 'text', text: [`← @${who.author}'s ${who.name}${b.is_error ? ' (error)' : ''}: ${cap(b.content, OTHER_RESULT)}`, ...pics].join('\n') };
      });
      out.push({ ...m, content });
      continue;
    }
    out.push(m);
  }
  return out;
}

/** The agent owes a turn when the model's view ends with a user message. */
export function needsTurn(view: ModelRequest['messages']): boolean {
  return view.at(-1)?.role === 'user';
}

/**
 * needsTurn on a transcript, task notes left out (#143): a note about a task (Kanban.taskNotes) is read on the agent's
 * next turn but never asks for one.
 */
export function owesTurn(messages: (Message & { contextUpto?: number | null })[], notes: Set<string>): boolean {
  return needsTurn(buildMessages(notes.size ? messages.filter((m) => !notes.has(m.id)) : messages));
}

// ── Compaction (design §8) ────────────────────────────────────────────────────────────────────────────────────────
// The transcript is never changed. The view sent to the model is: a summary of the oldest part (stored on the
// conversation with the seq it covers) + the messages after it. Past COMPACT_AT of the context window the runner folds
// more of the oldest messages into the summary; if that fails it degrades the view (degrade()) and retries next turn.

type Turn = ModelRequest['messages'][number];
type Msg = Message & { contextUpto?: number | null };

/**
 * Fraction of the context window the view may use; the rest is left for the answer (#376: 0.8, was 0.7, now that the
 * summary call reads the view from the cache). compactBudget also keeps the answer's room.
 */
export const COMPACT_AT = 0.8;
/** After a compaction the view should be under this fraction (hysteresis: it doesn't happen again every turn). */
export const COMPACT_TO = 0.5;
/** Pruning keeps the newest messages worth this fraction of the window whole. */
export const PRUNE_TAIL = 0.25;
/** A prune breaks the prompt cache: it is done only if it reclaims at least this fraction of the window. */
export const PRUNE_MIN = 0.05;
/** The summary's answer limit, and the room a summary call needs on top of the view (the answer + its instruction). */
export const SUMMARY_MAX_TOKENS = 4000;
export const SUMMARY_ROOM = SUMMARY_MAX_TOKENS + 1000;

/**
 * The view's budget in tokens: COMPACT_AT of the window, but never so much that the answer (the model's maxTokens) or
 * a summary call (SUMMARY_ROOM) would not fit after it; at least COMPACT_TO of the window (a model whose maxTokens is
 * over half its window can't have both: its answers are cut by the server). 200k window, 16k answers: 160k.
 */
export function compactBudget(model: { contextWindow: number; maxTokens: number }): number {
  const w = model.contextWindow;
  return Math.max(Math.floor(w * COMPACT_TO), Math.min(Math.floor(w * COMPACT_AT), w - Math.max(model.maxTokens, SUMMARY_ROOM)));
}

/** What a summary keeps (both summary calls: the turn's prefix + an instruction, or the rendered text). */
export const SUMMARY_GUIDE = [
  'Write what the agent needs to carry on: the goal; what the user asked and decided (their exact words where they matter);',
  'what was done (files, commands, results, task and artifact ids); what was learned; errors and how they were fixed;',
  'what remains. Keep identifiers, paths, numbers and URLs exact. Plain text, no preamble.',
  'Several agents can write in one thread (a builder and its reviewer): say which agent did what.',
].join(' ');

/** The opening of the summary call's instruction (the request that shares the turn's prefix). */
export const SUMMARY_ASK = '[Atlas: context compaction]';

/**
 * The last message of a summary call that repeats the turn's request (#376): the same system, tools and view, so the
 * provider reads them from the cache, then this. `kept`: the view's last messages that stay as they are (0: the whole
 * conversation is folded), `first` the opening of the first of them.
 */
export function summaryAsk(o: { previous: boolean; kept: number; first: string | null; focus?: string }): string {
  const what = o.kept
    ? `every message before the last ${o.kept} of this conversation (they start with « ${o.first ?? ''} »; they stay in your context as they are: leave them out)`
    : 'the whole conversation';
  return [
    `${SUMMARY_ASK} This conversation is getting too long for your context. Do not call any tool and do not go on with the work now:`,
    `reply with only a summary of ${what}${o.previous ? ', folding the earlier summary at its start into it' : ''}.`,
    'It replaces those messages: you will continue from it.',
    SUMMARY_GUIDE,
    ...(o.focus ? [`The user asked for this summary (/compact) with this focus: ${o.focus}`] : []),
  ].join(' ');
}

/** How a view message opens, for summaryAsk: its first text, or its first tool call; at most 160 chars. */
export function opening(turn: Turn | undefined): string | null {
  if (!turn) return null;
  const line = turn.content.flatMap((b) => {
    if (b.type === 'text' && b.text.trim()) return [b.text.trim()];
    if (b.type === 'tool_use') return [`→ ${b.name} ${JSON.stringify(b.input)}`];
    if (b.type === 'tool_result') return [`← ${b.content}`];
    return [];
  })[0];
  if (!line) return null;
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

export const SUMMARY_LEAD = 'Summary of the earlier part of this conversation (written when it got too long for the context):';
export const TODO_LEAD = 'Your todo list (todo_write), as last written; the call itself was summarized:';
const OMITTED_TOOL = (n: number, seq?: number) => `output omitted to fit the context (${n} chars); history_search can read it${seq ? ` (seq ${seq})` : ''}`;
const OMITTED_INPUT = (n: number, seq?: number) => `input omitted to fit the context (${n} chars)${seq ? `; history_search can read it (seq ${seq})` : ''}`;
/** Tool outputs and inputs above these sizes are replaced by a stub when pruned or degraded. */
const BIG_RESULT = 300;
const BIG_INPUT = 600;
/** Identical tool outputs at least this long are deduplicated when pruned. */
const DEDUPE_MIN = 80;

/**
 * Rough token count (~4 characters per token), on the JSON the provider sends. Errs high for prose, fine here. A
 * picture is a short reference in the JSON but costs the model ~IMAGE_TOKENS: counted as such, at most IMAGE_KEEP per
 * call (older ones go as a text line, withPictures).
 */
export const estimateTokens = (x: unknown): number => {
  const json = typeof x === 'string' ? x : JSON.stringify(x);
  const pictures = typeof x === 'string' ? 0 : Math.min(IMAGE_KEEP, json.match(/"type":"image"/g)?.length ?? 0);
  return Math.ceil(json.length / 4) + pictures * IMAGE_TOKENS;
};

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
  /** The running agent: other agents' messages are shown as theirs (othersAsContext). */
  self?: string,
): Turn[] {
  const rest = uptoSeq == null ? transcript : transcript.filter((m) => m.seq > uptoSeq);
  const view = pairServerTools(buildMessages(pruneMessages(rest, pruneUpto), self));
  const lead: ContentBlock[] = [];
  if (summary) lead.push({ type: 'text', text: `${SUMMARY_LEAD}\n\n${summary}` });
  const todoVisible = rest.some((m) => m.content.some((b) => b.type === 'tool_use' && b.name === 'todo_write'));
  if (todos?.length && !todoVisible) lead.push({ type: 'text', text: `${TODO_LEAD}\n${renderTodos(todos)}` });
  if (!lead.length) return view;
  if (view[0]?.role === 'user') return [{ role: 'user', content: [...lead, ...view[0].content] }, ...view.slice(1)];
  return [{ role: 'user', content: lead }, ...view];
}

/** A web search request as text (pruned, folded, or not sendable as is). */
export const searchedText = (b: { input: unknown }): ContentBlock => ({ type: 'text', text: `(searched the web: ${JSON.stringify(b.input)})` });
/** A web search result as its one line of text. */
export const resultText = (b: { content: unknown }): ContentBlock => ({ type: 'text', text: `(${searchSummary(b.content)}; results omitted to fit the context)` });

/**
 * Provider web searches as the API accepts them (#144): every web_search_tool_result right after its server_tool_use,
 * in the same assistant message. Anthropic can answer a client tool + a web search in one turn with the search's result
 * only at the start of the next answer (after the tool_result); pruning, folding or degrading can then turn one half
 * into text and keep the other. Here, on the view (the transcript is never changed):
 * - a result whose request is elsewhere (an earlier message, or after it) gets its request moved right before it,
 * - a result whose request is gone (folded, pruned) becomes its one line of text,
 * - a request with no result becomes text, except in the view's last assistant message (a turn the provider continues).
 * Emptied messages are dropped and neighbours of one role merged (tool results first). Returns copies (the input itself when it has no web search).
 */
export function pairServerTools(view: Turn[]): Turn[] {
  const has = (t: Turn) => t.role === 'assistant' && t.content.some((b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result');
  if (!view.some(has)) return view;
  const out: Turn[] = view.map((t) => ({ role: t.role, content: [...t.content] }));
  const assistants = out.filter((t) => t.role === 'assistant');
  const lastAssistant = assistants.at(-1);
  const findUse = (id: string) => {
    for (const t of assistants) {
      const i = t.content.findIndex((b) => b.type === 'server_tool_use' && b.id === id);
      if (i >= 0) return { t, i };
    }
    return null;
  };
  const answered = new Set<string>();
  for (const t of assistants)
    for (let i = 0; i < t.content.length; i++) {
      const b = t.content[i]!;
      if (b.type !== 'web_search_tool_result') continue;
      const use = answered.has(b.tool_use_id) ? null : findUse(b.tool_use_id);
      if (!use) {
        t.content[i] = resultText(b); // its request is gone (or it is a second result for one request)
        continue;
      }
      answered.add(b.tool_use_id);
      if (use.t === t && use.i < i) continue;
      const [moved] = use.t.content.splice(use.i, 1); // (after the result in this message: i is unchanged)
      t.content.splice(i, 0, moved!);
      i++;
    }
  for (const t of assistants)
    t.content = t.content.map((b) => (b.type === 'server_tool_use' && !answered.has(b.id) && t !== lastAssistant ? searchedText(b) : b));

  const merged: Turn[] = [];
  for (const t of out) {
    if (!t.content.length) continue;
    const last = merged.at(-1);
    if (last && last.role === t.role) last.content.push(...t.content);
    else merged.push(t);
  }
  const rank = (b: ContentBlock) => (b.type === 'tool_result' ? 0 : 1);
  for (const t of merged) if (t.role === 'user') t.content.sort((a, b) => rank(a) - rank(b));
  return merged;
}

/**
 * Why the API would refuse this view's web search blocks (#144), or null: names the message and block, so a run that
 * still can't be sent stops with a precise error (rule 3) instead of a 400 on every retry.
 */
export function serverToolProblem(view: Turn[]): string | null {
  const answered = new Set<string>();
  const lastAssistant = view.findLastIndex((t) => t.role === 'assistant');
  for (let m = 0; m < view.length; m++) {
    const t = view[m]!;
    const uses = new Set<string>();
    for (let i = 0; i < t.content.length; i++) {
      const b = t.content[i]!;
      if (b.type === 'server_tool_use') uses.add(b.id);
      if (b.type === 'web_search_tool_result') {
        if (!uses.has(b.tool_use_id)) return `messages.${m}.content.${i}: web_search_tool_result ${b.tool_use_id} without its server_tool_use before it in the same message`;
        const bad = searchResultProblem(b.content);
        if (bad) return `messages.${m}.content.${i}: web_search_tool_result ${b.tool_use_id}: ${bad}`;
        answered.add(b.tool_use_id);
      }
    }
    if (m !== lastAssistant)
      for (let i = 0; i < t.content.length; i++) {
        const b = t.content[i]!;
        if (b.type === 'server_tool_use' && !answered.has(b.id)) return `messages.${m}.content.${i}: server_tool_use ${b.id} without its web_search_tool_result`;
      }
  }
  return null;
}

/**
 * Why Anthropic would refuse a stored web search result's content, or null (#173): a list of web_search_result items,
 * each with its url and a non-empty encrypted_content string, or one web_search_tool_result_error. A result cut,
 * re-serialised or re-typed somewhere fails here. (A result from another account looks valid: searchesFor turns it into
 * text at send time, where the account is known.)
 */
export function searchResultProblem(content: unknown): string | null {
  if (!Array.isArray(content)) {
    const e = content as { type?: unknown; error_code?: unknown } | null;
    return e?.type === 'web_search_tool_result_error' && typeof e.error_code === 'string' ? null : 'its content is neither a list of results nor an error';
  }
  for (let j = 0; j < content.length; j++) {
    const r = content[j] as { type?: unknown; url?: unknown; encrypted_content?: unknown } | null;
    if (r?.type !== 'web_search_result') return `result ${j} is of type ${String(r?.type)}, not web_search_result`;
    if (typeof r.url !== 'string' || !r.url) return `result ${j} has no url`;
    if (typeof r.encrypted_content !== 'string' || !r.encrypted_content) return `result ${j} has no encrypted_content`;
  }
  return null;
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
      if (b.type === 'server_tool_use') return searchedText(b);
      if (b.type === 'web_search_tool_result') return resultText(b);
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
        if (b.type === 'tool_result') return [`← ${b.is_error ? 'error: ' : ''}${cap(b.content, 1200)}`, ...(b.images ?? []).map(imageLine)];
        if (b.type === 'image') return [imageLine(b)];
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
    // (pairServerTools below makes text of a half whose other half it reached first.)
    (b) => (b.type === 'server_tool_use' ? searchedText(b) : b.type === 'web_search_tool_result' ? resultText(b) : null),
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
        if (size() <= budget) return pairServerTools(out);
        const r = pass(t.content[i]!, t);
        if (r) t.content[i] = r;
      }
  return pairServerTools(out);
}
