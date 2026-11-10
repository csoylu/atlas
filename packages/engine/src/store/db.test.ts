import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
});
