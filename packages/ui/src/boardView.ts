import { CARD_STATUSES, sinceLabel, stallText, type Card, type CardStatus } from '@atlas/shared';

/**
 * Pure helpers for the Board (design §16, Linear direction): the header tabs, the Filter (agent, priority), which
 * columns show, the one-line « why blocked / why not running » and the C shortcut.
 */

export type BoardTab = 'all' | 'needs' | 'running';
export type BoardLayout = 'board' | 'list';
/** null = any. Agent '' = unassigned. */
export type BoardFilter = { agent: string | null; priority: number | null };

export const BOARD_COLUMNS = CARD_STATUSES.filter((s) => s !== 'archived');
const TAB_STATUSES: Record<BoardTab, readonly CardStatus[]> = {
  all: BOARD_COLUMNS,
  needs: ['blocked'], // In review waits for QA, not you (#189)
  running: ['running'],
};
/** Columns where « + » makes sense: a new card can start there (the engine moves it on from running/blocked/review). */
export const CREATE_IN: readonly CardStatus[] = ['triage', 'todo', 'ready'];

export function columnsFor(tab: BoardTab): readonly CardStatus[] {
  return TAB_STATUSES[tab];
}

export function matches(c: Card, tab: BoardTab, f: BoardFilter): boolean {
  if (!TAB_STATUSES[tab].includes(c.status)) return false;
  if (f.agent !== null && (c.assignee ?? '') !== f.agent) return false;
  if (f.priority !== null && c.priority !== f.priority) return false;
  return true;
}

export function filterCount(f: BoardFilter): number {
  return (f.agent !== null ? 1 : 0) + (f.priority !== null ? 1 : 0);
}

/**
 * The card's one note under its marks (redesign « Tasks », #266), or null when it is moving: a stuck task says why
 * (#237, `stuck`), a blocked one what it needs from you (« Needs your answer », the question as tooltip), a task
 * waiting on its parents « waits for #61, #62 », anything else the engine's « why isn't it moving » as it is.
 */
export type CardNote = { text: string; tone: 'needs' | 'stuck' | 'muted'; title?: string };
const BLOCK_KIND: Record<string, string> = { needs_input: 'Needs your answer', capability: 'Missing access', dependency: 'Waiting on other work', transient: 'Retrying later' };
export function cardNote(c: Pick<Card, 'status' | 'block' | 'waiting'> & Partial<Pick<Card, 'stall' | 'statusSince'>>, now = Date.now()): CardNote | null {
  if (c.stall && c.status !== 'blocked') return { text: stallText(c.stall, c.statusSince ?? null, now), tone: 'stuck' };
  if (c.status === 'blocked' && c.block) {
    const first = (c.block.reason.split('\n').find((l) => l.trim()) ?? '').replace(/^[#>*\s-]+/, '').trim();
    return { text: BLOCK_KIND[c.block.kind] ?? 'Blocked', tone: 'needs', ...(first ? { title: first } : {}) };
  }
  if (!c.waiting) return null;
  const parents = /^waiting on (.+)$/.exec(c.waiting);
  if (c.status === 'todo' && parents) return { text: 'waits for ' + parents[1]!.replace(/ \([a-z]+\)/g, ''), tone: 'muted', title: c.waiting };
  return { text: c.waiting, tone: 'muted', title: c.waiting };
}

/** Statuses whose time in state is shown (#237): not Triage, Done, Closed or Archived. */
const TIMED: CardStatus[] = ['todo', 'ready', 'running', 'blocked', 'review'];
/** « 2 h »: how long the card has been in its status, or null when that isn't shown. */
export function timeInState(c: Pick<Card, 'status' | 'statusSince'>, now = Date.now()): string | null {
  return c.statusSince && TIMED.includes(c.status) ? sinceLabel(c.statusSince, now) : null;
}

/** Saved view state (tab, filter, layout), kept across reloads; anything unreadable falls back to the default. */
export type BoardView = { tab: BoardTab; filter: BoardFilter; layout: BoardLayout };
export function parseView(raw: string | null): BoardView {
  const def: BoardView = { tab: 'all', filter: { agent: null, priority: null }, layout: 'board' };
  if (!raw) return def;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return def; // a corrupt localStorage entry is not an error worth showing: the default view is right
  }
  const o = (v ?? {}) as Record<string, unknown>;
  const f = (o.filter ?? {}) as Record<string, unknown>;
  return {
    tab: o.tab === 'needs' || o.tab === 'running' ? o.tab : 'all',
    filter: { agent: typeof f.agent === 'string' ? f.agent : null, priority: typeof f.priority === 'number' ? f.priority : null },
    layout: o.layout === 'list' ? 'list' : 'board',
  };
}

/**
 * Phone board (#229): one column at a time. The saved column if this tab shows it, else the first column with tasks
 * in it, else the first column. The saved choice is kept even when a tab hides it, so coming back finds it again.
 */
export function phoneColumn(columns: readonly CardStatus[], saved: string | null, count: (s: CardStatus) => number): CardStatus {
  const keep = columns.find((s) => s === saved);
  if (keep) return keep;
  return columns.find((s) => count(s) > 0) ?? columns[0]!;
}

/**
 * The phone's status strip (#266): what needs looking at first (Running, In review, Blocked), then the queue, then
 * history. A work status with no task is left out; Done and Closed always stay, so history is one tap away.
 */
const STRIP_ORDER: readonly CardStatus[] = ['running', 'review', 'blocked', 'todo', 'ready', 'triage', 'done', 'closed'];
export function stripColumns(columns: readonly CardStatus[], count: (s: CardStatus) => number): CardStatus[] {
  return STRIP_ORDER.filter((s) => columns.includes(s) && (count(s) > 0 || s === 'done' || s === 'closed'));
}
