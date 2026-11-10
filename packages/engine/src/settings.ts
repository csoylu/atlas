import { UpdateSettings, type Settings as SettingsT } from '@atlas/shared';
import type { Db } from './store/db.ts';
import { ConflictError } from './kanban.ts';

/** Small key/value settings stored in SQLite. */
export class Settings {
  constructor(private db: Db) {}

  get(): SettingsT {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      triageAgent: map.get('triage_agent') || null,
    };
  }

  update(patch: unknown): SettingsT {
    const p = UpdateSettings.parse(patch);
    if (p.triageAgent !== undefined) {
      if (p.triageAgent && !this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(p.triageAgent))
        throw new ConflictError(`agent ${p.triageAgent} does not exist`);
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('triage_agent', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(p.triageAgent ?? '');
    }
    return this.get();
  }
}
