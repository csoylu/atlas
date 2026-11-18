import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { DOC_FOLDERS, KIND_FILE, docKindOf, docTitle, type Doc, type DocContent, type DocHit, type DocKind, type DocVersion, type Folder, type PanelTab } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { canvasPage } from './canvasPage.ts';
import { ConflictError, InvalidError, NotFoundError, type Kanban } from './kanban.ts';
import { inside } from './tools.ts';
import { assertActive, defaultProjectId, workspaceOf, workspacesOf } from './projects.ts';

const KEEP_VERSIONS = 50;
/** Bigger files are not documents (the panel renders them whole). */
export const MAX_DOC_BYTES = 1_000_000;
/** Tabs per chat panel: opening one more closes the one focused longest ago. */
export const MAX_TABS = 8;
const SCAN_CAP = 500;

interface Row {
  id: string;
  agent_id: string;
  path: string;
  kind: Doc['kind'];
  title: string;
  card_id: string | null;
  version: number;
  updated_by: string;
  updated_at: string;
  file_stamp: string | null;
  pinned_at: string | null;
  folder_id: string | null;
  name: string | null;
  from_canvas: string | null;
  project_id: string;
  /** COALESCE(chat_id, the card's origin chat), from DOC_SELECT. */
  chat: string | null;
  /** How its workspace is served (#214), from DOC_SELECT. */
  files_root: string;
}
/** Documents with the chat they belong to: where first opened, else where their card came from. */
/** Documents of active projects (#213): archived projects are hidden unless asked. */
const ACTIVE_PROJECT = "d.project_id IN (SELECT id FROM projects WHERE status = 'active')";
// files_root (#214, projects.ts filesRoot): the agent's id for its home workspace, <agent>@<project> for a clone.
const DOC_SELECT = `SELECT d.*, COALESCE(d.chat_id, c.origin_card) AS chat,
  CASE WHEN COALESCE((SELECT m.home FROM project_members m WHERE m.agent_id = d.agent_id AND m.project_id = d.project_id),
                     (SELECT k.home FROM kept_workspaces k WHERE k.agent_id = d.agent_id AND k.project_id = d.project_id), 1) = 1
       THEN d.agent_id ELSE d.agent_id || '@' || d.project_id END AS files_root
  FROM documents d LEFT JOIN cards c ON c.id = d.card_id`;
const toDoc = (r: Row): Doc => ({
  id: r.id,
  agentId: r.agent_id,
  path: r.path,
  kind: r.kind,
  title: r.title,
  cardId: r.card_id,
  version: r.version,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
  pinned: r.pinned_at !== null,
  folderId: r.folder_id,
  chatId: r.chat,
  fromCanvas: r.from_canvas,
  projectId: r.project_id,
  filesRoot: r.files_root,
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
    private dataDir: string,
  ) {}

  /** The agent's workspace in a project (#214): throws when it has none there or it is not ready (never another one). */
  private root(agentId: string, projectId: string): string {
    return workspaceOf(this.db, this.dataDir, agentId, projectId);
  }

  /**
   * The project of a new artifact (#213): the project of the task or chat it is made in, else the default one. Its
   * file goes in the agent's workspace of that project (#214).
   */
  private projectFor(cardId: string | null): string {
    const r = cardId ? (this.db.prepare('SELECT project_id FROM cards WHERE id = ?').get(cardId) as { project_id: string } | undefined) : undefined;
    return r?.project_id ?? defaultProjectId(this.db);
  }

  get(id: string): Doc {
    const row = this.db.prepare(DOC_SELECT + ' WHERE d.id = ?').get(id) as Row | undefined;
    if (!row) throw new NotFoundError(`document ${id} not found`);
    return toDoc(row);
  }

  /** `project`: that project's artifacts only (#213); else those of active projects (`archived`: all). */
  list(filter: { cardId?: string; project?: string; archived?: boolean } = {}): Doc[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.cardId) {
      where.push('d.card_id = ?');
      args.push(filter.cardId);
    }
    if (filter.project) {
      where.push('d.project_id = ?');
      args.push(filter.project);
    } else if (!filter.cardId && !filter.archived) where.push(ACTIVE_PROJECT);
    const rows = this.db.prepare(`${DOC_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY d.updated_at DESC`).all(...args);
    return (rows as Row[]).map(toDoc);
  }

  /** The Library: every artifact, fresh (re-reads every agent's artifact folders: edits made outside Atlas), latest first. */
  library(filter: { project?: string; archived?: boolean } = {}): Doc[] {
    const agents = this.db.prepare('SELECT id FROM agents').all() as { id: string }[];
    for (const a of agents) this.sync(a.id, a.id);
    return this.list(filter);
  }

  /** Pin an artifact on top of its folder, or unpin it. */
  pin(id: string, pinned: boolean): Doc {
    assertActive(this.db, this.get(id).projectId, 'its Library');
    this.db.prepare('UPDATE documents SET pinned_at = ? WHERE id = ?').run(pinned ? new Date().toISOString() : null, id);
    return this.emitDoc(id);
  }

  /** Move an artifact to a folder (null: Unfiled). */
  move(id: string, folderId: string | null): Doc {
    const doc = this.get(id);
    assertActive(this.db, doc.projectId, 'its Library');
    if (folderId && this.folder(folderId).projectId !== doc.projectId) throw new InvalidError('that folder is in another project');
    this.db.prepare('UPDATE documents SET folder_id = ? WHERE id = ?').run(folderId, id);
    return this.emitDoc(id);
  }

  /* ── Library folders (flat) ──────────────────────────────────────────── */

  /** `project`: that project's folders (#213); else every folder. */
  folders(project?: string): Folder[] {
    const rows = (project
      ? this.db.prepare('SELECT * FROM folders WHERE project_id = ? ORDER BY name COLLATE NOCASE').all(project)
      : this.db.prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE').all()) as { id: string; name: string; created_at: string; project_id: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, projectId: r.project_id }));
  }

  folder(id: string): Folder {
    const f = this.folders().find((x) => x.id === id);
    if (!f) throw new NotFoundError(`folder ${id} not found`);
    return f;
  }

  /** A folder by name (case-insensitive) in a project (default: the default project), if any. */
  folderNamed(name: string, project = defaultProjectId(this.db)): Folder | null {
    return this.folders(project).find((f) => f.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
  }

  createFolder(name: string, project = defaultProjectId(this.db)): Folder {
    const n = folderName(name);
    assertActive(this.db, project, 'its Library');
    if (this.folderNamed(n, project)) throw new ConflictError(`a folder named "${n}" exists already`);
    const id = 'fld_' + randomUUID().slice(0, 8);
    this.db.prepare('INSERT INTO folders (id, name, created_at, project_id) VALUES (?, ?, ?, ?)').run(id, n, new Date().toISOString(), project);
    this.emitFolders();
    return this.folder(id);
  }

  renameFolder(id: string, name: string): Folder {
    const f = this.folder(id);
    assertActive(this.db, f.projectId, 'its Library');
    const n = folderName(name);
    const other = this.folderNamed(n, f.projectId);
    if (other && other.id !== id) throw new ConflictError(`a folder named "${n}" exists already`);
    this.db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(n, id);
    this.emitFolders();
    return this.folder(id);
  }

  /** Delete a folder: its artifacts move to Unfiled (nothing else is deleted). */
  deleteFolder(id: string): void {
    assertActive(this.db, this.folder(id).projectId, 'its Library');
    const moved = (this.db.prepare('SELECT id FROM documents WHERE folder_id = ?').all(id) as { id: string }[]).map((r) => r.id);
    this.db
      .transaction(() => {
        this.db.prepare('UPDATE documents SET folder_id = NULL WHERE folder_id = ?').run(id);
        this.db.prepare('DELETE FROM folders WHERE id = ?').run(id);
      })
      .immediate();
    this.emitFolders();
    for (const d of moved) this.emitDoc(d);
  }

  /* ── Search: titles and latest content, every folder ─────────────────── */

  /** `project`: that project's artifacts only (#213); else those of active projects. */
  search(query: string, limit = 50, project?: string): DocHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const rows = this.db
      .prepare(
        `SELECT d.id, v.content FROM documents d JOIN document_versions v ON v.doc_id = d.id AND v.version = d.version
         ORDER BY d.updated_at DESC`,
      )
      .all() as { id: string; content: string }[];
    const hits: DocHit[] = [];
    const active = new Set((this.db.prepare("SELECT id FROM projects WHERE status = 'active'").all() as { id: string }[]).map((p) => p.id));
    for (const r of rows) {
      const doc = this.get(r.id);
      if (project ? doc.projectId !== project : !active.has(doc.projectId)) continue;
      const inTitle = doc.title.toLowerCase().includes(q);
      const text = searchableText(doc.kind, r.content);
      const at = text.toLowerCase().indexOf(q);
      if (!inTitle && at < 0) continue;
      hits.push({ doc, snippet: at < 0 ? null : snippetAt(text, at, q.length) });
      if (hits.length >= limit) break;
    }
    // Title matches first, then content matches; latest first within each.
    return [...hits.filter((h) => h.doc.title.toLowerCase().includes(q)), ...hits.filter((h) => !h.doc.title.toLowerCase().includes(q))];
  }

  /* ── artifact_create / artifact_update ───────────────────────────────── */

  /**
   * A new artifact: its file is written in the agent's workspace (docs/, pages/, diagrams/ or links/, from the title
   * unless `path` is given) and indexed as v1. A link's content is its address.
   */
  create(agentId: string, a: { kind: DocKind; title: string; content: string; path?: string; folder?: string | null }, by: string, cardId: string | null = null): Doc {
    const project = this.projectFor(cardId);
    assertActive(this.db, project, 'its Library');
    const root = this.root(agentId, project);
    const spec = KIND_FILE[a.kind];
    let rel = a.path?.trim() ? this.rel(root, a.path.trim()) : null;
    if (rel && docKindOf(rel) !== a.kind) throw new InvalidError(`${rel}: a ${a.kind} artifact needs a .${spec.ext} file`);
    if (!rel) {
      const base = slug(a.title) || 'untitled';
      rel = `${spec.dir}/${base}.${spec.ext}`;
      for (let n = 2; this.exists(root, rel); n++) rel = `${spec.dir}/${base}-${n}.${spec.ext}`;
    } else if (this.exists(root, rel)) throw new ConflictError(`${rel} exists already: use artifact_update`);
    const content = a.kind === 'url' ? a.content.trim() + '\n' : a.content;
    if (a.kind === 'url' && !/^(https?:\/\/|\/api\/files\/)/.test(content.trim())) throw new InvalidError('a link is an http(s) address or /api/files/<agent>/<path>');
    if (Buffer.byteLength(content) > MAX_DOC_BYTES) throw new InvalidError(`artifacts are at most ${MAX_DOC_BYTES} bytes`);
    const folder = a.folder?.trim() ? (this.folderNamed(a.folder, project) ?? this.createFolder(a.folder, project)) : null;
    const full = inside(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    const doc = this.record(agentId, project, rel, content, stampOf(full).stamp, by, cardId, a.title.trim()).doc;
    if (folder) this.db.prepare('UPDATE documents SET folder_id = ? WHERE id = ?').run(folder.id, doc.id);
    return folder ? this.emitDoc(doc.id) : doc;
  }

  /** A new version of an artifact: the whole content, or one exact replacement in it. */
  update(id: string, change: { content?: string; oldText?: string; newText?: string; title?: string }, by: string, cardId: string | null = null): Doc {
    const doc = this.get(id);
    assertActive(this.db, doc.projectId, 'its Library');
    const current = this.content(id).content;
    let next: string;
    if (change.content !== undefined) next = doc.kind === 'url' ? change.content.trim() + '\n' : change.content;
    else if (change.oldText !== undefined) {
      const n = current.split(change.oldText).length - 1;
      if (n !== 1) throw new InvalidError(n ? `old_text is found ${n} times: add context so it is unique` : 'old_text is not in the artifact');
      next = current.replace(change.oldText, () => change.newText ?? '');
    } else if (change.title === undefined) throw new InvalidError('give content, old_text/new_text or title');
    else next = current;
    if (Buffer.byteLength(next) > MAX_DOC_BYTES) throw new InvalidError(`artifacts are at most ${MAX_DOC_BYTES} bytes`);
    if (change.title !== undefined) this.db.prepare('UPDATE documents SET name = ? WHERE id = ?').run(change.title.trim() || null, id);
    const full = inside(this.root(doc.agentId, doc.projectId), doc.path);
    writeFileSync(full, next);
    const res = this.record(doc.agentId, doc.projectId, doc.path, next, stampOf(full).stamp, by, cardId);
    // A rename alone: the title changes without a new version.
    if (!res.changed && change.title !== undefined) {
      this.db.prepare('UPDATE documents SET title = ? WHERE id = ?').run(docTitle(doc.path, next, change.title.trim() || null), id);
      return this.emitDoc(id);
    }
    return res.doc;
  }

  /** An artifact by id, or by a path in the agent's workspace (indexed on the way). */
  resolve(agentId: string, ref: string, cardId: string | null = null): Doc {
    if (/^doc_[\w-]+$/.test(ref)) return this.get(ref);
    return this.byPath(agentId, ref, cardId) ?? this.indexFile(agentId, ref, agentId, cardId);
  }

  /**
   * Canvases are gone (#120): each canvas still in the archive table becomes an html page in its author's workspace
   * (pages/canvases/…, folder « Canvases »), once. Its date stays the canvas's, so the Library's recent list is not
   * flooded. Returns how many were converted.
   */
  convertCanvases(): number {
    let todo: { id: string; name: string; nodes: string; updated_by: string; updated_at: string }[];
    try {
      todo = this.db
        .prepare('SELECT c.id, c.name, c.nodes, c.updated_by, c.updated_at FROM canvases c WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.from_canvas = c.id) ORDER BY c.updated_at')
        .all() as typeof todo;
    } catch {
      return 0; // no archive table (a fresh database)
    }
    if (!todo.length) return 0;
    const agents = (this.db.prepare('SELECT id FROM agents ORDER BY rowid').all() as { id: string }[]).map((a) => a.id);
    if (!agents.length) return 0;
    const folder = this.folderNamed('Canvases') ?? this.createFolder('Canvases');
    let n = 0;
    for (const c of todo) {
      const agentId = agents.includes(c.updated_by) ? c.updated_by : agents.includes('atlas') ? 'atlas' : agents[0]!;
      const project = this.projectFor(null);
      const root = this.root(agentId, project);
      let nodes: unknown[] = [];
      try {
        nodes = JSON.parse(c.nodes) as unknown[];
      } catch {
        nodes = [];
      }
      const html = canvasPage(c.name, nodes as Parameters<typeof canvasPage>[1], c.updated_at);
      let rel = `pages/canvases/${slug(c.name) || 'canvas'}.html`;
      for (let i = 2; this.exists(root, rel); i++) rel = `pages/canvases/${slug(c.name) || 'canvas'}-${i}.html`;
      const full = inside(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, html);
      const doc = this.record(agentId, project, rel, html, stampOf(full).stamp, c.updated_by, null, c.name).doc;
      this.db.prepare('UPDATE documents SET folder_id = ?, from_canvas = ?, updated_at = ? WHERE id = ?').run(folder.id, c.id, c.updated_at, doc.id);
      this.db.prepare('UPDATE document_versions SET updated_at = ? WHERE doc_id = ?').run(c.updated_at, doc.id);
      this.emitDoc(doc.id);
      n++;
    }
    return n;
  }

  /** The document of a file in the agent's workspace of `cardId`'s project (default project without a card), if indexed. */
  byPath(agentId: string, path: string, cardId: string | null = null): Doc | null {
    const project = this.projectFor(cardId);
    const rel = this.rel(this.root(agentId, project), path);
    const row = this.db.prepare(DOC_SELECT + ' WHERE d.agent_id = ? AND d.project_id = ? AND d.path = ?').get(agentId, project, rel) as Row | undefined;
    return row ? toDoc(row) : null;
  }

  /**
   * Index one file of an agent's workspace (of `cardId`'s project): create its document, or add a version if the
   * content changed. `cardId` attaches the document to that card when it isn't attached yet.
   */
  indexFile(agentId: string, path: string, by: string, cardId: string | null = null): Doc {
    const project = this.projectFor(cardId);
    const root = this.root(agentId, project);
    const full = inside(root, path);
    const rel = this.rel(root, path);
    if (!docKindOf(rel)) throw new InvalidError(`${rel}: artifacts are .md, .html, .svg and .url files`);
    let st: ReturnType<typeof stampOf>;
    try {
      st = stampOf(full);
    } catch {
      throw new NotFoundError(`no file ${rel} in ${agentId}'s workspace`);
    }
    if (!st.isFile) throw new InvalidError(`${rel} is not a file`);
    if (st.size > MAX_DOC_BYTES) throw new InvalidError(`${rel} is ${st.size} bytes; documents are at most ${MAX_DOC_BYTES}`);
    const content = readFileSync(full, 'utf8');
    return this.record(agentId, project, rel, content, st.stamp, by, cardId).doc;
  }

  /**
   * Re-read the agent's indexed files that changed on disk, and index new files in docs/, pages/ and diagrams/.
   * `cardId`: only the workspace of its project (after a run's file tools); else every ready workspace of the agent.
   * Returns the documents that got a new version. Missing files are left as they were (their versions stay readable).
   */
  sync(agentId: string, by: string, cardId: string | null = null): Doc[] {
    const spaces = cardId
      ? [{ projectId: this.projectFor(cardId), dir: this.root(agentId, this.projectFor(cardId)) }]
      : workspacesOf(this.db, this.dataDir, agentId);
    const changed: Doc[] = [];
    for (const { projectId, dir: root } of spaces) {
      const known = this.db.prepare('SELECT * FROM documents WHERE agent_id = ? AND project_id = ?').all(agentId, projectId) as Row[];
      const seen = new Set<string>();
      for (const r of known) {
        seen.add(r.path);
        let st: ReturnType<typeof stampOf>;
        try {
          st = stampOf(inside(root, r.path));
        } catch {
          continue; // deleted or moved: keep the versions
        }
        if (st.stamp === r.file_stamp || !st.isFile || st.size > MAX_DOC_BYTES) continue;
        const res = this.record(agentId, projectId, r.path, readFileSync(inside(root, r.path), 'utf8'), st.stamp, by, cardId);
        if (res.changed) changed.push(res.doc);
      }
      for (const rel of this.scan(root)) {
        if (seen.has(rel)) continue;
        const st = stampOf(join(root, rel));
        if (st.size > MAX_DOC_BYTES) continue;
        changed.push(this.record(agentId, projectId, rel, readFileSync(join(root, rel), 'utf8'), st.stamp, by, cardId).doc);
      }
    }
    return changed;
  }

  /** A version's text (default the latest, re-synced from the file first). */
  content(id: string, version?: number): DocContent {
    let doc = this.get(id);
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
    this.get(id);
    return (
      this.db
        .prepare('SELECT version, updated_by, updated_at FROM document_versions WHERE doc_id = ? ORDER BY version DESC')
        .all(id) as { version: number; updated_by: string; updated_at: string }[]
    ).map((r) => ({ version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at }));
  }

  /** Go back to an earlier version: the file gets that content again, recorded as a new version (undoable). */
  restore(id: string, version: number, by: string): Doc {
    const doc = this.get(id);
    assertActive(this.db, doc.projectId, 'its Library');
    const { content } = this.content(id, version);
    const full = inside(this.root(doc.agentId, doc.projectId), doc.path);
    writeFileSync(full, content);
    return this.record(doc.agentId, doc.projectId, doc.path, content, stampOf(full).stamp, by, null).doc;
  }

  attach(id: string, cardId: string): Doc {
    this.kanban.get(cardId);
    this.db.prepare('UPDATE documents SET card_id = ? WHERE id = ?').run(cardId, id);
    return this.emitDoc(id);
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

  private rel(root: string, path: string): string {
    return relative(root, inside(root, path)).split(sep).join('/');
  }

  private resync(doc: Doc): Doc {
    let root: string;
    let st: ReturnType<typeof stampOf>;
    try {
      root = this.root(doc.agentId, doc.projectId);
      st = stampOf(inside(root, doc.path));
    } catch {
      return doc; // file gone, or no workspace there any more (a removed member's): its versions stay readable
    }
    const row = this.db.prepare('SELECT file_stamp FROM documents WHERE id = ?').get(doc.id) as { file_stamp: string | null };
    if (st.stamp === row.file_stamp || !st.isFile || st.size > MAX_DOC_BYTES) return doc;
    return this.record(doc.agentId, doc.projectId, doc.path, readFileSync(inside(root, doc.path), 'utf8'), st.stamp, doc.agentId, null).doc;
  }

  /** docs/, pages/, diagrams/, links/ artifact files (3 levels deep, capped). */
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

  private record(agentId: string, projectId: string, rel: string, content: string, stamp: string, by: string, cardId: string | null, name: string | null = null): { doc: Doc; changed: boolean } {
    const kind = docKindOf(rel)!;
    const now = new Date().toISOString();
    let changed = false;
    const doc = this.db
      .transaction(() => {
        const row = this.db.prepare('SELECT * FROM documents WHERE agent_id = ? AND project_id = ? AND path = ?').get(agentId, projectId, rel) as Row | undefined;
        const title = docTitle(rel, content, row?.name ?? name);
        if (!row) {
          const id = newId();
          this.db
            .prepare('INSERT INTO documents (id, agent_id, path, kind, title, card_id, version, updated_by, updated_at, file_stamp, name, project_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)')
            .run(id, agentId, rel, kind, title, cardId, by, now, stamp, name, projectId);
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

  private emitDoc(id: string): Doc {
    const doc = this.get(id);
    this.bus.emit({ type: 'document.updated', doc });
    return doc;
  }

  private emitFolders(): void {
    this.bus.emit({ type: 'folders.updated', folders: this.folders() });
  }

  private exists(root: string, rel: string): boolean {
    try {
      statSync(inside(root, rel));
      return true;
    } catch {
      return false;
    }
  }

  private emitPanel(chatId: string): PanelTab[] {
    const tabs = this.tabs(chatId);
    this.bus.emit({ type: 'panel.updated', chatId, tabs });
    return tabs;
  }
}

const newId = () => 'doc_' + randomUUID().slice(0, 8);

/** A file name from a title: « Artifacts viewer spec » → artifacts-viewer-spec. */
export const slug = (title: string) =>
  title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');

function folderName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw new InvalidError('a folder needs a name');
  if (n.length > 60) throw new InvalidError('folder names are at most 60 characters');
  return n;
}

/** The text search looks in: html and svg without their tags, scripts and styles. */
export function searchableText(kind: DocKind, content: string): string {
  if (kind === 'markdown' || kind === 'url') return content;
  return content
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

/** About 120 characters around a match, on one line, with … where cut. */
export function snippetAt(text: string, at: number, len: number): string {
  const from = Math.max(0, at - 50);
  const to = Math.min(text.length, at + len + 70);
  const s = text.slice(from, to).replace(/\s+/g, ' ').trim();
  return (from > 0 ? '…' : '') + s + (to < text.length ? '…' : '');
}
