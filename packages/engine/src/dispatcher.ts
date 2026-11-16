import { cardRef, type Card } from '@atlas/shared';
import type { Bus } from './events.ts';
import type { Kanban } from './kanban.ts';
import type { Agents } from './agents.ts';
import type { Models } from './models.ts';
import type { Settings } from './settings.ts';
import type { RunEnd, Runner } from './runner.ts';
import { ModelError } from './providers/types.ts';
import { REWOUND } from './rewind.ts';

import { TRIAGE_KICK, WORK_KICK } from '@atlas/shared';
export { TRIAGE_KICK, WORK_KICK };
const TRANSIENT_RETRY_MS = 60_000;

/** 16:40 today, « Mon 09:00 » further out (a plan's weekly reset). */
const hhmm = (iso: string) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.getTime() - Date.now() > 20 * 3600_000 ? `${d.toLocaleDateString([], { weekday: 'short' })} ${time}` : time;
};

/**
 * Moves cards along the board (design §7): promotes todo → ready when parents are done, starts ready cards when the
 * assignee has a free slot, hands triage cards to the triage agent, retries transient blocks, and turns the end of a
 * run into the right card status. Every « not starting » reason is computed from the tables (no hidden guards).
 */
export class Dispatcher {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private pending = false;
  private ticking = false;
  private lastWaiting = new Map<string, string | null>();

  constructor(
    private bus: Bus,
    private kanban: Kanban,
    private agents: Agents,
    private models: Models,
    private settings: Settings,
    private runner: Runner,
  ) {
    kanban.waitingReason = (c) => this.reason(c);
    runner.onRunEnd = (e) => this.afterRun(e);
    runner.deliver = (id) => this.onAgentMessage(id);
  }

  private unsubscribe: (() => void) | undefined;

  start(intervalMs = 1000): void {
    this.stop();
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
    this.unsubscribe = this.bus.on((e) => {
      if (e.type === 'card.updated' || e.type === 'run.updated') this.soon();
    });
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Coalesce bursts of events into one tick. */
  private soon(): void {
    if (this.pending || this.stopped) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      this.tick();
    });
  }

  tick(): void {
    if (this.ticking || this.stopped) return; // tick emits events, which schedule another tick: never re-enter
    this.ticking = true;
    try {
      const now = new Date().toISOString();
      for (const c of this.kanban.list()) {
        if (c.status === 'blocked' && c.block?.kind === 'transient' && c.block.until && c.block.until <= now)
          this.kanban.update(c.id, { status: 'ready' }, 'dispatcher');
        else if (c.status === 'todo' && c.parents.length && this.kanban.openParents(c).length === 0)
          this.kanban.update(c.id, { status: 'ready' }, 'dispatcher');
      }
      const triageAgent = this.settings.get().triageAgent;
      for (const c of this.kanban.list()) {
        if (c.status !== 'triage' || !triageAgent || this.runner.current(c.id)) continue;
        if (this.agentUsable(triageAgent) || this.failedSinceCanWrote(c.id)) continue;
        const fresh = this.runner.runs(c.id).length === 0;
        if (fresh || this.runner.owesReply(c.id))
          this.runner.wake(c.id, { agentId: triageAgent, kind: 'triage', kick: fresh ? TRIAGE_KICK : undefined });
      }
      for (const c of this.kanban.list()) {
        if (c.status !== 'ready' || this.startProblem(c)) continue;
        if (this.runner.current(c.id)) continue; // a chat reply is in progress; start after it
        this.kanban.update(c.id, { status: 'running' }, 'dispatcher');
        if (!this.runner.wake(c.id, { kind: 'work', kick: WORK_KICK })) this.kanban.update(c.id, { status: 'ready' }, 'dispatcher');
      }
      // A closed card does nothing more: stop its work or triage run (a chat about it may go on).
      for (const c of this.kanban.list()) {
        const cur = c.status === 'closed' ? this.runner.current(c.id) : null;
        if (cur && cur.kind !== 'chat') this.runner.stop(c.id, 'card closed');
      }
      this.deliverReports();
      // Refresh « why not moving » in the UI when it changed.
      for (const c of this.kanban.list()) {
        if (this.lastWaiting.get(c.id) !== c.waiting) {
          this.lastWaiting.set(c.id, c.waiting);
          this.kanban.emit(c.id);
        }
      }
    } catch (e) {
      console.error('dispatcher tick failed', e);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Report-back (design §16): a card created from a chat changed state and a system message was posted in that chat.
   * Start a chat run so the agent tells the user in its own words. A report is delivered once its chat no longer owes a
   * reply; while a run is going on, it reads the message at its next turn (or the next tick wakes the chat again).
   */
  private deliverReports(): void {
    for (const r of this.kanban.pendingReports()) {
      if (this.runner.current(r.chatId)) continue;
      // A run since the report that ended (answered, failed or stopped by the user) settles it: no retry loop.
      const last = this.runner.runs(r.chatId)[0];
      const ranSince = last && last.startedAt >= r.at && last.status !== 'interrupted';
      if (ranSince || !this.runner.owesReply(r.chatId)) this.kanban.reportDelivered(r.id);
      else {
        const chat = this.kanban.get(r.chatId);
        if (chat.assignee && !this.agentUsable(chat.assignee, chat.modelId)) this.runner.wake(r.chatId, { kind: 'chat' });
      }
    }
  }

  /** The user wrote on a card: answering a block or a review puts it back to work; otherwise the agent replies in chat. */
  onUserMessage(cardId: string): void {
    // Writing is also a retry: re-test a model marked failed first.
    if (this.failedModelFor(cardId)) {
      void this.retestFor(cardId).then(() => this.onUserMessage2(cardId), (e: unknown) => console.error('retest failed', e));
      return;
    }
    this.onUserMessage2(cardId);
  }

  private onUserMessage2(cardId: string): void {
    const c = this.kanban.get(cardId);
    if (c.status === 'blocked' || c.status === 'review') this.kanban.update(c.id, { status: 'ready' }, 'user');
    else if (c.status === 'triage') this.soon();
    else this.runner.wake(c.id, { kind: c.status === 'running' ? 'work' : 'chat' });
  }

  private afterRun({ run, terminal, transient, retryAt }: RunEnd): void {
    const c = this.kanban.get(run.cardId);
    if (run.status === 'interrupted') return; // resumes by itself (design §6)
    if (run.status === 'stopped' && run.error === REWOUND) return; // the rewind sets the card's status itself
    if (c.status === 'running' && run.kind !== 'triage' && !terminal) {
      if (run.status === 'failed' && transient)
        // Every plan subscription paused: wait for the earliest reset, else retry in a minute.
        this.kanban.block(c.id, { kind: 'transient', reason: run.error ?? 'temporary failure', until: retryAt ?? new Date(Date.now() + TRANSIENT_RETRY_MS).toISOString() }, 'dispatcher');
      else if (run.status === 'failed') this.kanban.block(c.id, { kind: 'capability', reason: run.error ?? 'the run failed' }, 'dispatcher');
      else if (run.status === 'stopped')
        this.kanban.block(c.id, { kind: 'needs_input', reason: 'Stopped by you. Write what to do next.', stopped: true }, 'user');
      else this.kanban.block(c.id, { kind: 'needs_input', reason: this.lastText(c.id) ?? 'The agent stopped without finishing. What next?' }, 'dispatcher');
    }
    // A failed triage leaves the card in triage (no block): the Inbox still says so, with Retry.
    if (run.kind === 'triage' && run.status === 'failed' && !transient && c.board === 'main')
      this.kanban.notifyNow({ kind: 'run.failed', title: c.title, body: `Triage failed: ${run.error ?? 'the run failed'}`, cardId: c.id });
    this.soon();
  }

  /** The last run failed and the user hasn't written or pressed Retry since: retrying would fail the same way. */
  private failedSinceCanWrote(cardId: string): string | null {
    const last = this.runner.runs(cardId)[0];
    if (last?.status !== 'failed') return null;
    const wrote = this.kanban.messages(cardId).some((m) => m.author === 'user' && m.at > last.startedAt);
    return wrote || this.kanban.lastEventAt(cardId, 'retry') > last.startedAt ? null : (last.error ?? 'the last run failed');
  }

  /** Another agent wrote on this card: its agent replies (or reads it at the next turn); no status change. */
  onAgentMessage(cardId: string): void {
    const c = this.kanban.get(cardId);
    if (c.status === 'triage') this.soon();
    else this.runner.wake(c.id, { kind: c.status === 'running' ? 'work' : 'chat' });
  }

  /** The model of the agent that would act on this card, if it is marked failed. */
  private failedModelFor(cardId: string): string | null {
    const c = this.kanban.get(cardId);
    const agentId = c.status === 'triage' ? this.settings.get().triageAgent : c.assignee;
    const own = c.status === 'triage' ? null : c.modelId;
    const modelId = own ?? (agentId ? this.agents.list().find((a) => a.id === agentId)?.modelId : undefined);
    return modelId && this.models.list().find((m) => m.id === modelId)?.lastError ? modelId : null;
  }

  /** Re-test a failed model (clears the mark if it answers). Returns false if it still fails. */
  private async retestFor(cardId: string): Promise<boolean> {
    const modelId = this.failedModelFor(cardId);
    if (!modelId) return true;
    const ok = (await this.models.test(modelId)).ok;
    this.kanban.emit(cardId);
    return ok;
  }

  /** The user pressed Retry: re-test the agent's model if it was marked failed, then retry the card. */
  async retry(cardId: string): Promise<void> {
    if (!(await this.retestFor(cardId))) return;
    const c = this.kanban.get(cardId);
    this.kanban.event(c.id, 'retry', { by: 'user' });
    if (c.status === 'blocked') this.kanban.update(c.id, { status: 'ready' }, 'user');
    else {
      this.kanban.emit(c.id);
      // A chat reply that failed (Retry on the chat's « Run failed » row): the agent answers again.
      if (c.status !== 'triage' && c.status !== 'ready' && this.runner.owesReply(c.id)) this.runner.wake(c.id, { kind: c.status === 'running' ? 'work' : 'chat' });
    }
    this.soon();
  }

  /** The agent's whole last message: it becomes the question (shown in full in the ticket, clamped only on board tiles). */
  private lastText(cardId: string): string | null {
    const last = this.kanban.messages(cardId).filter((m) => m.role === 'assistant').at(-1);
    const text = last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    return text || null;
  }

  /** `modelId`: the card's own model, when it has one (else the agent's). */
  private agentUsable(id: string, modelId?: string | null): string | null {
    const agent = this.agents.list().find((a) => a.id === id);
    if (!agent) return `agent @${id} does not exist`;
    if (!agent.enabled) return `@${id} is disabled`;
    try {
      this.models.provider(modelId ?? agent.modelId);
    } catch (e) {
      return e instanceof ModelError ? e.message : String(e);
    }
    const model = this.models.get(modelId ?? agent.modelId);
    if (model.lastError) return `model ${model.id} failed: ${model.lastError}. Fix it, then Retry (it re-tests the model)`;
    return null;
  }

  /** Why a ready card can't start now, or null if it can. */
  private startProblem(c: Card): string | null {
    if (!c.assignee) return 'no assignee: pick an agent';
    const bad = this.agentUsable(c.assignee, c.modelId);
    if (bad) return bad;
    const agent = this.agents.get(c.assignee);
    const busy = this.runner.workRuns(agent.id);
    if (busy.length >= agent.maxRuns) return `@${agent.id} is busy with ${busy.map((r) => this.kanban.ref(r.cardId)).join(', ')}`;
    return null;
  }

  /** The plain-words « why isn't this moving » shown on the card. */
  reason(c: Card): string | null {
    switch (c.status) {
      case 'triage': {
        const t = this.settings.get().triageAgent;
        if (!t) return 'no triage agent set';
        if (this.runner.current(c.id)) return null;
        const bad = this.agentUsable(t);
        if (bad) return bad;
        const failed = this.failedSinceCanWrote(c.id);
        if (failed) return `triage failed: ${failed}. Write here or press Retry.`;
        return this.runner.runs(c.id).length ? 'waiting for your answer' : 'triage starting…';
      }
      case 'todo': {
        const open = this.kanban.openParents(c);
        const closed = open.filter((p) => p.status === 'closed');
        if (closed.length)
          return `parent ${closed.map(cardRef).join(', ')} was closed (cancelled), so this card can't start: remove it from the parents, reopen it, or close this card too`;
        if (open.length) return 'waiting on ' + open.map((p) => `${cardRef(p)} (${p.status})`).join(', ');
        return c.parents.length ? 'parents done, moving to ready…' : 'parked: move it to ready when it is time';
      }
      case 'ready': {
        const cur = this.runner.current(c.id);
        if (cur) return cur.kind === 'triage' ? 'finishing triage' : 'answering you first';
        return this.startProblem(c) ?? 'starting…';
      }
      case 'blocked':
        return c.block?.kind === 'transient' && c.block.until ? `retrying at ${hhmm(c.block.until)}` : null;
      case 'review':
        return 'waiting for your review';
      default:
        return null;
    }
  }
}
