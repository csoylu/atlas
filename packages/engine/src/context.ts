import type { ContentBlock, Message } from '@atlas/shared';
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
export const SUMMARY_LEAD = 'Summary of the earlier part of this conversation (written when it got too long for the context):';
const OMITTED_TOOL = (n: number) => `output omitted to fit the context (${n} chars); history_search can read it`;

/** Rough token count (~4 characters per token), on the JSON the provider sends. Errs high for prose, fine here. */
export const estimateTokens = (x: unknown): number => Math.ceil((typeof x === 'string' ? x.length : JSON.stringify(x).length) / 4);

/** The view: summary (if any) + the messages after the seq it covers. */
export function compactedView(transcript: Msg[], summary: string | null, uptoSeq: number | null): Turn[] {
  const view = buildMessages(uptoSeq == null ? transcript : transcript.filter((m) => m.seq > uptoSeq));
  if (!summary) return view;
  const lead: ContentBlock = { type: 'text', text: `${SUMMARY_LEAD}\n\n${summary}` };
  if (view[0]?.role === 'user') return [{ role: 'user', content: [lead, ...view[0].content] }, ...view.slice(1)];
  return [{ role: 'user', content: [lead] }, ...view];
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
        return []; // thinking: the model's private notes, not part of the record
      });
      return `#${m.seq} ${m.author}:\n${parts.join('\n')}`;
    })
    .join('\n\n');
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
    (b) => (b.type === 'tool_result' && b.content.length > 300 ? { ...b, content: OMITTED_TOOL(b.content.length) } : null),
    (b) => {
      if (b.type !== 'tool_use') return null;
      const n = JSON.stringify(b.input).length;
      return n > 600 ? { ...b, input: { omitted: `input omitted to fit the context (${n} chars)` } } : null;
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
