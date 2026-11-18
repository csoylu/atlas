import { UpdateSettings, type Settings as SettingsT } from '@atlas/shared';
import type { Db } from './store/db.ts';
import { ConflictError } from './kanban.ts';
import { defaultProjectId, leadOf } from './projects.ts';

/**
 * The voice orb's place relative to its display (desktop app, see apps/desktop/src/orb/model.ts): Electron display id,
 * orb centre from the work area's top-left, and that work area's size when saved.
 */
export interface OrbPosition {
  display: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const KEYS = ['display', 'x', 'y', 'width', 'height'] as const;
const isOrbPosition = (p: unknown): p is OrbPosition =>
  typeof p === 'object' && p !== null && KEYS.every((k) => Number.isFinite((p as Record<string, unknown>)[k])) &&
  (p as OrbPosition).width > 0 && (p as OrbPosition).height > 0;
/** Before #51 the orb saved absolute screen pixels, meaningless once the monitors change. */
const isLegacyPoint = (p: unknown) =>
  typeof p === 'object' && p !== null && Object.keys(p).sort().join() === 'x,y' && Number.isFinite((p as { x: unknown }).x) && Number.isFinite((p as { y: unknown }).y);

/** Small key/value settings stored in SQLite. */
export class Settings {
  constructor(private db: Db) {}

  get(): SettingsT {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      // The default project's lead (#213): Settings → Board's triage agent until the Projects page replaces it.
      triageAgent: this.defaultLead(),
      reviewAgent: map.get('review_agent') || null,
      userName: map.get('user_name') || null,
      userAbout: map.get('user_about') || null,
      memoryReviewModel: map.get('memory_review_model') || null,
    };
  }

  private defaultLead(): string | null {
    const r = this.db.prepare("SELECT id FROM projects WHERE status = 'active' ORDER BY created_at, rowid LIMIT 1").get() as { id: string } | undefined;
    return r ? leadOf(this.db, r.id) : null;
  }

  update(patch: unknown): SettingsT {
    const p = UpdateSettings.parse(patch);
    if (p.triageAgent !== undefined) {
      if (p.triageAgent && !this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(p.triageAgent))
        throw new ConflictError(`agent ${p.triageAgent} does not exist`);
      const project = defaultProjectId(this.db);
      this.db.transaction(() => {
        this.db.prepare('UPDATE projects SET lead = ? WHERE id = ?').run(p.triageAgent, project);
        // The lead is always a member.
        if (p.triageAgent)
          this.db
            .prepare("INSERT OR IGNORE INTO project_members (project_id, agent_id, clone_state, joined_at) VALUES (?, ?, 'ready', ?)")
            .run(project, p.triageAgent, new Date().toISOString());
      })();
    }
    if (p.reviewAgent !== undefined) {
      if (p.reviewAgent && !this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(p.reviewAgent)) throw new ConflictError(`agent ${p.reviewAgent} does not exist`);
      this.set('review_agent', p.reviewAgent ?? '');
    }
    if (p.userName !== undefined) this.set('user_name', p.userName);
    if (p.userAbout !== undefined) this.set('user_about', p.userAbout);
    if (p.memoryReviewModel !== undefined) {
      if (p.memoryReviewModel && p.memoryReviewModel !== 'off' && !this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(p.memoryReviewModel))
        throw new ConflictError(`model ${p.memoryReviewModel} does not exist`);
      this.set('memory_review_model', p.memoryReviewModel ?? '');
    }
    return this.get();
  }

  /** The human as agents see them: their name ('the user' until set) and their own description. */
  user(): { name: string; about: string | null } {
    const s = this.get();
    return { name: s.userName ?? 'the user', about: s.userAbout };
  }

  /**
   * Where the voice orb was last dragged to, relative to its display. Null until moved once, and for a pre-#51 value
   * (absolute pixels: we can't know which display they were on, so the orb starts again bottom-right).
   */
  orbPosition(): OrbPosition | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'orb_position'").get() as { value: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.value) as unknown;
    if (isLegacyPoint(p)) return null;
    // Fail loudly on a corrupt row rather than placing the orb at NaN.
    if (!isOrbPosition(p)) throw new Error(`settings.orb_position is not a position: ${row.value}`);
    return p;
  }

  setOrbPosition(p: OrbPosition): void {
    if (!isOrbPosition(p)) throw new Error(`not an orb position: ${JSON.stringify(p)}`);
    this.set('orb_position', JSON.stringify({ display: p.display, x: Math.round(p.x), y: Math.round(p.y), width: Math.round(p.width), height: Math.round(p.height) }));
  }

  private set(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
