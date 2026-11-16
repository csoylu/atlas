import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { DOC_FOLDERS, docKindOf, docTitle, type Doc, type DocContent, type DocVersion, type PanelTab } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import type { Canvases } from './canvas.ts';
import { ConflictError, InvalidError, NotFoundError, type Kanban } from './kanban.ts';
import { inside } from './tools.ts';

const KEEP_VERSIONS = 50;
/** Bigger files are not documents (the panel renders them whole). */
export const MAX_DOC_BYTES = 1_000_000;
/** Tabs per chat panel: opening one more closes the one focused longest ago. */
export const MAX_TABS = 8;
const SCAN_CAP = 500;

interface Row {
  id: string;
  agent_id: string;
  path: string | null;
  canvas_id: string | null;
  kind: Doc['kind'];
  title: string;
  card_id: string | null;
  version: number;
  updated_by: string;
  updated_at: string;
  file_stamp: string | null;
  pinned_at: string | null;
  /** COALESCE(chat_id, the card's origin chat), from DOC_SELECT. */
  chat: string | null;
}
/** Documents with the chat they belong to: where first opened, else where their card came from. */
const DOC_SELECT = 'SELECT d.*, COALESCE(d.chat_id, c.origin_card) AS chat FROM documents d LEFT JOIN cards c ON c.id = d.card_id';
const toDoc = (r: Row): Doc => ({
  id: r.id,
  agentId: r.agent_id,
  path: r.path,
  canvasId: r.canvas_id,
  kind: r.kind,
  title: r.title,
  cardId: r.card_id,
  version: r.version,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
  pinned: r.pinned_at !== null,
  chatId: r.chat,
});

const stampOf = (file: string) => {
  const s = statSync(file);
  return { stamp: `${s.mtimeMs}:${s.size}`, size: s.size, isFile: s.isFile() };
};

/**
 * Documents (design §16 « Side panel »): files in agents' workspaces, indexed and versioned here, and the tabs each
 * direct chat's side panel shows. The file is the truth; a version is recorded whenever its content is seen to change
 * (after an agent's file tools or shell, and whenever a document is read).
 */
export class Documents {
  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private canvases: Canvases,
    /** An agent's workspace folder. */
    private workdirOf: (agentId: string) => string,
  ) {}

  get(id: string): Doc {
    const row = this.db.prepare(DOC_SELECT + ' WHERE d.id = ?').get(id) as Row | undefined;
    if (!row) throw new NotFoundError(`document ${id} not found`);
    return toDoc(row);
  }

  list(filter: { cardId?: string } = {}): Doc[] {
    const rows = filter.cardId
      ? this.db.prepare(DOC_SELECT + ' WHERE d.card_id = ? ORDER BY d.updated_at DESC').all(filter.cardId)
      : this.db.prepare(DOC_SELECT + ' ORDER BY d.updated_at DESC').all();
    return (rows as Row[]).map(toDoc);
  }

  /**
   * The Library: every document, fresh. Re-reads every agent's doc folders (edits made outside Atlas, files no run has
   * synced yet) and makes every canvas a whiteboard document, then lists them, latest first.
   */
  library(): Doc[] {
    const agents = this.db.prepare('SELECT id FROM agents').all() as { id: string }[];
    for (const a of agents) this.sync(a.id, a.id);
    this.syncWhiteboards();
    return this.list();
  }

  /** Pin a document on top of the Library, or unpin it. */
  pin(id: string, pinned: boolean): Doc {
    this.get(id);
    this.db.prepare('UPDATE documents SET pinned_at = ? WHERE id = ?').run(pinned ? new Date().toISOString() : null, id);
    const doc = this.get(id);
    this.bus.emit({ type: 'document.updated', doc });
    return doc;
  }

  /** Every canvas gets its whiteboard document, with the canvas's current name and version. */
  private syncWhiteboards(): void {
    const canvases = this.db.prepare('SELECT id, name, version, updated_by, updated_at FROM canvases').all() as {
      id: string;
      name: string;
      version: number;
      updated_by: string;
      updated_at: string;
    }[];
    const changed: string[] = [];
    this.db
      .transaction(() => {
        for (const c of canvases) {
          const row = this.db.prepare('SELECT id, title, version FROM documents WHERE canvas_id = ?').get(c.id) as { id: string; title: string; version: number } | undefined;
          if (!row) {
            const id = newId();
            this.db
              .prepare("INSERT INTO documents (id, agent_id, canvas_id, kind, title, version, updated_by, updated_at) VALUES (?, ?, ?, 'whiteboard', ?, ?, ?, ?)")
              .run(id, c.updated_by, c.id, c.name, c.version, c.updated_by, c.updated_at);
            changed.push(id);
          } else if (row.title !== c.name || row.version !== c.version) {
            this.db.prepare('UPDATE documents SET title = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(c.name, c.version, c.updated_by, c.updated_at, row.id);
            changed.push(row.id);
          }
        }
      })
      .immediate();
    for (const id of changed) this.bus.emit({ type: 'document.updated', doc: this.get(id) });
  }

  /** The document of a workspace file, if indexed. */
  byPath(agentId: string, path: string): Doc | null {
    const rel = this.rel(agentId, path);
    const row = this.db.prepare(DOC_SELECT + ' WHERE d.agent_id = ? AND d.path = ?').get(agentId, rel) as Row | undefined;
    return row ? toDoc(row) : null;
  }

  /**
   * Index one file of an agent's workspace: create its document, or add a version if the content changed.
   * `cardId` attaches the document to that card when it isn't attached yet.
   */
  indexFile(agentId: string, path: string, by: string, cardId: string | null = null): Doc {
    const root = this.workdirOf(agentId);
    const full = inside(root, path);
    const rel = this.rel(agentId, path);
    if (!docKindOf(rel)) throw new InvalidError(`${rel}: the panel shows .md, .html and .svg files`);
    let st: ReturnType<typeof stampOf>;
    try {
      st = stampOf(full);
    } catch {
      throw new NotFoundError(`no file ${rel} in ${agentId}'s workspace`);
    }
    if (!st.isFile) throw new InvalidError(`${rel} is not a file`);
    if (st.size > MAX_DOC_BYTES) throw new InvalidError(`${rel} is ${st.size} bytes; documents are at most ${MAX_DOC_BYTES}`);
    const content = readFileSync(full, 'utf8');
    return this.record(agentId, rel, content, st.stamp, by, cardId).doc;
  }

  /**
   * Re-read the agent's indexed files that changed on disk, and index new files in docs/, pages/ and diagrams/.
   * Returns the documents that got a new version. Missing files are left as they were (their versions stay readable).
   */
  sync(agentId: string, by: string, cardId: string | null = null): Doc[] {
    const root = this.workdirOf(agentId);
    const changed: Doc[] = [];
    const known = this.db.prepare('SELECT * FROM documents WHERE agent_id = ? AND path IS NOT NULL').all(agentId) as Row[];
    const seen = new Set<string>();
    for (const r of known) {
      seen.add(r.path!);
      let st: ReturnType<typeof stampOf>;
      try {
        st = stampOf(inside(root, r.path!));
      } catch {
        continue; // deleted or moved: keep the versions
      }
      if (st.stamp === r.file_stamp || !st.isFile || st.size > MAX_DOC_BYTES) continue;
      const res = this.record(agentId, r.path!, readFileSync(inside(root, r.path!), 'utf8'), st.stamp, by, cardId);
      if (res.changed) changed.push(res.doc);
    }
    for (const rel of this.scan(root)) {
      if (seen.has(rel)) continue;
      const st = stampOf(join(root, rel));
      if (st.size > MAX_DOC_BYTES) continue;
      changed.push(this.record(agentId, rel, readFileSync(join(root, rel), 'utf8'), st.stamp, by, cardId).doc);
    }
    return changed;
  }

  /** The document showing a canvas as a whiteboard (created on first use). */
  whiteboard(canvasId: string, agentId: string, cardId: string | null = null): Doc {
    const canvas = this.canvases.get(canvasId);
    const row = this.db.prepare('SELECT * FROM documents WHERE canvas_id = ?').get(canvasId) as Row | undefined;
    const now = new Date().toISOString();
    if (row) {
      this.db
        .prepare('UPDATE documents SET title = ?, version = ?, updated_by = ?, updated_at = ?, card_id = COALESCE(card_id, ?) WHERE id = ?')
        .run(canvas.name, canvas.version, canvas.updatedBy, canvas.updatedAt || now, cardId, row.id);
    } else {
      this.db
        .prepare("INSERT INTO documents (id, agent_id, canvas_id, kind, title, card_id, version, updated_by, updated_at) VALUES (?, ?, ?, 'whiteboard', ?, ?, ?, ?, ?)")
        .run(newId(), agentId, canvasId, canvas.name, cardId, canvas.version, canvas.updatedBy, canvas.updatedAt || now);
    }
    const doc = toDoc(this.db.prepare(DOC_SELECT + ' WHERE d.canvas_id = ?').get(canvasId) as Row);
    this.bus.emit({ type: 'document.updated', doc });
    return doc;
  }

  /** A version's text (default the latest, re-synced from the file first). Whiteboards: empty, at the canvas version. */
  content(id: string, version?: number): DocContent {
    let doc = this.get(id);
    if (doc.kind === 'whiteboard') {
      const canvas = this.canvases.get(doc.canvasId!);
      return { doc: { ...doc, version: canvas.version, title: canvas.name }, version: canvas.version, content: '' };
    }
    if (version === undefined) {
      doc = this.resync(doc);
      version = doc.version;
    }
    const row = this.db.prepare('SELECT content FROM document_versions WHERE doc_id = ? AND version = ?').get(id, version) as
      | { content: string }
      | undefined;
    if (!row) throw new NotFoundError(`document ${id} has no version ${version} (the last ${KEEP_VERSIONS} are kept)`);
    return { doc, version, content: row.content };
  }

  versions(id: string): DocVersion[] {
    const doc = this.get(id);
    if (doc.kind === 'whiteboard') return this.canvases.versions(doc.canvasId!);
    return (
      this.db
        .prepare('SELECT version, updated_by, updated_at FROM document_versions WHERE doc_id = ? ORDER BY version DESC')
        .all(id) as { version: number; updated_by: string; updated_at: string }[]
    ).map((r) => ({ version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at }));
  }

  /** Go back to an earlier version: the file gets that content again, recorded as a new version (undoable). */
  restore(id: string, version: number, by: string): Doc {
    const doc = this.get(id);
    if (doc.kind === 'whiteboard') {
      this.canvases.restore(doc.canvasId!, version, by);
      return this.whiteboard(doc.canvasId!, doc.agentId);
    }
    const { content } = this.content(id, version);
    const full = inside(this.workdirOf(doc.agentId), doc.path!);
    writeFileSync(full, content);
    return this.record(doc.agentId, doc.path!, content, stampOf(full).stamp, by, null).doc;
  }

  attach(id: string, cardId: string): Doc {
    this.kanban.get(cardId);
    this.db.prepare('UPDATE documents SET card_id = ? WHERE id = ?').run(cardId, id);
    const doc = this.get(id);
    this.bus.emit({ type: 'document.updated', doc });
    return doc;
  }

  /* ── Side panel tabs (one panel per direct chat) ─────────────────────── */

  tabs(chatId: string): PanelTab[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, c.title AS card_title FROM panel_tabs t JOIN documents d ON d.id = t.doc_id
         LEFT JOIN cards c ON c.id = d.card_id WHERE t.chat_id = ? ORDER BY t.opened_at, t.rowid`,
      )
      .all(chatId) as { doc_id: string; opened_by: string; opened_at: string; focused_at: string; section: string | null; seen_version: number; card_title: string | null }[];
    const active = rows.reduce<(typeof rows)[number] | null>((a, r) => (!a || r.focused_at >= a.focused_at ? r : a), null);
    return rows.map((r) => ({
      doc: this.get(r.doc_id),
      openedBy: r.opened_by,
      openedAt: r.opened_at,
      focusedAt: r.focused_at,
      section: r.section,
      seenVersion: r.seen_version,
      active: r === active,
      cardTitle: r.card_title,
    }));
  }

  /** Open a document in a chat's panel (or focus it and scroll to `section` if it's open). */
  open(chatId: string, docId: string, by: string, section: string | null = null): PanelTab[] {
    this.chat(chatId);
    const doc = this.get(docId);
    const now = this.now(chatId);
    this.db
      .transaction(() => {
        const had = this.db.prepare('SELECT 1 FROM panel_tabs WHERE chat_id = ? AND doc_id = ?').get(chatId, docId);
        this.db.prepare('UPDATE documents SET chat_id = COALESCE(chat_id, ?) WHERE id = ?').run(chatId, docId);
        if (had) this.db.prepare('UPDATE panel_tabs SET focused_at = ?, section = ?, opened_by = ? WHERE chat_id = ? AND doc_id = ?').run(now, section, by, chatId, docId);
        else {
          this.db.prepare('INSERT INTO panel_tabs (chat_id, doc_id, opened_by, opened_at, focused_at, section, seen_version) VALUES (?, ?, ?, ?, ?, ?, ?)').run(chatId, docId, by, now, now, section, doc.version);
          const extra = this.db.prepare('SELECT doc_id FROM panel_tabs WHERE chat_id = ? ORDER BY focused_at DESC, rowid DESC LIMIT -1 OFFSET ?').all(chatId, MAX_TABS) as { doc_id: string }[];
          for (const e of extra) this.db.prepare('DELETE FROM panel_tabs WHERE chat_id = ? AND doc_id = ?').run(chatId, e.doc_id);
        }
      })
      .immediate();
    return this.emitPanel(chatId);
  }

  /** Close one tab, or the whole panel (docId null). */
  close(chatId: string, docId: string | null): PanelTab[] {
    this.chat(chatId);
    if (docId) {
      const r = this.db.prepare('DELETE FROM panel_tabs WHERE chat_id = ? AND doc_id = ?').run(chatId, docId);
      if (!r.changes) throw new NotFoundError(`document ${docId} is not open in chat ${chatId}`);
    } else this.db.prepare('DELETE FROM panel_tabs WHERE chat_id = ?').run(chatId);
    return this.emitPanel(chatId);
  }

  /** The user shows a tab: it becomes the active one and its changes count as seen. */
  focus(chatId: string, docId: string): PanelTab[] {
    const doc = this.get(docId);
    const r = this.db
      .prepare('UPDATE panel_tabs SET focused_at = ?, seen_version = ?, section = NULL WHERE chat_id = ? AND doc_id = ?')
      .run(this.now(chatId), this.resync(doc).version, chatId, docId);
    if (!r.changes) throw new NotFoundError(`document ${docId} is not open in chat ${chatId}`);
    return this.emitPanel(chatId);
  }

  /** The user dismisses the « changed » marks of a tab. */
  seen(chatId: string, docId: string): PanelTab[] {
    const doc = this.get(docId);
    const r = this.db.prepare('UPDATE panel_tabs SET seen_version = ? WHERE chat_id = ? AND doc_id = ?').run(doc.version, chatId, docId);
    if (!r.changes) throw new NotFoundError(`document ${docId} is not open in chat ${chatId}`);
    return this.emitPanel(chatId);
  }

  /* ── internals ─────────────────────────────────────────────────────────── */

  private chat(chatId: string): void {
    if (this.kanban.get(chatId).board !== 'direct') throw new ConflictError(`${chatId} is not a direct chat: panels belong to chats`);
  }

  /** A timestamp strictly after the chat's latest focus, so the order of tabs is exact even within a millisecond. */
  private now(chatId: string): string {
    const now = new Date().toISOString();
    const last = (this.db.prepare('SELECT MAX(focused_at) AS m FROM panel_tabs WHERE chat_id = ?').get(chatId) as { m: string | null }).m;
    return last && last >= now ? new Date(Date.parse(last) + 1).toISOString() : now;
  }

  private rel(agentId: string, path: string): string {
    const root = this.workdirOf(agentId);
    return relative(root, inside(root, path)).split(sep).join('/');
  }

  private resync(doc: Doc): Doc {
    if (!doc.path) return doc;
    const root = this.workdirOf(doc.agentId);
    let st: ReturnType<typeof stampOf>;
    try {
      st = stampOf(inside(root, doc.path));
    } catch {
      return doc;
    }
    const row = this.db.prepare('SELECT file_stamp FROM documents WHERE id = ?').get(doc.id) as { file_stamp: string | null };
    if (st.stamp === row.file_stamp || !st.isFile || st.size > MAX_DOC_BYTES) return doc;
    return this.record(doc.agentId, doc.path, readFileSync(inside(root, doc.path), 'utf8'), st.stamp, doc.agentId, null).doc;
  }

  /** docs/, pages/, diagrams/ files the panel can show (3 levels deep, capped). */
  private scan(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, depth: number) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= SCAN_CAP || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.isFile() && docKindOf(e.name)) out.push(relative(root, p).split(sep).join('/'));
      }
    };
    for (const f of DOC_FOLDERS) walk(join(root, f), 1);
    return out;
  }

  private record(agentId: string, rel: string, content: string, stamp: string, by: string, cardId: string | null): { doc: Doc; changed: boolean } {
    const kind = docKindOf(rel)!;
    const title = docTitle(rel, content);
    const now = new Date().toISOString();
    let changed = false;
    const doc = this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM documents WHERE agent_id = ? AND path = ?').get(agentId, rel) as Row | undefined;
        if (!row) {
          const id = newId();
          this.db
            .prepare('INSERT INTO documents (id, agent_id, path, kind, title, card_id, version, updated_by, updated_at, file_stamp) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)')
            .run(id, agentId, rel, kind, title, cardId, by, now, stamp);
          this.db.prepare('INSERT INTO document_versions VALUES (?, 1, ?, ?, ?)').run(id, content, by, now);
          changed = true;
          return this.get(id);
        }
        const last = this.db.prepare('SELECT content FROM document_versions WHERE doc_id = ? AND version = ?').get(row.id, row.version) as
          | { content: string }
          | undefined;
        if (last?.content === content) {
          this.db.prepare('UPDATE documents SET file_stamp = ?, card_id = COALESCE(card_id, ?) WHERE id = ?').run(stamp, cardId, row.id);
          return this.get(row.id);
        }
        const version = row.version + 1;
        this.db
          .prepare('UPDATE documents SET title = ?, version = ?, updated_by = ?, updated_at = ?, file_stamp = ?, card_id = COALESCE(card_id, ?) WHERE id = ?')
          .run(title, version, by, now, stamp, cardId, row.id);
        this.db.prepare('INSERT INTO document_versions VALUES (?, ?, ?, ?, ?)').run(row.id, version, content, by, now);
        this.db.prepare('DELETE FROM document_versions WHERE doc_id = ? AND version <= ?').run(row.id, version - KEEP_VERSIONS);
        changed = true;
        return this.get(row.id);
      })
      .immediate();
    if (changed) this.bus.emit({ type: 'document.updated', doc });
    return { doc, changed };
  }

  private emitPanel(chatId: string): PanelTab[] {
    const tabs = this.tabs(chatId);
    this.bus.emit({ type: 'panel.updated', chatId, tabs });
    return tabs;
  }
}

const newId = () => 'doc_' + randomUUID().slice(0, 8);
