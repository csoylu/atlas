import type { Doc, DocKind, Folder } from '@atlas/shared';

/** The Library's type tabs (design §16, #120): All, Docs, Pages, Diagrams, Links. */
export type LibTab = 'all' | 'docs' | 'pages' | 'diagrams' | 'links';
export const LIB_TABS: { id: LibTab; label: string; kind: DocKind | null }[] = [
  { id: 'all', label: 'All', kind: null },
  { id: 'docs', label: 'Docs', kind: 'markdown' },
  { id: 'pages', label: 'Pages', kind: 'html' },
  { id: 'diagrams', label: 'Diagrams', kind: 'diagram' },
  { id: 'links', label: 'Links', kind: 'url' },
];

/** Filters: agent (whose workspace / who made it), card (attached to), chat (opened in or came from). null = any. */
export interface LibFilter {
  agent: string | null;
  card: string | null;
  chat: string | null;
}
/** The folder column: every artifact, the Unfiled ones, or one folder (its id). */
export type LibFolder = 'all' | 'unfiled' | string;
export interface LibView {
  tab: LibTab;
  folder: LibFolder;
  filter: LibFilter;
}
const NO_FILTER: LibFilter = { agent: null, card: null, chat: null };

/** The saved view (localStorage `atlas.library.view`), tolerant of anything stored before. */
export function parseLibView(raw: string | null): LibView {
  let v: Partial<LibView> = {};
  try {
    v = (raw && JSON.parse(raw)) || {};
  } catch {
    v = {}; // a corrupt entry: start from the default view
  }
  const tab = LIB_TABS.some((t) => t.id === v.tab) ? v.tab! : 'all';
  const f = (v.filter ?? {}) as Partial<LibFilter>;
  const s = (x: unknown) => (typeof x === 'string' && x ? x : null);
  return { tab, folder: s(v.folder) ?? 'all', filter: { agent: s(f.agent), card: s(f.card), chat: s(f.chat) } };
}

export const filterCount = (f: LibFilter) => (f.agent ? 1 : 0) + (f.card ? 1 : 0) + (f.chat ? 1 : 0);
export const clearFilter = (): LibFilter => ({ ...NO_FILTER });

export function inFolder(d: Doc, folder: LibFolder): boolean {
  return folder === 'all' ? true : folder === 'unfiled' ? d.folderId === null : d.folderId === folder;
}

/** Artifacts per folder column entry: all, unfiled, and each folder id. */
export function folderCounts(docs: Doc[]): Map<LibFolder, number> {
  const n = new Map<LibFolder, number>([['all', docs.length], ['unfiled', 0]]);
  for (const d of docs) {
    const k = d.folderId ?? 'unfiled';
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return n;
}

/** « Recent »: the 3 latest-changed, as live tiles on top of the list (redesign #270). */
export const recentDocs = (docs: Doc[], n = 3): Doc[] => [...docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, n);

export function matches(d: Doc, tab: LibTab, f: LibFilter): boolean {
  const kind = LIB_TABS.find((t) => t.id === tab)?.kind;
  if (kind && d.kind !== kind) return false;
  if (f.agent && d.agentId !== f.agent) return false;
  if (f.card && d.cardId !== f.card) return false;
  if (f.chat && d.chatId !== f.chat) return false;
  return true;
}

const WEEK = 7 * 24 * 3600_000;

/** Pinned on top (of the folder shown), then this week, then earlier; latest first in each. Empty groups are left out. */
export function groupDocs(docs: Doc[], now = Date.now()): { id: 'pinned' | 'week' | 'earlier'; label: string; docs: Doc[] }[] {
  const sorted = [...docs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const groups = [
    { id: 'pinned' as const, label: 'Pinned', docs: sorted.filter((d) => d.pinned) },
    { id: 'week' as const, label: 'This week', docs: sorted.filter((d) => !d.pinned && now - Date.parse(d.updatedAt) < WEEK) },
    { id: 'earlier' as const, label: 'Earlier', docs: sorted.filter((d) => !d.pinned && now - Date.parse(d.updatedAt) >= WEEK) },
  ];
  return groups.filter((g) => g.docs.length);
}

/** The short type badge of a row. */
export const TYPE_LABEL: Record<DocKind, string> = { markdown: 'md', html: 'html', diagram: 'svg', url: 'link' };

/** « just now », « 2 min ago », « 3 h ago », « yesterday », « 12 Nov »: the viewer's « v2 · 2 min ago ». */
export function relAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  if (h < 48) return 'yesterday';
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** The Library route of a document: #/library/<docId>. */
export const libraryHref = (docId: string) => '#/library/' + encodeURIComponent(docId);

/** The folder migration 0041 filled with the old canvases (converted to pages): last in the column, « Canvases (old) ». */
export const isOldCanvases = (f: Pick<Folder, 'name'>) => f.name === 'Canvases';
/** A folder's name in the Library column and chips. */
export const folderLabel = (f: Pick<Folder, 'name'>) => (isOldCanvases(f) ? 'Canvases (old)' : f.name);
/** The folders column order: as the engine gives them, the old canvases last. */
export const orderFolders = <F extends Pick<Folder, 'name'>>(fs: F[]): F[] => [...fs.filter((f) => !isOldCanvases(f)), ...fs.filter(isOldCanvases)];
