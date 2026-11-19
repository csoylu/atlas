import { cardRef, stallText, type Card, type CardStall, type Run } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import type { Kanban } from './kanban.ts';
import type { Runner } from './runner.ts';
import { insertNotification } from './notifications.ts';
import { leadOf } from './projects.ts';

/**
 * Stalls (#237, design §7.2): a task stuck in its state with nothing moving it gets a mark on its card, one Inbox item
 * for Master and a note to its project's lead. Computed on the dispatcher's tick, stored in card_stalls (one row per
 * task, for its current reason), so a restart neither loses nor repeats an item. The row (and its Inbox item) goes
 * when the task moves or the reason clears.
 */

/** How long a state may last with nothing moving the task (rule 1: constants, no setting). Blocked is never stuck. */
export const STALL_LIMITS: Record<CardStall['rule'], number> = {
  review: 45 * 60_000,
  running: 10 * 60_000,
  ready: 30 * 60_000,
  todo: 10 * 60_000,
};
/** The dispatcher ticks every second; stalls are looked at this often. */
export const STALL_CHECK_MS = 30_000;

/** What the rules need to know about one task, gathered from the tables. */
export interface StallFacts {
  card: Card;
  now: number;
  /** A run (any kind) is on the task right now. */
  running: boolean;
  /** When the task's last run ended, if it has one. */
  lastRunEnd: string | null;
  /** Ready: why its assignee can't start it now (busy, disabled, model failed), or null: a slot is free. */
  startProblem: string | null;
  /** Todo: its parents. */
  parents: Card[];
  /** In review: the #221 stall (the review ended twice without a verdict), in words, or null. */
  reviewStall: string | null;
}

const later = (...isos: (string | null | undefined)[]): string => isos.filter((x): x is string => !!x).sort().at(-1)!;
const over = (since: string, rule: CardStall['rule'], now: number) => now - Date.parse(since) >= STALL_LIMITS[rule];

/** Whether the task is stuck, and why (pure: stalls.test.ts covers each rule). */
export function detectStall(f: StallFacts): CardStall | null {
  const { card: c, now } = f;
  if (c.board !== 'main' || f.running) return null;
  const inState = c.statusSince ?? c.updatedAt;
  switch (c.status) {
    case 'review': {
      if (f.reviewStall) return { rule: 'review', reason: f.reviewStall, since: later(inState, f.lastRunEnd), action: 'retry_review' };
      const open = c.prs.filter((p) => p.state === 'open');
      // GitHub unreadable has its own item; CI still running or red, or a verdict given: something else moves it.
      if (!open.length || open.some((p) => p.error || p.ci !== 'success' || p.qa === 'failure') || open.every((p) => p.qa === 'success')) return null;
      const since = later(inState, f.lastRunEnd);
      if (!over(since, 'review', now)) return null;
      const why = c.waiting && !/^waiting for @\S+$/.test(c.waiting) ? ` (${c.waiting})` : '';
      return { rule: 'review', reason: `CI is green, no review is running${why}`, since, action: 'retry_review' };
    }
    case 'running': {
      const since = later(inState, f.lastRunEnd);
      if (!over(since, 'running', now)) return null;
      const ended = f.lastRunEnd && f.lastRunEnd >= inState;
      return { rule: 'running', reason: ended ? 'its last run ended and no new run started' : 'no run started', since, action: 'restart' };
    }
    case 'ready': {
      if (!c.assignee || f.startProblem || !over(inState, 'ready', now)) return null;
      return { rule: 'ready', reason: `@${c.assignee} has a free slot but no run started`, since: inState, action: 'restart' };
    }
    case 'todo': {
      if (c.retry || !c.parents.length || f.parents.length !== c.parents.length) return null;
      if (!f.parents.every((p) => p.status === 'done' || p.status === 'closed')) return null;
      const since = later(inState, ...f.parents.map((p) => p.statusSince ?? p.updatedAt));
      if (!over(since, 'todo', now)) return null;
      const closed = f.parents.filter((p) => p.status === 'closed');
      if (closed.length)
        return {
          rule: 'todo',
          reason: `parent ${closed.map(cardRef).join(', ')} was closed (cancelled): remove it from the parents, or close this task`,
          since,
          action: 'open',
        };
      return { rule: 'todo', reason: `its parents are done (${f.parents.map(cardRef).join(', ')}) but it did not move to Ready`, since, action: 'ready' };
    }
    default:
      return null;
  }
}

/** The stored stall of a task (Card.stall), or null. */
export function stallOf(db: Db, cardId: string): CardStall | null {
  const r = db.prepare('SELECT rule, reason, since, action FROM card_stalls WHERE card_id = ?').get(cardId) as CardStall | undefined;
  return r ? { rule: r.rule, reason: r.reason, since: r.since, action: r.action } : null;
}

const ACTION_HINT: Record<CardStall['action'], string> = {
  retry_review: 'Retry the review starts the reviewer again.',
  restart: 'Restart the run starts a new run of the task.',
  ready: 'Move to Ready lets it start.',
  open: 'Open the task to decide.',
};

export class Stalls {
  /** Set by the dispatcher: why a ready task's assignee can't start it now (null = a free slot). */
  startProblem: (c: Card) => string | null = () => null;
  /** Set by the PR watcher: the #221 review stall in words. */
  reviewStall: (c: Card) => string | null = () => null;
  /** Set by the dispatcher: wake the agent of a chat a note was posted in. */
  deliver: (cardId: string) => void = () => {};
  private last = 0;

  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private runner: Runner,
    readonly now: () => number = Date.now,
  ) {}

  /** From the dispatcher's tick: at most every STALL_CHECK_MS. */
  maybeCheck(): void {
    if (this.now() - this.last < STALL_CHECK_MS) return;
    this.check();
  }

  /** Look at every task now: add, update or clear its stall. */
  check(): void {
    this.last = this.now();
    const cards = this.kanban.list();
    const byId = new Map(cards.map((c) => [c.id, c]));
    const seen = new Set<string>();
    for (const c of cards) {
      seen.add(c.id);
      if (!c.stall && !['review', 'running', 'ready', 'todo'].includes(c.status)) continue;
      const last: Run | undefined = c.status === 'review' || c.status === 'running' ? this.runner.runs(c.id)[0] : undefined;
      const stall = detectStall({
        card: c,
        now: this.now(),
        running: !!this.runner.current(c.id),
        lastRunEnd: last?.endedAt ?? null,
        startProblem: c.status === 'ready' ? this.startProblem(c) : null,
        parents: c.status === 'todo' ? c.parents.flatMap((p) => byId.get(p) ?? this.cardOrNone(p)) : [],
        reviewStall: c.status === 'review' ? this.reviewStall(c) : null,
      });
      this.apply(c, stall);
    }
    // Rows of tasks no longer on the board (archived, deleted, project archived) go too.
    for (const { card_id } of this.db.prepare('SELECT card_id FROM card_stalls').all() as { card_id: string }[])
      if (!seen.has(card_id)) this.clear(card_id);
  }

  private cardOrNone(id: string): Card[] {
    return this.db.prepare('SELECT 1 FROM cards WHERE id = ?').get(id) ? [this.kanban.get(id)] : [];
  }

  private apply(card: Card, stall: CardStall | null): void {
    const stored = card.stall;
    if (!stall) {
      if (stored) this.clear(card.id);
      return;
    }
    if (stored && stored.rule === stall.rule && stored.action === stall.action) {
      if (stored.reason === stall.reason && stored.since === stall.since) return;
      this.db.prepare('UPDATE card_stalls SET reason = ?, since = ? WHERE card_id = ?').run(stall.reason, stall.since, card.id);
      this.kanban.emit(card.id);
      return;
    }
    // New, or another reason: one Inbox item per task and reason; the lead hears of it once.
    const now = new Date(this.now()).toISOString();
    const text = stallText(stall, card.statusSince, this.now());
    const lead = leadOf(this.db, card.projectId);
    const created = this.db.transaction(() => {
      this.archiveItem(card.id, now);
      const n = insertNotification(this.db, { kind: 'card.stalled', title: `Stuck: ${card.title}`, body: `${text}. ${ACTION_HINT[stall.action]}`, cardId: card.id }, new Date(this.now()));
      this.db
        .prepare(
          `INSERT INTO card_stalls (card_id, rule, reason, action, since, notification_id, lead_noted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (card_id) DO UPDATE SET rule = excluded.rule, reason = excluded.reason, action = excluded.action,
             since = excluded.since, notification_id = excluded.notification_id, lead_noted_at = excluded.lead_noted_at`,
        )
        .run(card.id, stall.rule, stall.reason, stall.action, stall.since, n.id, lead ? now : null);
      const chat = lead ? this.kanban.mainChat(lead, card.projectId) : null;
      if (chat)
        this.kanban.appendMessage(chat.id, 'user', 'system', [
          {
            type: 'text',
            text: `Task ${cardRef(card)} “${card.title}” is stuck: ${text}. Master has an Inbox item for it. As the project lead, look at it (task_show ${cardRef(card)}) and unstick it if you can; the mark clears by itself when the task moves.`,
          },
        ]);
      return { n, chat };
    })();
    this.bus.emit({ type: 'notification.created', notification: created.n });
    this.kanban.emit(card.id);
    if (created.chat) this.deliver(created.chat.id);
  }

  private clear(cardId: string): void {
    const now = new Date(this.now()).toISOString();
    this.db.transaction(() => {
      this.archiveItem(cardId, now);
      this.db.prepare('DELETE FROM card_stalls WHERE card_id = ?').run(cardId);
    })();
    this.bus.emit({ type: 'inbox.changed' });
    if (this.db.prepare('SELECT 1 FROM cards WHERE id = ?').get(cardId)) this.kanban.emit(cardId);
  }

  /** The task's stall item leaves the Inbox (already archived by Master: nothing to do). */
  private archiveItem(cardId: string, at: string): void {
    this.db
      .prepare(
        `UPDATE notifications SET archived_at = ?, read_at = COALESCE(read_at, ?)
          WHERE id = (SELECT notification_id FROM card_stalls WHERE card_id = ?) AND archived_at IS NULL`,
      )
      .run(at, at, cardId);
  }
}
