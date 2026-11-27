import { z } from 'zod';

/*
 * Quotes in a chat (#367, mockup #364): Master selects a passage of a message in the same chat (an agent's reply or
 * their own), adds an optional note, and sends one or several with the next message. Quotes share one numbering with
 * pane comments (#304). The engine turns each into one text block the model reads (formatQuote), stored with the
 * message; the UI shows that block as a card (parseQuote) that jumps back to the passage.
 */

/**
 * Where a quoted passage comes from. One kind for now: a message of this chat (its seq). Another surface (#367's
 * follow-up: documents, files, the browser, tool output) adds a kind here and its line in formatQuote.
 */
export const QuoteOn = z.discriminatedUnion('kind', [z.object({ kind: z.literal('message'), seq: z.number().int().positive() })]);
export type QuoteOn = z.infer<typeof QuoteOn>;

/** A quote as the composer sends it: its number (shared with comments), where it is from, the passage, Master's note. */
export const PostQuote = z.object({
  n: z.number().int().positive(),
  on: QuoteOn,
  passage: z.string().trim().min(1).max(20_000),
  /** The passage is code (selected inside a code block): sent as a fenced block. */
  code: z.boolean().default(false),
  note: z.string().trim().max(5000).default(''),
});
export type PostQuote = z.infer<typeof PostQuote>;
export const QUOTES_MAX = 20;

/** « 26 Nov 2026, 21:28 »: when the quoted message was written, in the engine's time zone (or `timeZone`). */
export function quoteTime(iso: string, timeZone?: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}`;
}

/** A fence longer than any run of backticks in the code, so the code can't close it. */
const fenceFor = (code: string) => '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((m) => m[0].length + 1)));

/**
 * One quote as the model reads it (and as the message stores it):
 *   [quote 1] atlas · 26 Nov 2026, 21:28 · message 42 in this chat
 *   > the passage, every line
 *   Note: Master's note
 * A code passage is a fenced block instead of the `>` lines. No note: no Note line.
 */
export function formatQuote(q: { n: number; on: QuoteOn; passage: string; code: boolean; note: string }, who: string, when: string): string {
  const head = `[quote ${q.n}] ${who} · ${when} · message ${q.on.seq} in this chat`;
  const passage = q.code ? q.passage.replace(/^\n+|\s+$/g, '') : q.passage.trim();
  const fence = fenceFor(passage);
  const body = q.code ? [fence, passage, fence] : passage.split('\n').map((l) => (l.trim() ? '> ' + l : '>'));
  return [head, ...body, ...(q.note.trim() ? [`Note: ${q.note.trim()}`] : [])].join('\n');
}

/** A quote block read back for its card. */
export interface ParsedQuote {
  n: number;
  who: string;
  /** As written for the agent: « 26 Nov 2026, 21:28 ». */
  when: string;
  seq: number;
  passage: string;
  code: boolean;
  note: string;
}

/** Parse a block written by formatQuote; null for anything else. */
export function parseQuote(text: string): ParsedQuote | null {
  const m = /^\[quote (\d+)\] (.+?) · (\d{1,2} \S+ \d{4}, \d{2}:\d{2}) · message (\d+) in this chat(?:\n|$)/.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  let passage: string;
  let code = false;
  let after: string;
  const fence = /^(`{3,})\n/.exec(rest);
  if (fence) {
    const close = rest.indexOf('\n' + fence[1] + '\n', fence[0].length - 1);
    const end = close === -1 && rest.endsWith('\n' + fence[1]) ? rest.length - fence[1]!.length - 1 : close;
    if (end === -1) return null;
    passage = rest.slice(fence[0].length, end);
    code = true;
    after = rest.slice(end + 1 + fence[1]!.length).replace(/^\n/, '');
  } else {
    const lines = rest.split('\n');
    let i = 0;
    while (i < lines.length && (lines[i]!.startsWith('> ') || lines[i] === '>')) i++;
    if (!i) return null;
    passage = lines
      .slice(0, i)
      .map((l) => l.slice(2))
      .join('\n');
    after = lines.slice(i).join('\n');
  }
  if (after && !after.startsWith('Note: ')) return null;
  return { n: Number(m[1]), who: m[2]!, when: m[3]!, seq: Number(m[4]), passage, code, note: after ? after.slice(6) : '' };
}
