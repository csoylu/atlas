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
    const file = join(mkdtempSync(join(tmpdir(), 'atlas-')), 'u.db');
    const db = openDb(file);
    db.prepare("DELETE FROM schema_migrations WHERE name = '0021_user.sql'").run();
    db.prepare("INSERT INTO conversations (id, kind) VALUES ('k', 'chat')").run();
    db.prepare("INSERT INTO cards (id, title, status, conversation_id, created_by, created_at, updated_at) VALUES ('c', 't', 'triage', 'k', 'can', 'x', 'x')").run();
    db.prepare("INSERT INTO messages (id, conversation_id, seq, role, author, content, at) VALUES ('m1', 'k', 1, 'user', 'can', '[]', 'x'), ('m2', 'k', 2, 'assistant', 'atlas', '[]', 'x')").run();
    db.prepare(`INSERT INTO card_events (card_id, at, kind, payload) VALUES ('c', 'x', 'created', '{"by":"can"}')`).run();
    expect(migrate(db)).toEqual(['0021_user.sql']);
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
});
