import type { Db } from './store/db.ts';

/**
 * Task and pull request events for workflows (#258, design §9). Written into `workflow_events` by the code that makes
 * the change, inside its transaction (rule 2), and consumed by Workflows.tick, which deletes each event in the same
 * transaction as the runs it started: an event fires its workflows exactly once, whatever the instant of a kill.
 * Nothing is written while no enabled workflow listens to that kind of event, so the table stays empty when unused.
 */

export type EventSource = 'task' | 'pr';

/** The task's state when the event happened (what filters look at), plus what the event says. */
export interface EventData {
  by: string | null;
  from: string | null;
  to: string | null;
  status: string;
  assignee: string | null;
  /** blocked: the reason; review_requested: the handoff. */
  text?: string | null;
  /** PR events: the PR as read then. */
  pr?: PrSnapshot;
  /** ci_finished / validated: success or failure. */
  result?: string | null;
}
export interface PrSnapshot {
  url: string;
  repo: string;
  number: number;
  branch: string | null;
  base: string | null;
  head: string | null;
  state: string;
  ci: string | null;
}

export function listening(db: Db, source: EventSource): boolean {
  return !!db
    .prepare("SELECT 1 FROM workflows w JOIN workflow_nodes n ON n.workflow_id = w.id AND n.kind = 'trigger' WHERE w.enabled = 1 AND json_extract(n.config, '$.kind') = ? LIMIT 1")
    .get(source);
}

interface CardState {
  status: string;
  assignee: string | null;
  project_id: string;
  board: string;
}
const cardState = (db: Db, cardId: string) => db.prepare('SELECT status, assignee, project_id, board FROM cards WHERE id = ?').get(cardId) as CardState | undefined;

function insert(db: Db, source: EventSource, name: string, cardId: string, project: string, prUrl: string | null, data: EventData): void {
  db.prepare('INSERT INTO workflow_events (at, source, name, card_id, project_id, pr_url, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    new Date().toISOString(),
    source,
    name,
    cardId,
    project,
    prUrl,
    JSON.stringify(data),
  );
}

/**
 * A card event (card_events kind and payload, as Kanban writes it) as the task events it means: `status` →
 * status_changed (and done, blocked); `blocked` → blocked and status_changed when it was not blocked already; `edited`
 * of the assignee → assignee_changed; `created`; `review_requested`. Direct chats have none.
 */
export function recordTaskEvent(db: Db, cardId: string, kind: string, payload: unknown): void {
  const p = (payload ?? {}) as { by?: string; from?: string; to?: string; fields?: string[]; reason?: string; summary?: string };
  const names: string[] = [];
  let to = p.to ?? null;
  if (kind === 'created') names.push('created');
  else if (kind === 'status' && p.from !== p.to) {
    names.push('status_changed');
    if (p.to === 'done') names.push('done');
    if (p.to === 'blocked') names.push('blocked');
  } else if (kind === 'blocked' && p.from !== 'blocked') {
    to = 'blocked';
    names.push('status_changed', 'blocked');
  } else if (kind === 'edited' && p.fields?.includes('assignee')) names.push('assignee_changed');
  else if (kind === 'review_requested') names.push('review_requested');
  if (!names.length || !listening(db, 'task')) return;
  const c = cardState(db, cardId);
  if (!c || c.board !== 'main') return;
  const text = kind === 'blocked' ? (p.reason ?? null) : kind === 'review_requested' ? (p.summary ?? null) : null;
  for (const name of names)
    insert(db, 'task', name, cardId, c.project_id, null, { by: p.by ?? null, from: p.from ?? null, to, status: c.status, assignee: c.assignee, text });
}

/** A PR event of a task's linked PR (inside the transaction that stored what GitHub said). */
export function recordPrEvent(db: Db, cardId: string, name: string, pr: PrSnapshot, extra: { result?: string | null; by?: string | null } = {}): void {
  if (!listening(db, 'pr')) return;
  const c = cardState(db, cardId);
  if (!c) return;
  insert(db, 'pr', name, cardId, c.project_id, pr.url, { by: extra.by ?? 'github', from: null, to: null, status: c.status, assignee: c.assignee, pr, result: extra.result ?? null });
}
