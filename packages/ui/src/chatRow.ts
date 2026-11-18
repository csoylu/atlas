import type { IconStatus } from './StatusIcon.tsx';

/**
 * How a compact chat row is coloured (its icon, and the verb for warn/bad; a row is never tinted whole): plain, ok
 * (green), acc (teal: something to look at), warn (needs Master, stopped), bad (failed).
 */
export type RowTone = 'plain' | 'ok' | 'acc' | 'warn' | 'bad';

/** A card report-back line from the engine (kanban.ts reportText), read for its compact row. */
export interface CardReport {
  /** "#12" (or an old c_1a2b3c4d id). */
  card: string;
  title: string;
  icon: IconStatus;
  /** "finished", "needs your review", "closed by you"… */
  verb: string;
  tone: RowTone;
  /** The full report (markdown); '' when there is nothing more than the line. The row shows only `summary` of it. */
  body: string;
  /** Where the row leads (#143): the task's Inbox entry (a stopped task waits there too), or the task itself (closed: no entry). */
  inbox: boolean;
  /** A finished task's first summary line, plain text, shown under the row on one line (#143); '' otherwise. */
  summary: string;
}

/** The first line of a markdown text, without its marks (**, `, #, list bullets, [text](url) links). */
export function firstPlainLine(md: string): string {
  const line = md.trim().split('\n')[0]?.trim() ?? '';
  return line
    .replace(/^(?:#+|[-*+]|\d+\.)\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .trim();
}

const HEAD = /^(?:✓ )?(?:Card|Task|You stopped) “(.*?)” \((#\d+|c_[0-9a-f]{8})\)/s;

/** Parse a report-back message; null for any other system line (it stays a plain note). */
export function parseReport(text: string): CardReport | null {
  const m = HEAD.exec(text);
  if (!m) return null;
  const [, title, card] = m as unknown as [string, string, string];
  const rest = text.slice(m[0].length);
  const after = (prefix: string) => rest.slice(prefix.length).replace(/^:\s*/, '').trim();
  const base = { card, title, inbox: true, summary: '' };
  if (text.startsWith('You stopped')) return { ...base, icon: 'failed', verb: 'stopped', tone: 'bad', body: rest.replace(/^\.\s*/, '').trim() };
  if (rest.startsWith(' finished')) {
    const body = after(' finished');
    return { ...base, icon: 'done', verb: 'finished', tone: 'plain', body, summary: firstPlainLine(body) };
  }
  if (rest.startsWith(' is ready for your review')) return { ...base, icon: 'review', verb: 'needs your review', tone: 'warn', body: after(' is ready for your review') };
  if (rest.startsWith(' needs your OK')) return { ...base, icon: 'blocked', verb: 'needs your OK', tone: 'warn', body: after(' needs your OK') };
  if (rest.startsWith(' is blocked')) return { ...base, icon: 'blocked', verb: 'blocked', tone: 'bad', body: after(' is blocked') };
  const closed = /^ closed by (you|@\S+?)\.\s*/.exec(rest);
  if (closed) return { ...base, inbox: false, icon: 'closed', verb: `closed by ${closed[1]}`, tone: 'plain', body: rest.slice(closed[0].length).trim() };
  return null;
}

/** "14:32" today, "13 Nov 14:32" another day. */
export function rowTime(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${hm}`;
}
