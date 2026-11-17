import { CARD_STATUSES, type CardStatus } from '@atlas/shared';

/**
 * Card & team tool results → what their expanded rows show (#62, docs/chat-activity.md §1): a card chip, board counts,
 * history hits. Pure, parsed from the engine's exact wording (packages/engine/src/cardTools.ts).
 */

export interface CardLine {
  /** "#58" */
  ref: string;
  status: CardStatus;
  /** "@atlas", null when unassigned. */
  who: string | null;
  /** "P2" */
  prio: string;
  title: string;
  /** Parent refs: "#58". */
  parents: string[];
}

const isStatus = (s: string): s is CardStatus => (CARD_STATUSES as readonly string[]).includes(s);

/** "#58 [done] @atlas P2 Title (parents: #57, #56)" (describeCard) → its parts; null if the line isn't one. */
export function cardLine(s: string): CardLine | null {
  const m = /#(\d+) \[(\w+)\] (@\S+|unassigned) (P\d) (.*)/.exec(s.trim().split('\n')[0] ?? '');
  if (!m || !isStatus(m[2]!)) return null;
  let title = m[5]!.trim();
  let parents: string[] = [];
  const p = / \(parents: ([^)]*)\)$/.exec(title);
  if (p) {
    title = title.slice(0, p.index);
    parents = p[1]!.split(/,\s*/).filter(Boolean);
  }
  return { ref: '#' + m[1], status: m[2], who: m[3] === 'unassigned' ? null : m[3]!, prio: m[4]!, title, parents };
}

/** The chip's faint line: "todo · @atlas · P2 · after #58". */
export function cardSub(c: Pick<CardLine, 'status' | 'who' | 'prio' | 'parents'>): string {
  return [c.status, c.who, c.prio, c.parents.length ? `after ${c.parents.join(', ')}` : null].filter(Boolean).join(' · ');
}

/** Statuses in board order, the ones that need attention first. */
const ORDER: CardStatus[] = ['running', 'blocked', 'review', 'ready', 'todo', 'triage', 'done', 'closed', 'archived'];

export interface BoardGroup {
  status: CardStatus;
  cards: { ref: string; title: string }[];
}

/** card_list's output → the cards per status, in board order (empty statuses left out). */
export function boardGroups(out: string): BoardGroup[] {
  const by = new Map<CardStatus, BoardGroup['cards']>();
  for (const l of out.split('\n')) {
    const c = cardLine(l);
    if (c) by.set(c.status, [...(by.get(c.status) ?? []), { ref: c.ref, title: c.title }]);
  }
  return ORDER.flatMap((status) => (by.has(status) ? [{ status, cards: by.get(status)! }] : []));
}

/** The row's meta: "52 cards · 2 running · 1 ready". */
export function boardMeta(out: string): string {
  const groups = boardGroups(out);
  const total = groups.reduce((n, g) => n + g.cards.length, 0);
  const n = (s: CardStatus) => groups.find((g) => g.status === s)?.cards.length ?? 0;
  return [`${total} ${total === 1 ? 'task' : 'tasks'}`, n('running') && `${n('running')} running`, n('ready') && `${n('ready')} ready`].filter(Boolean).join(' · ');
}

export interface HistoryHit {
  seq: number;
  author: string;
  text: string;
}

/** history_search with a query → its hits ("#50 tool: …text…") and how many older ones weren't shown. */
export function historyHits(out: string): { hits: HistoryHit[]; more: number } {
  const hits: HistoryHit[] = [];
  let more = 0;
  for (const l of out.split('\n')) {
    const m = /^#(\d+) (\S+?)(?: \[[^\]]*\])?: (.*)$/.exec(l);
    if (m) hits.push({ seq: Number(m[1]), author: m[2]!, text: m[3]! });
    const o = /^\((\d+) older matches not shown\)$/.exec(l);
    if (o) more = Number(o[1]);
  }
  return { hits, more };
}

/** history_search with a seq → that message: "#50 tool (2026-11-14T…):\ntext". */
export function historyMessage(out: string): { seq: number; author: string; at: string; text: string } | null {
  const m = /^#(\d+) (\S+?)(?: \[[^\]]*\])? \(([^)]*)\):\n?([\s\S]*)$/.exec(out);
  return m ? { seq: Number(m[1]), author: m[2]!, at: m[3]!, text: m[4]! } : null;
}

/** Split `text` around case-insensitive occurrences of `q`, for <mark>: ["a ", {hit:"ChatRow"}, " b"]. */
export function markHits(text: string, q: string): (string | { hit: string })[] {
  if (!q) return [text];
  const out: (string | { hit: string })[] = [];
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  for (let j = lower.indexOf(ql); j >= 0; j = lower.indexOf(ql, i)) {
    if (j > i) out.push(text.slice(i, j));
    out.push({ hit: text.slice(j, j + q.length) });
    i = j + q.length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}
