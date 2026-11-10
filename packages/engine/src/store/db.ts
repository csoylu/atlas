import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Open (or create) the database and apply pending migrations. `:memory:` for tests. */
export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

/** First line of a migration that must run with foreign keys off (see migrate). */
export const FOREIGN_KEYS_OFF = '-- atlas: foreign_keys off';

export function migrate(db: Db): string[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT name FROM schema_migrations').all().map((r) => (r as { name: string }).name),
  );
  const pending = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !applied.has(f))
    .sort();
  for (const name of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    // A migration that rebuilds a table other tables reference (SQLite can't alter a CHECK) starts with this marker:
    // SQLite's documented procedure runs it with foreign keys off (a no-op inside a transaction, so it's set before)
    // and checks every reference before committing.
    const fkOff = sql.startsWith(FOREIGN_KEYS_OFF);
    const fkWas = db.pragma('foreign_keys', { simple: true }) as number;
    if (fkOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(sql);
        if (fkOff) {
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length) throw new Error(`migration ${name} breaks ${broken.length} foreign key reference(s): ${JSON.stringify(broken.slice(0, 3))}`);
        }
        db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
      })();
    } finally {
      if (fkOff) db.pragma(`foreign_keys = ${fkWas ? 'ON' : 'OFF'}`);
    }
  }
  return pending;
}
