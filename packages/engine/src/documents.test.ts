import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    const text = formatDocRef({ id: 'doc_ab12cd34', title: 'Permissions design', path: 'docs/perm.md', canvasId: null }, 2, sec);
    expect(text).toContain('❝ Permissions design › Flow');
    expect(text).toContain('docs/perm.md, doc_ab12cd34 v2, section #flow');
    expect(text).toContain('> Tool call → policy.');
    expect(parseDocRef(text)).toEqual({ label: 'Permissions design › Flow', docId: 'doc_ab12cd34', version: 2, section: 'flow' });
    expect(parseDocRef(formatDocRef({ id: 'doc_x', title: 'Board', path: null, canvasId: 'cv_1' }, 4, null))).toEqual({ label: 'Board', docId: 'doc_x', version: 4, section: null });
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
    expect(() => docs.indexFile('atlas', 'notes.txt', 'atlas')).toThrow(/\.md, \.html and \.svg/);
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

  it('shows a canvas as a whiteboard document with the canvas versions', async () => {
    const { docs, engine } = await setup();
    const cv = engine.canvases.create({ name: 'Board' }, 'user');
    const d = docs.whiteboard(cv.id, 'atlas');
    expect(d).toMatchObject({ kind: 'whiteboard', canvasId: cv.id, title: 'Board', path: null });
    expect(docs.whiteboard(cv.id, 'atlas').id).toBe(d.id);
    expect(docs.versions(d.id).map((v) => v.version)).toEqual([1]);
  });
});

describe('library', () => {
  it('lists every document fresh: unsynced files, canvases as whiteboards with their current name', async () => {
    const { docs, put, engine } = await setup();
    put('docs/a.md', '# A');
    const cv = engine.canvases.create({ name: 'Sketch' }, 'user');
    let lib = docs.library();
    expect(lib.map((d) => [d.kind, d.title]).sort()).toEqual([['markdown', 'A'], ['whiteboard', 'Sketch']]);
    engine.canvases.rename(cv.id, 'System sketch', 'user');
    put('diagrams/f.svg', '<svg><title>Flow</title></svg>');
    lib = docs.library();
    expect(lib.map((d) => d.title).sort()).toEqual(['A', 'Flow', 'System sketch']);
    expect(lib.filter((d) => d.kind === 'whiteboard')).toHaveLength(1); // one document per canvas
    engine.canvases.remove(cv.id);
    expect(docs.library().map((d) => d.title).sort()).toEqual(['A', 'Flow']);
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
    expect(runDocTool('panel_open', {}, ctx).output).toMatch(/exactly one of path or canvas/);
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
    expect(fake.calls[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['panel_open', 'panel_close']));
    expect(fake.calls[0]!.system).toContain('panel_open shows one');
    const tab = docs.tabs(chat.id)[0]!;
    expect(tab).toMatchObject({ section: 'steps', openedBy: 'atlas', doc: { title: 'Plan', version: 1, cardId: null } });
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
