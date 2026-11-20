import { z } from 'zod';

/**
 * Artifacts (design §16 « Artifacts », #120; called documents in the code): files in an agent's workspace that Atlas
 * indexes, versions and renders in the panel beside a chat and in the Library. A link (url) is a `.url` file holding
 * the address.
 */
export const DOC_KINDS = ['markdown', 'html', 'diagram', 'url'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** Folders whose artifact files are indexed automatically; any such file can be shown with panel_open. */
export const DOC_FOLDERS = ['docs', 'pages', 'diagrams', 'links'] as const;
/** Where artifact_create writes each kind, and with which extension. */
export const KIND_FILE: Record<DocKind, { dir: (typeof DOC_FOLDERS)[number]; ext: string }> = {
  markdown: { dir: 'docs', ext: 'md' },
  html: { dir: 'pages', ext: 'html' },
  diagram: { dir: 'diagrams', ext: 'svg' },
  url: { dir: 'links', ext: 'url' },
};
/** The word for a kind (chat cards: « Document · v2 »). */
export const KIND_WORD: Record<DocKind, string> = { markdown: 'Document', html: 'Page', diagram: 'Diagram', url: 'Link' };

/** Kind of a workspace file by extension, or null if it is not an artifact. */
export function docKindOf(path: string): DocKind | null {
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'svg') return 'diagram';
  if (ext === 'url') return 'url';
  return null;
}

/** The address a link artifact holds: its first non-empty line (a Windows « URL=… » shortcut works too). */
export function linkOf(content: string): string {
  const line = content.split('\n').map((l) => l.trim()).find((l) => l && !/^\[.*\]$/.test(l)) ?? '';
  return line.replace(/^URL=/i, '');
}

/** A Library folder (flat: no nesting). */
export interface Folder {
  id: string;
  name: string;
  createdAt: string;
  /** Its project (#213): folder names are unique within a project. */
  projectId: string;
}

/** A Library search hit: titles and content, every folder. `snippet` is set when the match is in the content. */
export interface DocHit {
  doc: Doc;
  snippet: string | null;
}

export interface Doc {
  id: string;
  /** Whose workspace the file is in. */
  agentId: string;
  /** Path relative to the agent's workspace. */
  path: string;
  kind: DocKind;
  title: string;
  /** The card it is attached to (shown in the ticket modal's Documents). */
  cardId: string | null;
  version: number;
  updatedBy: string;
  updatedAt: string;
  /** Pinned in the Library (on top of its folder). */
  pinned: boolean;
  /** Library folder; null = Unfiled. */
  folderId: string | null;
  /** The direct chat it was first opened in, else the chat its card came from (the Library's chat filter). */
  chatId: string | null;
  /** The canvas (cv_ id) this page was converted from (#120); old chats link their canvas_* rows to it (#174). */
  fromCanvas: string | null;
  /** Its project (#213): the project of the workspace the file is in. */
  projectId: string;
  /**
   * Where the workspace is served (#214): `/api/files/<filesRoot>/<path>`. The agent's id for its own workdir (the
   * first project, links unchanged), `<agent>@<project>` for its workspace in another project.
   */
  filesRoot: string;
}

export interface DocVersion {
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/** One version's text. */
export interface DocContent {
  doc: Doc;
  version: number;
  content: string;
}

/**
 * What a tab of the right pane shows (#302, the workbench): an artifact, a file of the agent's workspace, a web page.
 * Only artifacts exist so far; files come with the workbench's 2/5, pages with 5/5.
 */
export type PaneKind = 'artifact' | 'file' | 'browser';

/** A tab in a chat's side panel (the workbench, #302), stored per chat in SQLite with the active one. */
export interface PanelTab {
  kind: 'artifact';
  doc: Doc;
  openedBy: string;
  openedAt: string;
  /** Last time it was opened or focused: the tab shown is the latest; a new value scrolls to `section` again. */
  focusedAt: string;
  /** Section to scroll to (markdown heading id, html element id). */
  section: string | null;
  /** The version the user last acknowledged: sections changed since are marked « changed ». */
  seenVersion: number;
  active: boolean;
  /** Title of the attached card, for « attached to card X ». */
  cardTitle: string | null;
}

/* ── Markdown sections ─────────────────────────────────────────────────── */

export interface DocSection {
  /** Slug of the heading ('' for the text before the first heading); unique in the document. */
  id: string;
  title: string | null;
  level: number;
  /** The section's markdown, its heading line included. */
  text: string;
  /** Its first line in the document (1-based): the heading's, or 1 for the text before the first heading. */
  line: number;
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`*_~[\]()<>#]/g, '')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section';

/** Split markdown at headings of level 1-3 (outside code fences). Deeper headings stay inside their section. */
export function splitSections(md: string): DocSection[] {
  const out: DocSection[] = [];
  const seen = new Map<string, number>();
  let cur: DocSection = { id: '', title: null, level: 0, text: '', line: 1 };
  let fence: string | null = null;
  let no = 0;
  for (const line of md.split('\n')) {
    no++;
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence ? (fence === f[1] ? null : fence) : f[1]!;
    const h = fence ? null : /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (cur.title !== null || cur.text.trim()) out.push(cur);
      const base = slug(h[2]!);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      cur = { id: n === 1 ? base : `${base}-${n}`, title: h[2]!, level: h[1]!.length, text: line + '\n', line: no };
    } else cur.text += line + '\n';
  }
  if (cur.title !== null || cur.text.trim()) out.push(cur);
  for (const s of out) s.text = s.text.replace(/\n+$/, '\n');
  return out;
}

/** Find a section by id or (case-insensitively) by heading text. */
export function findSection(sections: DocSection[], key: string): DocSection | undefined {
  const k = key.trim().replace(/^#/, '');
  return sections.find((s) => s.id === k) ?? sections.find((s) => s.title?.toLowerCase() === k.toLowerCase()) ?? sections.find((s) => s.id === slug(k));
}

/** Ids of the sections whose text differs between two versions (new sections count as changed). */
export function changedSections(before: string, after: string): Set<string> {
  const old = new Map(splitSections(before).map((s) => [s.id, s.text.trim()]));
  return new Set(splitSections(after).filter((s) => old.get(s.id) !== s.text.trim()).map((s) => s.id));
}

/**
 * Title of a document: first markdown heading, html <title>/<h1>, svg <title>; else the name it was created with
 * (artifact_create's title), else the file name.
 */
export function docTitle(path: string, content: string, name: string | null = null): string {
  const kind = docKindOf(path);
  if (kind === 'url') return name || path.split('/').pop()!;
  const clean = (s: string | undefined) => s?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const t =
    kind === 'markdown'
      ? clean(/^#{1,3}\s+(.+)$/m.exec(content)?.[1])
      : clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(content)?.[1] ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(content)?.[1]);
  return t || name || path.split('/').pop()!;
}

/* ── The reference of an old message (« Ask about this », replaced by comments #304) ── */

/** Parse an old « Ask about this » block (❝, before #304): the UI still shows it as a quote chip. */
export function parseDocRef(text: string): { label: string; docId: string; version: number; section: string | null } | null {
  const m = /^❝ (.+)\n\(the user is asking about .+, (doc_[\w-]+) v(\d+)(?:, section #([^;\s]+))?; quoted below\)/.exec(text);
  return m ? { label: m[1]!, docId: m[2]!, version: Number(m[3]), section: m[4] ?? null } : null;
}
