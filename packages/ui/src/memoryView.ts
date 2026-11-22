import type { Card, Inbox, Memory, MemoryChange, MemoryKind, Notification } from '@atlas/shared';

/**
 * Settings → Memory and the Inbox's daily memory digest (#82, mockup canvas cv_ae0bb676 « mock »): the pure part,
 * tested in memoryView.test.ts; MemoryPage.tsx and MemoryDigest.tsx draw it.
 */

export const KIND_CHIPS: { id: MemoryKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'rule', label: 'Rules' },
  { id: 'preference', label: 'Preferences' },
  { id: 'fact', label: 'Facts' },
  { id: 'project', label: 'Task notes' },
];
/** The short badge of a kind. */
/** `project` is shown as task notes (#215): « project » means a project now. */
export const KIND_BADGE: Record<MemoryKind, string> = { rule: 'rule', preference: 'pref', fact: 'fact', project: 'task' };

/** `live` = active and stale (stale ones dimmed); `stale` / `archived` show only those. */
export type MemStatus = 'live' | 'stale' | 'archived';
export interface MemView {
  kind: MemoryKind | 'all';
  status: MemStatus;
  /** `global`, `shared`, `agent:<id>` or null = every scope. */
  scope: string | null;
}
export const DEFAULT_VIEW: MemView = { kind: 'all', status: 'live', scope: null };

/** The saved view (localStorage `atlas.memory.view`), tolerant of anything stored before. */
export function parseMemView(raw: string | null): MemView {
  let v: Partial<MemView> = {};
  try {
    v = (raw && JSON.parse(raw)) || {};
  } catch {
    v = {}; // a corrupt entry: the default view
  }
  return {
    kind: KIND_CHIPS.some((k) => k.id === v.kind) ? v.kind! : 'all',
    status: v.status === 'stale' || v.status === 'archived' ? v.status : 'live',
    scope: typeof v.scope === 'string' && isScope(v.scope) ? v.scope : null,
  };
}
const isScope = (s: string) => /^(global|shared|agent:[a-z][a-z0-9_-]*)$/.test(s);

/**
 * What follows #/settings/memory: a scope (« shared », « agent:atlas ») filters the page, a memory id (« m12 ») shows
 * that memory.
 */
export function parseMemoryRoute(rest: string): { scope: string | null; focus: number | null } {
  const m = /^m(\d+)$/i.exec(rest);
  if (m) return { scope: null, focus: Number(m[1]) };
  return { scope: isScope(rest) ? rest : null, focus: null };
}
/** #/settings/memory, #/settings/memory/shared, #/settings/memory/agent:atlas or #/settings/memory/m12 (#87; it was in the Library). */
export const memoryHref = (rest?: string | number | null) =>
  '#/settings/memory' + (rest === null || rest === undefined || rest === '' ? '' : '/' + (typeof rest === 'number' ? 'm' + rest : rest));

const inStatus = (m: Memory, s: MemStatus) => (s === 'live' ? m.status !== 'archived' : m.status === s);

/** The rows shown: status, then kind (scope and search are done by the API). Pinned first, then newest change. */
export function shownMemories(list: Memory[], v: Pick<MemView, 'kind' | 'status'>): Memory[] {
  return list
    .filter((m) => inStatus(m, v.status) && (v.kind === 'all' || m.kind === v.kind))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.status === 'stale' ? 1 : 0) - (b.status === 'stale' ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt));
}

/** The chips' counts: each kind within the status shown; Stale and Archived over every kind. */
export function chipCounts(list: Memory[], status: MemStatus): Record<MemoryKind | 'all' | 'stale' | 'archived', number> {
  const live = list.filter((m) => inStatus(m, status));
  const n = (k: MemoryKind) => live.filter((m) => m.kind === k).length;
  return {
    all: live.length,
    rule: n('rule'),
    preference: n('preference'),
    fact: n('fact'),
    project: n('project'),
    stale: list.filter((m) => m.status === 'stale').length,
    archived: list.filter((m) => m.status === 'archived').length,
  };
}

/** « shared », « @atlas ». */
export const scopeLabel = (scope: string) => (scope === 'shared' || scope === 'global' ? scope : '@' + scope.replace(/^agent:/, ''));

/**
 * Where a memory came from, as a link: the chat (#/chat/<id>?msg=<seq>) or the board card's ticket (?card=<id>&msg=<seq>
 * over the current view). A task note with no source conversation points at its card. null: no source (v1 memory).
 */
export function sourceLink(
  m: Pick<Memory, 'sourceCardId' | 'sourceSeq' | 'cardId'>,
  chats: Pick<Card, 'id'>[],
  currentPath: string,
): { href: string; chat: boolean; cardId: string } | null {
  const id = m.sourceCardId ?? m.cardId;
  if (!id) return null;
  const seq = m.sourceCardId && m.sourceSeq ? m.sourceSeq : null;
  if (chats.some((c) => c.id === id)) return { href: `#/chat/${id}` + (seq ? `?msg=${seq}` : ''), chat: true, cardId: id };
  return { href: `${currentPath || '#/board'}?card=${encodeURIComponent(id)}` + (seq ? `&msg=${seq}` : ''), chat: false, cardId: id };
}

/** The message a link asks the conversation of `cardId` to show (?msg=<seq>): in its ticket (?card=) or its chat route. */
export function focusSeqFor(hash: string, cardId: string): number | null {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  const p = new URLSearchParams(hash.slice(q + 1));
  const seq = Number(p.get('msg'));
  if (!Number.isInteger(seq) || seq < 1) return null;
  const card = p.get('card');
  if (card) return card === cardId ? seq : null;
  return hash.slice(0, q) === '#/chat/' + cardId ? seq : null;
}

/** The message group showing `seq`: the last one starting at or before it (tool results sit inside an agent's turn). */
export function groupForSeq(starts: number[], seq: number): number {
  let found = -1;
  starts.forEach((s, i) => {
    if (s <= seq) found = i;
  });
  return found;
}

/* ── Daily digest ─────────────────────────────────────────────────────────── */

/**
 * What the digest reports: changes by agents, and task notes gone stale (even when your move of the card did it);
 * not your own edits, not confirmations or undos.
 */
export const digestWorthy = (c: MemoryChange) => c.action === 'stale' || (c.by !== 'user' && c.action !== 'confirm' && c.action !== 'undo');

export const ACTION_LABEL: Record<MemoryChange['action'], string> = {
  add: 'added',
  update: 'changed',
  confirm: 'confirmed',
  forget: 'archived',
  restore: 'restored',
  pin: 'pinned',
  unpin: 'unpinned',
  stale: 'went stale',
  undo: 'undone',
};

/**
 * The changes Undo applies to: the latest not-undone change of each memory (the engine refuses older ones, so their
 * button is off with the reason).
 */
export function undoable(changes: MemoryChange[]): Set<number> {
  const latest = new Map<number, number>();
  for (const c of changes) {
    if (c.action === 'confirm' || c.action === 'undo' || c.undoneBy) continue;
    latest.set(c.memoryId, Math.max(latest.get(c.memoryId) ?? 0, c.id));
  }
  return new Set(latest.values());
}

/** The digest's saved marks (localStorage `atlas.memory.digest`): read up to `seen`, archived up to `archived`. */
export interface DigestMarks {
  seen: string | null;
  archived: string | null;
}
export function parseMarks(raw: string | null): DigestMarks {
  try {
    const v = (raw && JSON.parse(raw)) || {};
    const s = (x: unknown) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? x : null);
    return { seen: s(v.seen), archived: s(v.archived) };
  } catch {
    return { seen: null, archived: null }; // a corrupt entry: nothing read yet
  }
}

/** The digest's changes: worthy ones after the archive mark, newest first. */
export const digestChanges = (changes: MemoryChange[], marks: DigestMarks) =>
  changes.filter((c) => digestWorthy(c) && (!marks.archived || c.at > marks.archived)).sort((a, b) => b.id - a.id);

/** Synthetic id of the digest's Inbox row (never a real notification id). */
export const DIGEST_ID = -1;
export const DIGEST_KIND = 'memory.digest';

/** « 3 added, 1 changed » for the digest's line in the list. */
export function digestLine(changes: MemoryChange[]): string {
  const order: MemoryChange['action'][] = ['add', 'update', 'forget', 'restore', 'pin', 'unpin', 'stale'];
  const counts = order.map((a) => [a, changes.filter((c) => c.action === a).length] as const).filter(([, n]) => n);
  const who = [...new Set(changes.filter((c) => c.action !== 'stale').map((c) => '@' + c.by))];
  return counts.map(([a, n]) => `${n} ${ACTION_LABEL[a]}`).join(', ') + (who.length ? ` · by ${who.join(', ')}` : '');
}

/** The Inbox with the digest among its updates (by time, newest first); an unread digest counts in the badge. */
export function withDigest(inbox: Inbox, digest: Notification | null): Inbox {
  if (!digest) return inbox;
  const updates = [...inbox.updates.filter((u) => u.id !== DIGEST_ID), digest].sort((a, b) => b.at.localeCompare(a.at));
  return { ...inbox, updates, badge: inbox.badge + (digest.readAt ? 0 : 1) };
}

/** The digest as an Inbox update row (null when nothing changed): it sits among the updates by its newest change. */
export function digestItem(changes: MemoryChange[], marks: DigestMarks): Notification | null {
  const list = digestChanges(changes, marks);
  if (!list.length) return null;
  const at = list[0]!.at;
  const n = new Set(list.map((c) => c.memoryId)).size;
  return {
    id: DIGEST_ID,
    kind: DIGEST_KIND,
    at,
    title: `Memory: ${n} ${n === 1 ? 'memory' : 'memories'} changed in the last day`,
    body: digestLine(list),
    cardId: null,
    readAt: marks.seen && marks.seen >= at ? marks.seen : null,
    archivedAt: null,
    projectId: null,
    link: null,
  };
}
