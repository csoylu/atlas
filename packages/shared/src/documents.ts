import { z } from 'zod';

/**
 * Documents (design §16 « Side panel »): files in an agent's workspace that Atlas indexes, versions and renders in the
 * panel beside a chat. A whiteboard is an existing canvas shown as a document.
 */
export const DOC_KINDS = ['markdown', 'html', 'diagram', 'whiteboard'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** Folders whose .md / .html / .svg files are indexed automatically; any such file can be opened with panel_open. */
export const DOC_FOLDERS = ['docs', 'pages', 'diagrams'] as const;

/** Kind of a workspace file by extension, or null if the panel can't show it. */
export function docKindOf(path: string): Exclude<DocKind, 'whiteboard'> | null {
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'svg') return 'diagram';
  return null;
}

export interface Doc {
  id: string;
  /** Whose workspace the file is in (whiteboards: who opened it first). */
  agentId: string;
  /** Path relative to the agent's workspace; null for whiteboards. */
  path: string | null;
  /** Whiteboards: the canvas. */
  canvasId: string | null;
  kind: DocKind;
  title: string;
  /** The card it is attached to (shown in the ticket modal's Documents). */
  cardId: string | null;
  version: number;
  updatedBy: string;
  updatedAt: string;
  /** Pinned in the Library (on top of the list). */
  pinned: boolean;
  /** The direct chat it was first opened in, else the chat its card came from (the Library's chat filter). */
  chatId: string | null;
}

export interface DocVersion {
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/** One version's text (whiteboards: empty, the canvas is read through the canvas API). */
export interface DocContent {
  doc: Doc;
  version: number;
  content: string;
}

/** A tab in a chat's side panel. */
export interface PanelTab {
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

/** « Ask about this »: the part of a document a user message is about. */
export const DocRef = z.object({
  docId: z.string().min(1),
  version: z.number().int().nonnegative(),
  section: z.string().nullable().default(null),
});
export type DocRef = z.infer<typeof DocRef>;

/* ── Markdown sections ─────────────────────────────────────────────────── */

export interface DocSection {
  /** Slug of the heading ('' for the text before the first heading); unique in the document. */
  id: string;
  title: string | null;
  level: number;
  /** The section's markdown, its heading line included. */
  text: string;
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
  let cur: DocSection = { id: '', title: null, level: 0, text: '' };
  let fence: string | null = null;
  for (const line of md.split('\n')) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence ? (fence === f[1] ? null : fence) : f[1]!;
    const h = fence ? null : /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (cur.title !== null || cur.text.trim()) out.push(cur);
      const base = slug(h[2]!);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      cur = { id: n === 1 ? base : `${base}-${n}`, title: h[2]!, level: h[1]!.length, text: line + '\n' };
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

/** Title of a document: first markdown heading, html <title>/<h1>, svg <title>, else the file name. */
export function docTitle(path: string, content: string): string {
  const kind = docKindOf(path);
  const clean = (s: string | undefined) => s?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const t =
    kind === 'markdown'
      ? clean(/^#{1,3}\s+(.+)$/m.exec(content)?.[1])
      : clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(content)?.[1] ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(content)?.[1]);
  return t || path.split('/').pop()!;
}

/* ── The reference carried by a message (« Ask about this ») ─────────────── */

const EXCERPT_CAP = 1500;

/**
 * The text block put before the user's message: the label the UI shows as a quote chip, where it is (path, doc id,
 * version, section), and the quoted section so the agent knows exactly what is meant.
 */
export function formatDocRef(doc: Pick<Doc, 'id' | 'title' | 'path' | 'canvasId'>, version: number, section: DocSection | null): string {
  const label = section?.title ? `${doc.title} › ${section.title}` : doc.title;
  const where = doc.path ?? `canvas ${doc.canvasId}`;
  const head = `❝ ${label}\n(the user is asking about ${where}, ${doc.id} v${version}${section ? `, section #${section.id}` : ''}; quoted below)`;
  if (!section) return head;
  const body = section.text.trim();
  const quoted = (body.length > EXCERPT_CAP ? body.slice(0, EXCERPT_CAP) + '…' : body)
    .split('\n')
    .map((l) => '> ' + l)
    .join('\n');
  return head + '\n' + quoted;
}

/** Parse a block written by formatDocRef (the UI turns it into a quote chip). */
export function parseDocRef(text: string): { label: string; docId: string; version: number; section: string | null } | null {
  const m = /^❝ (.+)\n\(the user is asking about .+, (doc_[\w-]+) v(\d+)(?:, section #([^;\s]+))?; quoted below\)/.exec(text);
  return m ? { label: m[1]!, docId: m[2]!, version: Number(m[3]), section: m[4] ?? null } : null;
}
