import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedSections, findSection, formatDocRef, parseDocRef, splitSections, type ServerEvent } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { MAX_TABS } from './documents.ts';
import { runDocTool } from './docTools.ts';

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

async function setup(fake = new FakeProvider([])) {
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-docs-'));
  const engine = await startEngine({ dbFile: ':memory:', dataDir, port: 0, dispatch: false, providers: () => fake, env: {} });
  engines.push(engine);
  const events: ServerEvent[] = [];
  engine.bus.on((e) => events.push(e));
  const ws = join(dataDir, 'workspaces', 'atlas');
  const put = (rel: string, content: string) => {
    mkdirSync(join(ws, rel, '..'), { recursive: true });
    writeFileSync(join(ws, rel), content);
  };
  return { engine, events, ws, put, docs: engine.documents, fake };
}

const DESIGN = '# Permissions design\n\nIntro.\n\n## Overview\nProfiles per agent.\n\n## Flow\nTool call → policy.\n\n```\n# not a heading\n```\n';

describe('markdown sections and references (shared)', () => {
  it('splits at headings 1-3 outside code fences, with unique ids', () => {
    const s = splitSections(DESIGN + '\n## Flow\nagain\n### Détails été\nx\n#### deep\ny\n');
    expect(s.map((x) => x.id)).toEqual(['permissions-design', 'overview', 'flow', 'flow-2', 'détails-été']);
    expect(s[2]!.text).toContain('# not a heading');
    expect(s[4]!.text).toContain('#### deep');
    expect(splitSections('before\n# A\nb').map((x) => x.id)).toEqual(['', 'a']);
    expect(findSection(s, 'FLOW')!.id).toBe('flow');
    expect(findSection(s, '#overview')!.title).toBe('Overview');
  });

  it('marks the sections that changed between two versions', () => {
    const after = DESIGN.replace('Profiles per agent.', 'Profiles per agent, editable.') + '\n## Storage\nrows\n';
    expect([...changedSections(DESIGN, after)]).toEqual(['overview', 'storage']);
  });

  it('formats a reference the agent can read and the UI can parse back', () => {
    const sec = findSection(splitSections(DESIGN), 'flow')!;
    const text = formatDocRef({ id: 'doc_ab12cd34', title: 'Permissions design', path: 'docs/perm.md' }, 2, sec);
    expect(text).toContain('❝ Permissions design › Flow');
    expect(text).toContain('docs/perm.md, doc_ab12cd34 v2, section #flow');
    expect(text).toContain('> Tool call → policy.');
    expect(parseDocRef(text)).toEqual({ label: 'Permissions design › Flow', docId: 'doc_ab12cd34', version: 2, section: 'flow' });
    expect(parseDocRef(formatDocRef({ id: 'doc_x', title: 'Board', path: 'links/board.url' }, 4, null))).toEqual({ label: 'Board', docId: 'doc_x', version: 4, section: null });
    expect(parseDocRef('just text')).toBeNull();
  });
});

describe('documents: indexing and versions', () => {
  it('indexes a file, versions changes only, and keeps the title from the content', async () => {
    const { docs, put, events } = await setup();
    put('docs/perm.md', DESIGN);
    const d = docs.indexFile('atlas', 'docs/perm.md', 'atlas');
    expect(d).toMatchObject({ kind: 'markdown', title: 'Permissions design', path: 'docs/perm.md', version: 1, agentId: 'atlas' });
    expect(docs.indexFile('atlas', './docs/../docs/perm.md', 'atlas')).toMatchObject({ id: d.id, version: 1 }); // same content, same path
    put('docs/perm.md', DESIGN.replace('# Permissions design', '# Permissions v2'));
    const d2 = docs.indexFile('atlas', 'docs/perm.md', 'atlas');
    expect(d2).toMatchObject({ id: d.id, version: 2, title: 'Permissions v2' });
    expect(docs.versions(d.id).map((v) => v.version)).toEqual([2, 1]);
    expect(docs.content(d.id, 1).content).toBe(DESIGN);
    expect(events.filter((e) => e.type === 'document.updated')).toHaveLength(2);
  });

  it('refuses files the panel cannot show, missing ones and paths outside the workspace', async () => {
    const { docs, put } = await setup();
    put('notes.txt', 'x');
    expect(() => docs.indexFile('atlas', 'notes.txt', 'atlas')).toThrow(/\.md, \.html, \.svg and \.url/);
    expect(() => docs.indexFile('atlas', 'docs/none.md', 'atlas')).toThrow(/no file/);
    expect(() => docs.indexFile('atlas', '../../x.md', 'atlas')).toThrow(/outside/);
  });

  it('sync picks up new files in docs/, pages/, diagrams/ and changes to indexed ones (shell edits)', async () => {
    const { docs, put } = await setup();
    put('docs/a.md', '# A');
    put('pages/p.html', '<title>Mock</title><h1>x</h1>');
    put('diagrams/flow.svg', '<svg><title>Flow</title></svg>');
    put('src/ignored.md', '# not a doc folder');
    const first = docs.sync('atlas', 'atlas');
    expect(first.map((d) => [d.path, d.kind, d.title]).sort()).toEqual([
      ['diagrams/flow.svg', 'diagram', 'Flow'],
      ['docs/a.md', 'markdown', 'A'],
      ['pages/p.html', 'html', 'Mock'],
    ]);
    expect(docs.sync('atlas', 'atlas')).toEqual([]);
    put('docs/a.md', '# A\nmore');
    expect(docs.sync('atlas', 'atlas').map((d) => [d.path, d.version])).toEqual([['docs/a.md', 2]]);
  });

  it('reading the latest version re-syncs from the file', async () => {
    const { docs, put } = await setup();
    put('docs/a.md', '# A');
    const d = docs.indexFile('atlas', 'docs/a.md', 'atlas');
    put('docs/a.md', '# A edited elsewhere');
    expect(docs.content(d.id)).toMatchObject({ version: 2, content: '# A edited elsewhere' });
  });

  it('restores an earlier version into the file, as a new version', async () => {
    const { docs, put, ws } = await setup();
    put('docs/a.md', 'one');
    const d = docs.indexFile('atlas', 'docs/a.md', 'atlas');
    put('docs/a.md', 'two');
    docs.indexFile('atlas', 'docs/a.md', 'atlas');
    const r = docs.restore(d.id, 1, 'user');
    expect(r).toMatchObject({ version: 3, updatedBy: 'user' });
    expect(readFileSync(join(ws, 'docs/a.md'), 'utf8')).toBe('one');
    expect(() => docs.restore(d.id, 9, 'user')).toThrow(/no version 9/);
  });

  it('keeps the last 50 versions', async () => {
    const { docs, put } = await setup();
    put('docs/a.md', 'v0');
    const d = docs.indexFile('atlas', 'docs/a.md', 'atlas');
    for (let i = 1; i <= 55; i++) {
      put('docs/a.md', 'v' + i);
      docs.indexFile('atlas', 'docs/a.md', 'atlas');
    }
    const vs = docs.versions(d.id);
    expect(vs).toHaveLength(50);
    expect(vs[0]!.version).toBe(56);
  });

});

describe('library', () => {
  it('lists every artifact fresh: unsynced files, links too', async () => {
    const { docs, put } = await setup();
    put('docs/a.md', '# A');
    expect(docs.library().map((d) => [d.kind, d.title])).toEqual([['markdown', 'A']]);
    put('diagrams/f.svg', '<svg><title>Flow</title></svg>');
    put('links/dev.url', 'http://localhost:5173\n');
    expect(docs.library().map((d) => [d.kind, d.title]).sort()).toEqual([['diagram', 'Flow'], ['markdown', 'A'], ['url', 'dev.url']]);
  });

  it('pins and unpins, and survives the event round trip', async () => {
    const { docs, put, events } = await setup();
    put('docs/a.md', '# A');
    const d = docs.indexFile('atlas', 'docs/a.md', 'atlas');
    expect(d.pinned).toBe(false);
    expect(docs.pin(d.id, true).pinned).toBe(true);
    expect(docs.get(d.id).pinned).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'document.updated', doc: { id: d.id, pinned: true } });
    expect(docs.pin(d.id, false).pinned).toBe(false);
    expect(() => docs.pin('doc_none', true)).toThrow(/not found/);
  });

  it('belongs to the chat it was first opened in, else the chat its card came from', async () => {
    const { docs, put, engine } = await setup();
    const chat = engine.kanban.newChat('atlas');
    const other = engine.kanban.newChat('atlas');
    const card = engine.kanban.create({ title: 'From chat', body: '', status: 'todo', assignee: 'atlas', priority: 0, parents: [] }, 'atlas', chat.id);
    put('docs/a.md', '# A');
    put('docs/b.md', '# B');
    const a = docs.indexFile('atlas', 'docs/a.md', 'atlas', card.id);
    expect(a.chatId).toBe(chat.id);
    const b = docs.indexFile('atlas', 'docs/b.md', 'atlas');
    expect(b.chatId).toBeNull();
    docs.open(other.id, b.id, 'atlas');
    docs.open(chat.id, b.id, 'atlas');
    expect(docs.get(b.id).chatId).toBe(other.id); // first one wins
  });
});

describe('side panel tabs', () => {
  it('opens, focuses, scrolls, closes, and caps the tab count', async () => {
    const { docs, put, engine, events } = await setup();
    const chat = engine.kanban.newChat('atlas');
    put('docs/a.md', DESIGN);
    put('docs/b.md', '# B');
    const a = docs.indexFile('atlas', 'docs/a.md', 'atlas');
    const b = docs.indexFile('atlas', 'docs/b.md', 'atlas');
    docs.open(chat.id, a.id, 'atlas');
    let tabs = docs.open(chat.id, b.id, 'atlas');
    expect(tabs.map((t) => [t.doc.id, t.active])).toEqual([[a.id, false], [b.id, true]]);
    tabs = docs.open(chat.id, a.id, 'atlas', 'flow');
    expect(tabs.find((t) => t.active)).toMatchObject({ doc: { id: a.id }, section: 'flow', openedBy: 'atlas' });
    expect(tabs.map((t) => t.doc.id)).toEqual([a.id, b.id]); // order kept
    tabs = docs.focus(chat.id, b.id);
    expect(tabs.find((t) => t.active)!.doc.id).toBe(b.id);
    expect(docs.close(chat.id, b.id).map((t) => t.doc.id)).toEqual([a.id]);
    expect(docs.close(chat.id, null)).toEqual([]);
    expect(events.filter((e) => e.type === 'panel.updated').length).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < MAX_TABS + 2; i++) {
      put(`docs/n${i}.md`, '# ' + i);
      docs.open(chat.id, docs.indexFile('atlas', `docs/n${i}.md`, 'atlas').id, 'atlas');
    }
    expect(docs.tabs(chat.id)).toHaveLength(MAX_TABS);
    expect(docs.tabs(chat.id)[0]!.doc.title).toBe('2');
  });

  it('brings a chat\'s tabs and the active one back after a restart (#302)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-docs-'));
    const dbFile = join(dataDir, 'atlas.db');
    const start = async () => {
      const e = await startEngine({ dbFile, dataDir, port: 0, dispatch: false, providers: () => new FakeProvider([]), env: {}, memoryReview: false });
      engines.push(e);
      return e;
    };
    const first = await start();
    const chat = first.kanban.newChat('atlas');
    const ws = join(dataDir, 'workspaces', 'atlas');
    mkdirSync(join(ws, 'docs'), { recursive: true });
    for (const n of ['a', 'b', 'c']) writeFileSync(join(ws, `docs/${n}.md`), '# ' + n);
    const [a, b, c] = ['a', 'b', 'c'].map((n) => first.documents.indexFile('atlas', `docs/${n}.md`, 'atlas'));
    for (const d of [a!, b!, c!]) first.documents.open(chat.id, d.id, 'atlas');
    const before = first.documents.focus(chat.id, a!.id);
    await first.stop();
    const second = await start();
    const after = second.documents.tabs(chat.id);
    expect(after.map((t) => [t.kind, t.doc.id, t.active])).toEqual([['artifact', a!.id, true], ['artifact', b!.id, false], ['artifact', c!.id, false]]);
    expect(after.map((t) => t.focusedAt)).toEqual(before.map((t) => t.focusedAt));
  });

  it('remembers the version the user saw, for « changed » marks', async () => {
    const { docs, put, engine } = await setup();
    const chat = engine.kanban.newChat('atlas');
    put('docs/a.md', DESIGN);
    const a = docs.indexFile('atlas', 'docs/a.md', 'atlas');
    docs.open(chat.id, a.id, 'atlas');
    put('docs/a.md', DESIGN + '\n## Storage\nrows\n');
    docs.indexFile('atlas', 'docs/a.md', 'atlas');
    expect(docs.tabs(chat.id)[0]).toMatchObject({ seenVersion: 1, doc: { version: 2 } });
    expect(docs.seen(chat.id, a.id)[0]!.seenVersion).toBe(2);
  });

  it('belongs to direct chats only', async () => {
    const { docs, put, engine } = await setup();
    const card = engine.kanban.create({ title: 'x' }, 'user');
    put('docs/a.md', '# A');
    const a = docs.indexFile('atlas', 'docs/a.md', 'atlas');
    expect(() => docs.open(card.id, a.id, 'user')).toThrow(/not a direct chat/);
  });
});

describe('panel tools', () => {
  it('panel_open from a card opens in its origin chat and attaches the document to the card', async () => {
    const { docs, put, engine } = await setup();
    const chat = engine.kanban.newChat('atlas');
    const card = engine.kanban.create({ title: 'Perm design', assignee: 'atlas' }, 'atlas', chat.id);
    put('docs/perm.md', DESIGN);
    const ctx = { documents: docs, agentId: 'atlas', chatId: chat.id, cardId: card.id };
    const r = runDocTool('panel_open', { path: 'docs/perm.md', section: 'Flow' }, ctx);
    expect(r).toMatchObject({ isError: false });
    expect(r.output).toContain('scrolled to #flow');
    expect(docs.tabs(chat.id)[0]).toMatchObject({ section: 'flow', cardTitle: 'Perm design', doc: { cardId: card.id } });
    expect(docs.list({ cardId: card.id })).toHaveLength(1);

    const bad = runDocTool('panel_open', { path: 'docs/perm.md', section: 'Nope' }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain('#overview (Overview)');
    expect(runDocTool('panel_open', {}, ctx).output).toMatch(/give the artifact/);
    expect(runDocTool('panel_close', { path: 'docs/perm.md' }, ctx).output).toContain('0 tabs left');
    expect(runDocTool('panel_close', { path: 'docs/perm.md' }, ctx).isError).toBe(true);
  });

  it('panel_open on a card without a chat only indexes and attaches', async () => {
    const { docs, put, engine } = await setup();
    const card = engine.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    put('pages/p.html', '<h1>P</h1>');
    const r = runDocTool('panel_open', { path: 'pages/p.html' }, { documents: docs, agentId: 'atlas', chatId: null, cardId: card.id });
    expect(r.output).toContain('opens it from the task');
    expect(docs.list({ cardId: card.id })[0]).toMatchObject({ kind: 'html' });
  });

  it('in a run: write_file indexes the doc, panel_open shows it, the prompt explains documents', async () => {
    const fake = new FakeProvider([
      [{ type: 'tool_use', id: 't1', name: 'write_file', input: { path: 'docs/plan.md', content: '# Plan\n## Steps\n1' } }],
      [{ type: 'tool_use', id: 't2', name: 'panel_open', input: { path: 'docs/plan.md', section: 'steps' } }],
      [{ type: 'text', text: 'Open on your right.' }],
    ]);
    const { engine, docs } = await setup(fake);
    const chat = engine.kanban.newChat('atlas');
    engine.kanban.appendMessage(chat.id, 'user', 'user', [{ type: 'text', text: 'plan it' }]);
    engine.runner.wake(chat.id, { kind: 'chat' });
    await engine.runner.settled(chat.id);
    expect(fake.calls[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['artifact_create', 'artifact_update', 'artifact_list', 'artifact_read', 'panel_open', 'panel_close']));
    expect(fake.calls[0]!.tools.map((t) => t.name).some((n) => n.startsWith('canvas'))).toBe(false);
    expect(fake.calls[0]!.system).toContain('artifact_create saves one');
    expect(fake.calls[0]!.system).not.toMatch(/canvas/i);
    const tab = docs.tabs(chat.id)[0]!;
    expect(tab).toMatchObject({ section: 'steps', openedBy: 'atlas', doc: { title: 'Plan', version: 1, cardId: null } });
  });
});

describe('artifacts (#120)', () => {
  it('artifact_create writes the file from the title, files it in a folder (created if new) and shows it', async () => {
    const { docs, ws, engine } = await setup();
    const chat = engine.kanban.newChat('atlas');
    const ctx = { documents: docs, agentId: 'atlas', chatId: chat.id, cardId: null };
    const r = runDocTool('artifact_create', { kind: 'markdown', title: 'Viewer spec', content: '# Viewer spec\nbody', folder: 'Artifacts redesign' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.output).toMatch(/^created Viewer spec \(doc_[\w-]+, docs\/viewer-spec\.md, v1\) in Artifacts redesign; shown in the side panel/);
    expect(readFileSync(join(ws, 'docs/viewer-spec.md'), 'utf8')).toBe('# Viewer spec\nbody');
    const d = docs.byPath('atlas', 'docs/viewer-spec.md')!;
    expect(docs.folder(d.folderId!).name).toBe('Artifacts redesign');
    expect(docs.tabs(chat.id)[0]!.doc.id).toBe(d.id);
    // Same title again: a new file, same folder (found case-insensitively).
    const again = runDocTool('artifact_create', { kind: 'markdown', title: 'Viewer spec', content: 'x', folder: 'artifacts REDESIGN' }, ctx);
    expect(again.output).toContain('docs/viewer-spec-2.md');
    expect(docs.folders()).toHaveLength(1);
  });

  it('links: a .url file holding the address, titled by its name; svg goes to diagrams/', async () => {
    const { docs } = await setup();
    const ctx = { documents: docs, agentId: 'atlas', chatId: null, cardId: null };
    const r = runDocTool('artifact_create', { kind: 'url', title: 'Composer dev server', content: 'http://localhost:5173' }, ctx);
    expect(r.output).toContain('links/composer-dev-server.url, v1');
    expect(docs.byPath('atlas', 'links/composer-dev-server.url')).toMatchObject({ kind: 'url', title: 'Composer dev server', folderId: null });
    expect(runDocTool('artifact_create', { kind: 'url', title: 'bad', content: 'javascript:alert(1)' }, ctx).isError).toBe(true);
    expect(runDocTool('artifact_create', { kind: 'svg', title: 'Flow', content: '<svg/>' }, ctx).output).toContain('diagrams/flow.svg');
  });

  it('artifact_update: whole content or one replacement, a new version each; title renames', async () => {
    const { docs, engine } = await setup();
    const chat = engine.kanban.newChat('atlas');
    const ctx = { documents: docs, agentId: 'atlas', chatId: chat.id, cardId: null };
    runDocTool('artifact_create', { kind: 'html', title: 'Feed', content: '<p>one</p>' }, ctx);
    const d = docs.byPath('atlas', 'pages/feed.html')!;
    expect(runDocTool('artifact_update', { artifact: d.id, old_text: 'one', new_text: 'two' }, ctx).output).toMatch(/^updated Feed \(doc_[\w-]+, pages\/feed\.html, v2\)/);
    expect(runDocTool('artifact_update', { path: 'pages/feed.html', content: '<p>three</p>' }, ctx).output).toContain(', v3)');
    expect(runDocTool('artifact_update', { artifact: d.id, old_text: 'nope', new_text: 'x' }, ctx).isError).toBe(true);
    expect(runDocTool('artifact_update', { artifact: d.id, title: 'Price feed health' }, ctx).output).toContain('unchanged Price feed health');
    expect(docs.get(d.id)).toMatchObject({ title: 'Price feed health', version: 3 });
    expect(docs.content(d.id, 2).content).toBe('<p>two</p>');
    const read = runDocTool('artifact_read', { artifact: d.id, version: 1 }, ctx);
    expect(read.output).toContain('v1 of 3');
    expect(read.output).toContain('<p>one</p>');
    expect(runDocTool('artifact_list', {}, ctx).output).toContain('Price feed health · v3 · Unfiled');
  });

  it('folders: rename, delete moves artifacts to Unfiled; pinned and moved', async () => {
    const { docs, put, events } = await setup();
    put('docs/a.md', '# A');
    const a = docs.indexFile('atlas', 'docs/a.md', 'atlas');
    const f = docs.createFolder('  Data   feeds ');
    expect(f.name).toBe('Data feeds');
    expect(() => docs.createFolder('data FEEDS')).toThrow(/exists/);
    expect(docs.move(a.id, f.id).folderId).toBe(f.id);
    expect(docs.renameFolder(f.id, 'Feeds').name).toBe('Feeds');
    docs.deleteFolder(f.id);
    expect(docs.get(a.id).folderId).toBeNull();
    expect(docs.folders()).toEqual([]);
    expect(events.some((e) => e.type === 'folders.updated')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'document.updated', doc: { id: a.id, folderId: null } });
    expect(() => docs.move(a.id, 'fld_none')).toThrow(/not found/);
  });

  it('search: titles and content (html without tags), title hits first, content hits with a snippet', async () => {
    const { docs, put } = await setup();
    put('docs/spec.md', '# Viewer spec\n\nThe version picker lists every version.');
    put('pages/feed.html', '<html><head><style>.picker{}</style></head><body><h1>Feed</h1><p>No picker here, just prices.</p></body></html>');
    put('docs/picker.md', '# Picker notes');
    docs.library();
    const hits = docs.search('PICKER');
    expect(hits.map((h) => h.doc.title)).toEqual(['Picker notes', expect.any(String), expect.any(String)]);
    expect(hits[0]!.snippet).toContain('Picker');
    const feed = hits.find((h) => h.doc.title === 'Feed')!;
    expect(feed.snippet).toBe('Feed No picker here, just prices.');
    expect(docs.search('zzz')).toEqual([]);
    expect(docs.search('  ')).toEqual([]);
  });

  it('converts each archived canvas once to an html page in the Canvases folder, keeping its date', async () => {
    const { docs, engine, ws } = await setup();
    const db = engine.db;
    db.prepare("INSERT INTO canvases (id, name, nodes, version, updated_by, updated_at) VALUES ('cv_1', 'Old board', ?, 3, 'atlas', '2026-11-01T10:00:00.000Z')").run(
      JSON.stringify([
        { id: 'b', kind: 'html', x: 0, y: 500, w: 400, h: 300, title: 'Mock', html: '<b>hi</b>' },
        { id: 'a', kind: 'markdown', x: 0, y: 0, w: 400, h: 300, title: 'Notes', text: '# Notes <x>' },
        { id: 'c', kind: 'url', x: 500, y: 500, w: 400, h: 300, url: '/api/files/atlas/pages/x.html' },
      ]),
    );
    expect(docs.convertCanvases()).toBe(1);
    expect(docs.convertCanvases()).toBe(0);
    const d = docs.byPath('atlas', 'pages/canvases/old-board.html')!;
    expect(d).toMatchObject({ kind: 'html', title: 'Old board', updatedAt: '2026-11-01T10:00:00.000Z', fromCanvas: 'cv_1' });
    expect(docs.folder(d.folderId!).name).toBe('Canvases');
    const html = readFileSync(join(ws, d.path), 'utf8');
    expect(html.indexOf('Notes')).toBeLessThan(html.indexOf('Mock'));
    expect(html).toContain('# Notes &lt;x&gt;');
    expect(html).toContain('srcdoc="&lt;b&gt;hi&lt;/b&gt;"');
    expect(html).toContain('src="/api/files/atlas/pages/x.html"');
  });

  it('converts a canvas once: its page deleted from the Library is not back after a restart (#253)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-docs-'));
    const dbFile = join(dataDir, 'atlas.db');
    const start = async () => {
      const e = await startEngine({ dbFile, dataDir, port: 0, dispatch: false, providers: () => new FakeProvider([]), env: {}, memoryReview: false });
      engines.push(e);
      return e;
    };
    const first = await start();
    first.db.prepare("INSERT INTO canvases (id, name, nodes, version, updated_by, updated_at) VALUES ('cv_1', 'Old board', '[]', 1, 'atlas', '2026-11-01T10:00:00.000Z')").run();
    expect(first.documents.convertCanvases()).toBe(1);
    const page = first.documents.byPath('atlas', 'pages/canvases/old-board.html')!;
    first.documents.remove(page.id);
    expect(first.documents.convertCanvases()).toBe(0);
    await first.stop();
    const second = await start(); // the start converts what is left (index.ts): nothing
    expect(second.db.prepare("SELECT count(*) AS n FROM documents WHERE from_canvas = 'cv_1'").get()).toEqual({ n: 0 });
    expect(existsSync(join(dataDir, 'workspaces', 'atlas', page.path))).toBe(false);
    expect(second.db.prepare("SELECT converted_at IS NOT NULL AS done FROM canvases WHERE id = 'cv_1'").get()).toEqual({ done: 1 });
  });
});

describe('API: a message about a document part', () => {
  it('puts the quoted section before the message', async () => {
    const { engine, put, docs } = await setup(new FakeProvider([[{ type: 'text', text: 'ok' }]]));
    const chat = engine.kanban.newChat('atlas');
    put('docs/perm.md', DESIGN);
    const d = docs.indexFile('atlas', 'docs/perm.md', 'atlas');
    const res = await fetch(`${engine.url}/api/cards/${chat.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Who decides?', ref: { docId: d.id, version: 1, section: 'flow' } }),
    });
    expect(res.status).toBe(201);
    const msg = (await res.json()) as { content: { type: string; text: string }[] };
    expect(msg.content).toHaveLength(2);
    expect(parseDocRef(msg.content[0]!.text)).toMatchObject({ docId: d.id, section: 'flow', label: 'Permissions design › Flow' });
    expect(msg.content[1]!.text).toBe('Who decides?');

    const panel = await fetch(`${engine.url}/api/chats/${chat.id}/panel/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: d.id }),
    });
    expect(((await panel.json()) as unknown[]).length).toBe(1);
    const content = (await (await fetch(`${engine.url}/api/documents/${d.id}?version=1`)).json()) as { content: string };
    expect(content.content).toBe(DESIGN);
  });
});

describe('deleting an artifact (#242)', () => {
  it('removes the file, every version and its panel tabs, for good; sync does not bring it back', async () => {
    const { docs, put, engine, events, ws } = await setup();
    const chat = engine.kanban.newChat('atlas');
    put('docs/gone.md', '# Gone\nv1');
    const d = docs.indexFile('atlas', 'docs/gone.md', 'atlas');
    put('docs/gone.md', '# Gone\nv2');
    docs.indexFile('atlas', 'docs/gone.md', 'atlas');
    docs.open(chat.id, d.id, 'user');
    put('docs/kept.md', '# Kept');
    const kept = docs.indexFile('atlas', 'docs/kept.md', 'atlas');

    const res = await fetch(`${engine.url}/api/documents/${d.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: d.id, versions: 2, file: true });
    expect(existsSync(join(ws, 'docs/gone.md'))).toBe(false);
    expect(() => docs.get(d.id)).toThrow(/not found/);
    expect(engine.db.prepare('SELECT COUNT(*) AS n FROM document_versions WHERE doc_id = ?').get(d.id)).toEqual({ n: 0 });
    expect(docs.tabs(chat.id)).toEqual([]);
    expect(events).toContainEqual({ type: 'document.deleted', id: d.id });
    expect(events).toContainEqual(expect.objectContaining({ type: 'panel.updated', chatId: chat.id, tabs: [] }));
    expect(docs.library().map((x) => x.id)).toEqual([kept.id]);
    expect((await fetch(`${engine.url}/api/documents/${d.id}`)).status).toBe(404);
    expect((await fetch(`${engine.url}/api/documents/${d.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('deletes an artifact whose file is already gone', async () => {
    const { docs, put, ws } = await setup();
    put('docs/a.md', '# A');
    const a = docs.indexFile('atlas', 'docs/a.md', 'atlas');
    rmSync(join(ws, 'docs/a.md'));
    expect(docs.remove(a.id)).toMatchObject({ versions: 1, file: false });
    expect(docs.library()).toEqual([]);
  });

  it('a file that cannot be deleted stops it: nothing changes', async () => {
    const { docs, put, ws } = await setup();
    put('docs/dir.md/x', 'not a file'); // docs/dir.md is a folder: unlink fails with EISDIR/EPERM
    put('docs/b.md', '# B');
    const b = docs.indexFile('atlas', 'docs/b.md', 'atlas');
    engines[0]!.db.prepare("UPDATE documents SET path = 'docs/dir.md' WHERE id = ?").run(b.id);
    expect(() => docs.remove(b.id)).toThrow(/could not delete the file docs\/dir\.md.*the artifact is kept/);
    expect(docs.get(b.id).version).toBe(1);
    expect(existsSync(join(ws, 'docs/dir.md/x'))).toBe(true);
  });

  it('artifact_delete: own artifacts only, by id or path', async () => {
    const { docs, put, engine } = await setup();
    engine.agents.create({ id: 'paris', rolePrompt: 'designer', modelId: 'sonnet' });
    const chat = engine.kanban.newChat('atlas');
    put('pages/mock.html', '<h1>Mock</h1>');
    const mine = docs.indexFile('atlas', 'pages/mock.html', 'atlas');
    const ctx = (agentId: string) => ({ documents: docs, agentId, chatId: chat.id, cardId: null });

    const refused = runDocTool('artifact_delete', { artifact: mine.id }, ctx('paris'));
    expect(refused).toMatchObject({ isError: true });
    expect(refused.output).toMatch(/@atlas's artifact: you can delete only your own/);
    expect(docs.get(mine.id).id).toBe(mine.id);

    expect(runDocTool('artifact_delete', { path: 'pages/mock.html' }, ctx('atlas')).output).toBe(`deleted Mock (${mine.id}, pages/mock.html): 1 version and the file removed`);
    expect(() => docs.get(mine.id)).toThrow(/not found/);
    expect(runDocTool('artifact_delete', { path: 'pages/mock.html' }, ctx('atlas')).output).toMatch(/no artifact pages\/mock\.html/);
    expect(runDocTool('artifact_delete', {}, ctx('atlas')).output).toMatch(/give the artifact/);
  });
});
