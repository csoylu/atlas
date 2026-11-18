import { CARD_STATUSES, type Card, type CardStatus } from '@atlas/shared';

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

/** The card's one line under the title: why it is blocked, else why it isn't running. Null when it is moving. */
export function whyLine(c: Pick<Card, 'status' | 'block' | 'waiting'>): { text: string; blocked: boolean } | null {
  if (c.status === 'blocked' && c.block) {
    const first = c.block.reason.split('\n').find((l) => l.trim()) ?? '';
    const kind = c.block.kind === 'needs_input' ? 'Needs your answer' : c.block.kind === 'capability' ? 'Missing access' : c.block.kind === 'dependency' ? 'Waiting on other work' : 'Retrying later';
    const text = first.replace(/^[#>*\s-]+/, '').trim();
    return { text: text ? `${kind} · ${text}` : kind, blocked: true };
  }
  if (c.waiting) return { text: c.waiting, blocked: false };
  return null;
}

/**
 * Whether the « after #N » label is worth showing: not when the why-line already names every parent
 * (« waiting on #61 (running) », « parent #61 was closed… »), so the dependency isn't said twice.
 * `refs` = the parents as shown (« #61 »).
 */
export function showAfterLabel(c: Pick<Card, 'status' | 'block' | 'waiting'>, refs: string[]): boolean {
  if (refs.length === 0) return false;
  const why = whyLine(c);
  if (!why || why.blocked) return true;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !refs.every((r) => new RegExp(esc(r) + '(?![0-9A-Za-z])').test(why.text));
}

/** Saved view state (tab, filter, layout), kept across reloads; anything unreadable falls back to the default. */
export type BoardView = { tab: BoardTab; filter: BoardFilter; layout: BoardLayout; showEmpty: boolean };
export function parseView(raw: string | null): BoardView {
  const def: BoardView = { tab: 'all', filter: { agent: null, priority: null }, layout: 'board', showEmpty: false };
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
    showEmpty: o.showEmpty === true,
  };
}
