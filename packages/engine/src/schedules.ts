import * as CronParser from 'cron-parser';
import { randomUUID } from 'node:crypto';
import { CreateSchedule, ScheduleWhen, UpdateSchedule, type Card, type Schedule, type ScheduleKind } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { ConflictError, InvalidError, NotFoundError, type Kanban } from './kanban.ts';

interface Row {
  id: string;
  agent_id: string;
  title: string;
  kind: ScheduleKind;
  cron: string | null;
  at: string | null;
  prompt: string;
  create_card: number;
  timezone: string;
  enabled: number;
  next_run_at: string | null;
  last_fired_at: string | null;
  last_card_id: string | null;
  chat_card_id: string | null;
  last_error: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}
const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  agentId: r.agent_id,
  title: r.title,
  kind: r.kind,
  cron: r.cron,
  at: r.at,
  prompt: r.prompt,
  createCard: !!r.create_card,
  timezone: r.timezone,
  enabled: !!r.enabled,
  nextRunAt: r.next_run_at,
  lastFiredAt: r.last_fired_at,
  lastCardId: r.last_card_id,
  chatCardId: r.chat_card_id,
  lastError: r.last_error,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

type When = Pick<Schedule, 'kind' | 'cron' | 'at' | 'timezone'>;

/** The engine machine's time zone: the default for schedules made without one (Can's Mac: Europe/Paris). */
export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The next `n` firings strictly after `from` (fewer for a one-shot). Throws InvalidError on a bad cron expression. */
export function upcoming(s: When, from: Date, n = 1): string[] {
  if (s.kind === 'at') return s.at && new Date(s.at) > from ? [new Date(s.at).toISOString()] : [];
  let expr;
  try {
    expr = CronParser.CronExpressionParser.parse(s.cron ?? '', { tz: s.timezone, currentDate: from });
  } catch (e) {
    throw new InvalidError(`cron "${s.cron}": ${e instanceof Error ? e.message : String(e)}`);
  }
  return Array.from({ length: n }, () => expr.next().toDate().toISOString());
}

export function describeWhen(s: When): string {
  return s.kind === 'cron' ? `cron "${s.cron}" (${s.timezone})` : `once at ${s.at}`;
}

/** A firing that happens this much after its due time (engine was off) says so in the prompt. */
const LATE_MS = 2 * 60_000;

/**
 * Schedules (design §9). A firing gives the agent the prompt: on a new card (createCard), or on the schedule's own
 * card, reopened each time so the conversation keeps the history of earlier runs. The dispatcher then runs the card
 * like any other. Each firing claims the schedule (compare-and-set on next_run_at) in the same transaction as the card
 * it creates, so a restart never fires twice; runs missed while the engine was off fire once at start, noted.
 */
export class Schedules {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private now: () => Date = () => new Date(),
  ) {}

  start(intervalMs = 15_000): void {
    this.stop();
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  list(): Schedule[] {
    return (this.db.prepare('SELECT * FROM schedules ORDER BY enabled DESC, next_run_at IS NULL, next_run_at, created_at').all() as Row[]).map(toSchedule);
  }

  get(id: string): Schedule {
    const row = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new NotFoundError(`schedule ${id} not found`);
    return toSchedule(row);
  }

  create(input: CreateSchedule, by: string): Schedule {
    const c = CreateSchedule.parse(input);
    this.checkAgent(c.agentId);
    const when = { kind: c.kind, cron: c.kind === 'cron' ? c.cron : null, at: c.kind === 'at' ? c.at : null, timezone: c.timezone ?? localTimeZone() };
    const next = c.enabled ? this.firstRun(when) : null;
    const id = 'sch_' + randomUUID().slice(0, 8);
    const now = this.now().toISOString();
    const title = c.title ?? firstLine(c.prompt);
    this.db
      .prepare(
        `INSERT INTO schedules (id, agent_id, title, kind, cron, at, prompt, create_card, timezone, enabled, next_run_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, c.agentId, title, when.kind, when.cron, when.at, c.prompt, c.createCard ? 1 : 0, when.timezone, c.enabled ? 1 : 0, next, by, now, now);
    return this.emit(id);
  }

  update(id: string, patch: UpdateSchedule): Schedule {
    const p = UpdateSchedule.parse(patch);
    const cur = this.get(id);
    const m = { ...cur, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) } as Schedule;
    ScheduleWhen.parse(m);
    if (p.agentId !== undefined) this.checkAgent(m.agentId);
    if (m.kind === 'cron') m.at = null;
    else m.cron = null;
    const timingChanged = (['kind', 'cron', 'at', 'timezone', 'enabled'] as const).some((k) => p[k] !== undefined && p[k] !== cur[k]);
    if (timingChanged) m.nextRunAt = m.enabled ? this.firstRun(m) : null;
    this.db
      .prepare(
        `UPDATE schedules SET agent_id = ?, title = ?, kind = ?, cron = ?, at = ?, prompt = ?, create_card = ?, timezone = ?, enabled = ?,
           next_run_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(m.agentId, m.title, m.kind, m.cron, m.at, m.prompt, m.createCard ? 1 : 0, m.timezone, m.enabled ? 1 : 0, m.nextRunAt, this.now().toISOString(), id);
    return this.emit(id);
  }

  /** Delete the schedule. Its cards stay: they hold the history. */
  remove(id: string): void {
    this.get(id);
    this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    this.bus.emit({ type: 'schedule.deleted', id });
  }

  /** Fire now, by hand; the planned next run is unchanged. Returns the card that got the prompt. */
  runNow(id: string): Card {
    return this.kanban.get(this.fire(this.get(id), true)!);
  }

  /** Fire every enabled schedule that is due. One failing schedule is recorded on it and doesn't stop the others. */
  tick(): void {
    const now = this.now().toISOString();
    const due = (this.db.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at').all(now) as Row[]).map(toSchedule);
    for (const s of due) {
      try {
        this.fire(s, false);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error(`schedule ${s.id} failed to fire`, error);
        // Move past this slot anyway, or it would fail again every tick.
        const next = s.kind === 'cron' ? safeNext(s, this.now()) : null;
        this.db
          .prepare('UPDATE schedules SET last_error = ?, next_run_at = ?, enabled = ?, updated_at = ? WHERE id = ?')
          .run(error, next, next ? 1 : 0, now, s.id);
        this.emit(s.id);
      }
    }
  }

  /** Give the agent the prompt. Returns the card id, or null if another tick already fired this slot. */
  private fire(s: Schedule, manual: boolean): string | null {
    const now = this.now();
    const iso = now.toISOString();
    const cardId = this.db.transaction((): string | null => {
      if (!manual) {
        const next = s.kind === 'cron' ? upcoming(s, now)[0]! : null;
        const claimed = this.db
          .prepare('UPDATE schedules SET next_run_at = ?, enabled = ?, last_fired_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?')
          .run(next, next ? 1 : 0, iso, s.id, s.nextRunAt);
        if (claimed.changes === 0) return null;
      } else this.db.prepare('UPDATE schedules SET last_fired_at = ? WHERE id = ?').run(iso, s.id);

      const due = s.nextRunAt ? new Date(s.nextRunAt) : now;
      const late = !manual && now.getTime() - due.getTime() > LATE_MS ? `, due ${stamp(due, s.timezone)}: Atlas was not running then` : '';
      const why = `from schedule ${s.id}, ${describeWhen(s)}${manual ? ', run by hand' : ''}${late}.`;
      const by = 'schedule:' + s.id;
      let card: Card;
      if (s.createCard) {
        card = this.kanban.create(
          { title: `${s.title} · ${stamp(now, s.timezone, true)}`.slice(0, 200), body: `${s.prompt}\n\n— ${why}`, assignee: s.agentId, status: 'ready' },
          by,
        );
      } else {
        card = this.ownCard(s, by);
        if (card.assignee !== s.agentId) card = this.kanban.update(card.id, { assignee: s.agentId }, by);
        this.kanban.appendMessage(card.id, 'user', 'schedule', [{ type: 'text', text: `${s.prompt}\n\n— ${why}` }]);
        // Reopen a finished card. Running: the agent reads it at its next turn. Blocked or in review: it waits for Can.
        if (card.status === 'done' || card.status === 'todo') this.kanban.update(card.id, { status: 'ready' }, by);
      }
      this.db
        .prepare('UPDATE schedules SET last_card_id = ?, chat_card_id = ?, last_error = NULL, updated_at = ? WHERE id = ?')
        .run(card.id, s.createCard ? s.chatCardId : card.id, iso, s.id);
      return card.id;
    })();
    if (cardId) this.emit(s.id);
    return cardId;
  }

  /** The schedule's own card, created on first use (again if Can deleted or archived it). */
  private ownCard(s: Schedule, by: string): Card {
    if (s.chatCardId) {
      const row = this.db.prepare("SELECT 1 FROM cards WHERE id = ? AND status != 'archived'").get(s.chatCardId);
      if (row) return this.kanban.get(s.chatCardId);
    }
    return this.kanban.create(
      {
        title: s.title,
        body: `The card of schedule ${s.id} (${describeWhen(s)}). Each run posts the prompt in this chat and reopens the card, so the conversation keeps what earlier runs did.`,
        assignee: s.agentId,
        status: 'todo',
      },
      by,
    );
  }

  private firstRun(w: When): string {
    const [next] = upcoming(w, this.now());
    if (!next) throw new InvalidError(`${w.at} is in the past: pick a later time`);
    return next;
  }

  private checkAgent(id: string): void {
    if (!this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(id)) throw new ConflictError(`agent ${id} does not exist`);
  }

  private emit(id: string): Schedule {
    const schedule = this.get(id);
    this.bus.emit({ type: 'schedule.updated', schedule });
    return schedule;
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]!.trim();
  return line.length > 80 ? line.slice(0, 79) + '…' : line;
}

function safeNext(s: When, from: Date): string | null {
  try {
    return upcoming(s, from)[0] ?? null;
  } catch {
    return null; // the expression itself is broken: the schedule is disabled with the error shown on it
  }
}

/** "Mon 10 Nov, 09:00" in the schedule's zone (date only with `short`). */
function stamp(d: Date, timeZone: string, short = false): string {
  return d.toLocaleString('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(short ? {} : { hour: '2-digit', minute: '2-digit' }),
  });
}
