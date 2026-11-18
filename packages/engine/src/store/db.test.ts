import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, openDb } from './db.ts';

describe('store', () => {
  it('applies migrations once and survives reopening', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'atlas-')), 'h.db');
    const db = openDb(file);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.prepare("INSERT INTO conversations (id, kind) VALUES ('x', 'chat')").run();
    db.close();
    const again = openDb(file);
    expect(migrate(again)).toEqual([]);
    expect(again.prepare('SELECT id FROM conversations').all()).toEqual([{ id: 'x' }]);
    again.close();
  });

  it('0020 turns the single Claude and ChatGPT sign-ins into the first subscription of each, with no new sign-in', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.pragma('foreign_keys = OFF');
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0020').sort()) {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, 'x');
    }
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO claude_account (id, client_id, email, expires_at, signed_in_at, welcomed) VALUES (1, 'cid', 'user@example.com', '2026-11-11T23:50:04Z', '2026-11-11T10:00:00Z', 1)").run();
    db.prepare("INSERT INTO chatgpt_account (id, host_id, client_id, subject, email, scopes, welcomed) VALUES (1, 'urn:uuid:h', 'oaiapp_1', 'sub1', 'can@example.com', 'chatgpt.tokens.use.direct', 1)").run();
    db.prepare("INSERT INTO model_usage (at, model_id, provider, kind) VALUES ('2026-11-11', 'opus', 'claude_plan', 'turn')").run();
    expect(migrate(db)).toContain('0020_plan_accounts.sql');
    expect(db.prepare('SELECT id, provider, label, position, secret, client_id, email, subject FROM plan_accounts ORDER BY provider').all()).toEqual([
      { id: 'pa_chatgpt1', provider: 'chatgpt', label: 'Main', position: 0, secret: 'CHATGPT_TOKENS', client_id: 'oaiapp_1', email: 'can@example.com', subject: 'sub1' },
      { id: 'pa_claude1', provider: 'claude_plan', label: 'Main', position: 0, secret: 'CLAUDE_TOKENS', client_id: 'cid', email: 'user@example.com', subject: null },
    ]);
    expect(db.prepare("SELECT key, value FROM settings WHERE key IN ('claude_welcomed', 'chatgpt_welcomed', 'chatgpt_host_id') ORDER BY key").all()).toEqual([
      { key: 'chatgpt_host_id', value: 'urn:uuid:h' },
      { key: 'chatgpt_welcomed', value: '1' },
      { key: 'claude_welcomed', value: '1' },
    ]);
    expect(db.prepare('SELECT account_id FROM model_usage').get()).toEqual({ account_id: null });
  });

  it("0021 renames the human's id from 'can' to 'user' everywhere it is stored", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.pragma('foreign_keys = OFF'); // cards without agents, like the 0020/0025 tests
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0021').sort()) {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, 'x');
    }
    db.prepare("INSERT INTO conversations (id, kind) VALUES ('k', 'chat')").run();
    db.prepare("INSERT INTO conversations (id, kind) VALUES ('cv', 'chat')").run();
    db.prepare("INSERT INTO cards (id, title, status, conversation_id, created_by, created_at, updated_at) VALUES ('c', 't', 'triage', 'k', 'can', 'x', 'x')").run();
    db.prepare("INSERT INTO messages (id, conversation_id, seq, role, author, content, at) VALUES ('m1', 'k', 1, 'user', 'can', '[]', 'x'), ('m2', 'k', 2, 'assistant', 'atlas', '[]', 'x')").run();
    db.prepare(`INSERT INTO card_events (card_id, at, kind, payload) VALUES ('c', 'x', 'created', '{"by":"can"}')`).run();
    expect(migrate(db)[0]).toBe('0021_user.sql');
    expect(db.prepare('SELECT author FROM messages ORDER BY seq').all()).toEqual([{ author: 'user' }, { author: 'atlas' }]);
    expect(db.prepare('SELECT created_by FROM cards').get()).toEqual({ created_by: 'user' });
    expect(db.prepare('SELECT payload FROM card_events').get()).toEqual({ payload: '{"by":"user"}' });
    db.close();
  });

  it('0025 numbers board cards #1..#N in creation order (archived included, direct chats not); new ones continue', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.pragma('foreign_keys = OFF');
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0025').sort()) {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, 'x');
    }
    const add = db.prepare("INSERT INTO conversations (id, kind) VALUES (?, 'card')");
    const card = db.prepare(
      'INSERT INTO cards (id, board, title, status, conversation_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const [id, board, status, at] of [
      ['c_late', 'main', 'ready', '2026-11-03'],
      ['c_chat', 'direct', 'done', '2026-11-01'],
      ['c_first', 'main', 'archived', '2026-11-01'],
      ['c_tie_a', 'main', 'done', '2026-11-02'],
      ['c_tie_b', 'main', 'closed', '2026-11-02'],
    ] as const) {
      add.run('conv_' + id);
      card.run(id, board, id, status, 'conv_' + id, 'user', at, at);
    }
    expect(migrate(db)[0]).toBe('0025_card_numbers.sql');
    expect(db.prepare('SELECT id, number FROM cards ORDER BY id').all()).toEqual([
      { id: 'c_chat', number: null },
      { id: 'c_first', number: 1 },
      { id: 'c_late', number: 4 },
      { id: 'c_tie_a', number: 2 },
      { id: 'c_tie_b', number: 3 },
    ]);
    expect(db.prepare('SELECT last FROM card_counter').get()).toEqual({ last: 4 });
    expect(db.prepare("SELECT 1 AS ok FROM schema_migrations WHERE name = '0025_card_numbers.sql'").get()).toEqual({ ok: 1 });
  });

  it('0037 drops drawing nodes (Excalidraw removed): drawing-only canvases go with their whiteboard docs, others keep the rest', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.pragma('foreign_keys = OFF');
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0037').sort()) {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, 'x');
    }
    db.pragma('foreign_keys = ON');
    const node = (id: string, kind: string) => ({ id, kind, x: 0, y: 0, w: 100, h: 100, title: '' });
    const canvas = db.prepare("INSERT INTO canvases (id, name, nodes, version, updated_by, updated_at) VALUES (?, ?, ?, 3, 'user', 'x')");
    const version = db.prepare("INSERT INTO canvas_versions VALUES (?, 3, ?, 'user', 'x')");
    for (const [id, nodes] of [
      ['cv_draw', [node('d', 'drawing')]],
      ['cv_mixed', [node('d', 'drawing'), { ...node('h', 'html'), html: '<p>' }]],
      ['cv_empty', []],
    ] as const) {
      canvas.run(id, id, JSON.stringify(nodes));
      version.run(id, JSON.stringify(nodes));
      db.prepare("INSERT INTO documents (id, agent_id, canvas_id, kind, title, version, updated_by, updated_at) VALUES (?, 'atlas', ?, 'whiteboard', ?, 1, 'user', 'x')").run('doc_' + id, id, id);
    }
    db.exec(readFileSync(join(dir, '0037_drop_drawings.sql'), 'utf8'));
    expect(db.prepare('SELECT id FROM canvases ORDER BY id').all()).toEqual([{ id: 'cv_empty' }, { id: 'cv_mixed' }]);
    expect(db.prepare('SELECT canvas_id FROM documents ORDER BY canvas_id').all()).toEqual([{ canvas_id: 'cv_empty' }, { canvas_id: 'cv_mixed' }]);
    const kinds = (json: string) => (JSON.parse(json) as { kind: string }[]).map((n) => n.kind);
    expect(kinds((db.prepare("SELECT nodes FROM canvases WHERE id = 'cv_mixed'").get() as { nodes: string }).nodes)).toEqual(['html']);
    expect(db.prepare('SELECT canvas_id, nodes FROM canvas_versions ORDER BY canvas_id').all().map((r) => [(r as { canvas_id: string }).canvas_id, kinds((r as { nodes: string }).nodes)])).toEqual([
      ['cv_empty', []],
      ['cv_mixed', ['html']],
    ]);
    db.close();
  });

  it('0041 artifacts: whiteboard docs go, file docs stay (url kind and folders allowed), canvases stay archived', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.pragma('foreign_keys = OFF');
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0041').sort()) {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, 'x');
    }
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO canvases (id, name, nodes, version, updated_by, updated_at) VALUES ('cv_1', 'Board', '[]', 1, 'user', 'x')").run();
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO conversations (id, kind) VALUES ('cv', 'chat')").run();
    db.prepare("INSERT INTO cards (id, title, status, conversation_id, created_at, updated_at, created_by) VALUES ('c_1', 'chat', 'todo', 'cv', 'x', 'x', 'user')").run();
    const doc = db.prepare('INSERT INTO documents (id, agent_id, path, canvas_id, kind, title, version, updated_by, updated_at, pinned_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)');
    doc.run('doc_w', 'atlas', null, 'cv_1', 'whiteboard', 'Board', 'user', 'x', null);
    doc.run('doc_f', 'atlas', 'docs/a.md', null, 'markdown', 'A', 'atlas', 'x', 'p');
    for (const id of ['doc_w', 'doc_f']) {
      db.prepare("INSERT INTO document_versions VALUES (?, 1, 'c', 'atlas', 'x')").run(id);
      db.prepare("INSERT INTO panel_tabs VALUES ('c_1', ?, 'atlas', 'x', 'x', NULL, 1)").run(id);
    }
    db.pragma('foreign_keys = ON');
    expect(migrate(db)).toContain('0041_artifacts.sql');
    expect(db.prepare('SELECT id, kind, pinned_at, folder_id FROM documents').all()).toEqual([{ id: 'doc_f', kind: 'markdown', pinned_at: 'p', folder_id: null }]);
    expect(db.prepare('SELECT doc_id FROM document_versions').all()).toEqual([{ doc_id: 'doc_f' }]);
    expect(db.prepare('SELECT doc_id FROM panel_tabs').all()).toEqual([{ doc_id: 'doc_f' }]);
    expect(db.prepare('SELECT id FROM canvases').all()).toEqual([{ id: 'cv_1' }]);
    db.prepare("INSERT INTO folders (id, name, created_at) VALUES ('fld_1', 'Feeds', 'x')").run();
    db.prepare("INSERT INTO documents (id, agent_id, path, kind, title, version, updated_by, updated_at, folder_id) VALUES ('doc_u', 'atlas', 'links/a.url', 'url', 'A', 1, 'atlas', 'x', 'fld_1')").run();
    db.prepare("DELETE FROM folders WHERE id = 'fld_1'").run();
    expect(db.prepare("SELECT folder_id FROM documents WHERE id = 'doc_u'").get()).toEqual({ folder_id: null });
    // Cascades still point at the rebuilt table.
    db.prepare("DELETE FROM documents WHERE id = 'doc_f'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM document_versions').get()).toEqual({ n: 0 });
    db.close();
  });

  it('0048 projects: everything becomes Atlas, every agent a member in its own workdir, the triage agent its lead', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.pragma('foreign_keys = OFF');
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0048').sort()) {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, 'x');
    }
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO agents (id, role_prompt, model_id, workdir) VALUES ('munih', 'r', 'sonnet', '/w/munih')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('triage_agent', 'munih')").run();
    db.prepare("INSERT INTO conversations (id, kind) VALUES ('k', 'card')").run();
    db.prepare("INSERT INTO cards (id, title, status, conversation_id, created_by, created_at, updated_at) VALUES ('c_1', 't', 'ready', 'k', 'user', 'x', 'x')").run();
    db.prepare("INSERT INTO folders (id, name, created_at) VALUES ('fld_1', 'Feeds', 'x')").run();
    expect(migrate(db)[0]).toBe('0048_projects.sql'); // and every later one
    expect(db.prepare('SELECT id, name, repo, lead, status FROM projects').all()).toEqual([{ id: 'atlas', name: 'Atlas', repo: 'csoylu/atlas', lead: 'munih', status: 'active' }]);
    expect(db.prepare('SELECT agent_id, workspace, clone_state FROM project_members ORDER BY agent_id').all()).toEqual([
      { agent_id: 'atlas', workspace: null, clone_state: 'ready' },
      { agent_id: 'munih', workspace: null, clone_state: 'ready' },
    ]);
    expect(db.prepare("SELECT workdir FROM agents WHERE id = 'munih'").get()).toEqual({ workdir: '/w/munih' }); // nothing moves
    expect(db.prepare("SELECT 1 FROM settings WHERE key = 'triage_agent'").get()).toBeUndefined();
    for (const t of ['cards', 'folders', 'documents', 'workflows', 'memories']) expect(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id IS NOT 'atlas'`).get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT project_id FROM cards').all()).toEqual([{ project_id: 'atlas' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('0050 project gate: Atlas keeps CI job « test » and the changelog rule, another project gets any check, no changelog', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.pragma('foreign_keys = OFF');
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0050').sort()) {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, 'x');
    }
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO projects (id, name, repo, colour, created_at) VALUES ('datinel', 'Datinel', 'datinel/datinel', 200, 'x')").run();
    migrate(db);
    expect(db.prepare('SELECT id, ci_job, changelog FROM projects ORDER BY id').all()).toEqual([
      { id: 'atlas', ci_job: 'test', changelog: 1 },
      { id: 'datinel', ci_job: null, changelog: 0 },
    ]);
    db.close();
  });
});
