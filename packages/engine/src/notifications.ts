import type { Inbox, InboxNeed, Notification, NotificationKind } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { NotFoundError, type Kanban } from './kanban.ts';

interface Row {
  id: number;
  at: string;
  kind: string;
  title: string;
  body: string;
  card_id: string | null;
  read_at: string | null;
  archived_at: string | null;
  /** The card's project (#213), from ROW_SELECT. */
  project_id: string | null;
}
/** A notification with its card's project (#213: the Inbox is one list, each row says its project). */
const ROW_SELECT = 'SELECT n.*, c.project_id FROM notifications n LEFT JOIN cards c ON c.id = n.card_id';
const toNotification = (r: Row): Notification => ({
  id: r.id,
  at: r.at,
  kind: r.kind,
  title: r.title,
  body: r.body,
  cardId: r.card_id,
  readAt: r.read_at,
  archivedAt: r.archived_at,
  projectId: r.project_id,
});

/** Rows the Inbox shows from the card's live state instead (« Needs you »), never as updates. */
const LIVE = "('card.blocked', 'card.review')"; // card.review: rows from before #189 (in review no longer needs the user)
const UPDATES_SHOWN = 200;

export interface NewNotification {
  kind: NotificationKind;
  title: string;
  body: string;
  cardId?: string | null;
}

/** Insert a row inside the caller's transaction; the caller emits `notification.created` with it after the commit. */
export function insertNotification(db: Db, n: NewNotification, at = new Date()): Notification {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO notifications (at, kind, title, body, card_id) VALUES (?, ?, ?, ?, ?)')
    .run(at.toISOString(), n.kind, n.title, n.body, n.cardId ?? null);
  return toNotification(db.prepare(`${ROW_SELECT} WHERE n.id = ?`).get(lastInsertRowid) as Row);
}

/** Things the user is told about: a row each, an event the app turns into a system notification, and the Inbox. */
export class Notifications {
  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private now: () => number = Date.now,
  ) {}

  create(n: NewNotification): Notification {
    const created = insertNotification(this.db, n, new Date(this.now()));
    this.bus.emit({ type: 'notification.created', notification: created });
    return created;
  }

  list(limit = 50): Notification[] {
    return (this.db.prepare(`${ROW_SELECT} ORDER BY n.id DESC LIMIT ?`).all(limit) as Row[]).map(toNotification);
  }

  /**
   * « Needs you »: board cards blocked (except transient: those retry by themselves) (not in review: that waits for QA, #189), from their live
   * state. « Updates »: rows not archived, newest first, without the card.blocked / card.review ones.
   */
  inbox(): Inbox {
    const latest = this.db.prepare(`SELECT * FROM notifications WHERE card_id = ? AND kind IN ${LIVE} ORDER BY id DESC LIMIT 1`);
    const lastRun = this.db.prepare('SELECT status FROM runs WHERE card_id = ? ORDER BY started_at DESC LIMIT 1');
    const needsYou: InboxNeed[] = this.kanban
      .list()
      // In review waits for QA, not the user (#189).
      .filter((c) => c.status === 'blocked' && c.block?.kind !== 'transient')
      .map((card) => {
        const entered = this.enteredAt(card.id, card.status);
        const row = latest.get(card.id) as Row | undefined;
        // A row from an earlier wait (before the card moved on and came back) doesn't describe this one.
        const own = row && row.kind === 'card.blocked' && row.at >= entered ? row : undefined;
        const run = lastRun.get(card.id) as { status: string } | undefined;
        return {
          card,
          since: own?.at ?? (entered || card.updatedAt),
          failed: card.status === 'blocked' && card.block?.kind === 'capability' && run?.status === 'failed',
          notificationId: own?.id ?? null,
          unread: !!own && !own.read_at,
          summary: null,
        };
      })
      .sort((a, b) => b.since.localeCompare(a.since));
    const updates = (
      this.db.prepare(`${ROW_SELECT} WHERE n.archived_at IS NULL AND n.kind NOT IN ${LIVE} AND (c.project_id IS NULL OR c.project_id IN (SELECT id FROM projects WHERE status = 'active')) ORDER BY n.id DESC LIMIT ?`).all(UPDATES_SHOWN) as Row[]
    ).map(toNotification);
    return { needsYou, updates, badge: needsYou.length + updates.filter((u) => !u.readAt).length };
  }

  /** When the card last entered this status ('' if no event says so). */
  private enteredAt(cardId: string, status: string): string {
    const rows = this.db
      .prepare("SELECT at, kind, payload FROM card_events WHERE card_id = ? AND kind IN ('blocked', 'status') ORDER BY id DESC LIMIT 20")
      .all(cardId) as { at: string; kind: string; payload: string }[];
    for (const r of rows) {
      if (status === 'blocked' && r.kind === 'blocked') return r.at;
      if (r.kind === 'status' && (JSON.parse(r.payload) as { to?: string }).to === status) return r.at;
    }
    return '';
  }

  read(id: number): void {
    this.change('UPDATE notifications SET read_at = @at WHERE id = @id AND read_at IS NULL', id);
  }

  /** Archiving reads it too: it leaves the list and the badge. */
  archive(id: number): void {
    this.change('UPDATE notifications SET archived_at = @at, read_at = COALESCE(read_at, @at) WHERE id = @id AND archived_at IS NULL', id);
  }

  /** « Archive all read »: the updates already read leave the list. Returns how many. */
  archiveRead(): number {
    const { changes } = this.db
      .prepare(`UPDATE notifications SET archived_at = ? WHERE archived_at IS NULL AND read_at IS NOT NULL AND kind NOT IN ${LIVE}`)
      .run(new Date(this.now()).toISOString());
    if (changes) this.bus.emit({ type: 'inbox.changed' });
    return changes;
  }

  private change(sql: string, id: number): void {
    if (!this.db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(id)) throw new NotFoundError(`notification ${id} not found`);
    const { changes } = this.db.prepare(sql).run({ at: new Date(this.now()).toISOString(), id });
    if (changes) this.bus.emit({ type: 'inbox.changed' });
  }
}
