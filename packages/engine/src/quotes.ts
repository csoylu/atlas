// Quotes in a chat (#367): passages of this chat's messages with Master's notes, turned into the text blocks the agent
// reads. Called by POST /api/cards/:id/messages before the message row is written; stored with the message.
import { USER, formatQuote, parseComment, quoteTime, type Message, type PostQuote } from '@atlas/shared';
import { InvalidError } from './kanban.ts';

export interface QuoteDeps {
  /** The chat's messages still in it (a rewound one is gone). */
  messages: Message[];
  /** Master's name (Settings → About you), who wrote their own messages. */
  userName: string;
  /** Secrets.redact (rule 5). */
  redact(text: string): string;
  timeZone?: string;
}

/** One text block per quote, in the order given. A quote of a message no longer in the chat is refused, loudly. */
export function quoteBlocks(quotes: PostQuote[], d: QuoteDeps): { type: 'text'; text: string }[] {
  const bySeq = new Map(d.messages.map((m) => [m.seq, m]));
  return quotes.map((q) => {
    const m = bySeq.get(q.on.seq);
    if (!m) throw new InvalidError(`quote ${q.n}: message ${q.on.seq} is no longer in this chat`);
    const who = m.author === USER ? d.userName : m.author;
    return { type: 'text', text: d.redact(formatQuote(q, who, quoteTime(m.at, d.timeZone))) };
  });
}

/**
 * Quotes and comments in their shared numbering (#367): each group (a comment's text and its picture, a quote) in
 * number order. A block of a group follows the one that starts it.
 */
export function byNumber<B>(groups: { n: number; blocks: B[] }[]): B[] {
  return [...groups].sort((a, b) => a.n - b.n).flatMap((g) => g.blocks);
}

/** Comment blocks (commentBlocks: each comment's text, then its picture) as groups by their number. */
export function commentGroups<B extends { type: string; text?: string }>(blocks: B[]): { n: number; blocks: B[] }[] {
  const out: { n: number; blocks: B[] }[] = [];
  for (const b of blocks) {
    const c = b.type === 'text' && typeof b.text === 'string' ? parseComment(b.text) : null;
    if (c) out.push({ n: c.n, blocks: [b] });
    else if (out.length) out.at(-1)!.blocks.push(b);
    else throw new Error('a comment picture with no comment before it');
  }
  return out;
}
