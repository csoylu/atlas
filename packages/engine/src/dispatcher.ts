import { cardRef, type Card, type Run } from '@atlas/shared';
import type { Bus } from './events.ts';
import type { Kanban } from './kanban.ts';
import type { Agents } from './agents.ts';
import type { Models } from './models.ts';
import type { Settings } from './settings.ts';
import type { RunEnd, Runner } from './runner.ts';
import { ModelError } from './providers/types.ts';
import { REWOUND } from './rewind.ts';
import { stopNote } from './loopGuard.ts';
import type { Stalls } from './stalls.ts';

import { TRIAGE_KICK, WORK_KICK } from '@atlas/shared';
export { TRIAGE_KICK, WORK_KICK };
const TRANSIENT_RETRY_MS = 60_000;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The note that wakes a project's lead in a task whose assignee the loop guard or the ceiling stopped (#239). */
export const leadKick = (c: Card, run: Run, before: number) =>
  `${stopNote(`@${run.agentId}'s run on this task: ${run.limit}`)} You are the project lead: decide what happens next` +
  (before ? ` (the guard has stopped work on this task ${before} time${before > 1 ? 's' : ''} before).` : '.');

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
  /**
   * Why the last try to start or move a card failed (#327): an error thrown on it, or a run that did not start. Shown
   * as its reason and turned into a stall; cleared when the card starts or leaves Ready.
   */
  private failures = new Map<string, { status: Card['status']; why: string }>();
  /** The last tick's error, if it failed outside any one card: every ready task says so instead of « starting… ». */
  private tickError: string | null = null;
  /** Set by the PR watcher (#189): why a task In review isn't moving, and Retry on one. */
  reviewReason: (c: Card) => string | null = () => 'in review';
  recheck: (cardId: string) => void = () => {};
  /** Stuck tasks (#237), looked at on this tick; omitted in tests that don't need them. */
  stalls: Stalls | null = null;

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
      // An unlocked secret store (#208) can make a model usable again.
      if (e.type === 'card.updated' || e.type === 'run.updated' || e.type === 'secrets.status') this.soon();
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
      // Each card on its own (#327): an error on one task is shown on it and never stops the others from moving.
      for (const c of this.kanban.list())
        this.guard(c, () => {
          // A temporary failure waits in todo until its time (#131); a block of kind transient from before #131 too.
          const retryAt = c.retry?.at ?? (c.status === 'blocked' && c.block?.kind === 'transient' ? c.block.until : null);
          if (retryAt) {
            if (retryAt <= now && (c.status === 'blocked' || this.kanban.openParents(c).length === 0)) this.kanban.update(c.id, { status: 'ready' }, 'dispatcher');
          } else if (c.status === 'todo' && c.parents.length && this.kanban.openParents(c).length === 0) {
            this.kanban.update(c.id, { status: 'ready' }, 'dispatcher');
            // Back from waiting on other tasks (#131): tell the agent they are done, so it picks up where it stopped.
            if (this.runner.runs(c.id).some((r) => r.kind === 'work'))
              this.kanban.appendMessage(c.id, 'user', 'system', [{ type: 'text', text: `The tasks this one waited on are done (${c.parents.map((p) => this.kanban.ref(p)).join(', ')}). Continue where you left off.` }]);
          }
        });
      for (const c of this.kanban.list())
        this.guard(c, () => {
          // A project's new tasks go to its lead (#213).
          const triageAgent = c.status === 'triage' ? this.kanban.leadOf(c.projectId) : null;
          if (c.status !== 'triage' || !triageAgent || this.runner.current(c.id)) return;
          if (this.agentUsable(triageAgent) || this.failedSinceCanWrote(c.id)) return;
          const fresh = this.runner.runs(c.id).length === 0;
          if (fresh || this.runner.owesReply(c.id))
            this.runner.wake(c.id, { agentId: triageAgent, kind: 'triage', kick: fresh ? TRIAGE_KICK : undefined });
        });
      for (const c of this.kanban.list()) {
        if (this.failures.get(c.id)?.status !== c.status) this.failures.delete(c.id);
        if (c.status !== 'ready') continue;
        this.guard(c, () => {
          if (this.startProblem(c)) {
            this.failures.delete(c.id);
            return;
          }
          if (this.runner.current(c.id)) return; // a chat reply is in progress; start after it
          this.startWork(c);
        });
      }
      // A closed card does nothing more: stop its work or triage run (a chat about it may go on).
      for (const c of this.kanban.list())
        this.guard(c, () => {
          const cur = c.status === 'closed' ? this.runner.current(c.id) : null;
          if (cur && cur.kind !== 'chat') this.runner.stop(c.id, 'task closed');
        });
      this.deliverAgentMessages();
      this.tickError = null;
    } catch (e) {
      this.tickError = errText(e);
      console.error('dispatcher tick failed', e);
    } finally {
      try {
        // Even after a failed tick: a task that can't move is marked stuck (#237), never left quiet.
        this.stalls?.maybeCheck();
        // Refresh « why not moving » in the UI when it changed.
        for (const c of this.kanban.list()) {
          if (this.lastWaiting.get(c.id) !== c.waiting) {
            this.lastWaiting.set(c.id, c.waiting);
            this.kanban.emit(c.id);
          }
        }
      } catch (e) {
        console.error('dispatcher tick failed', e);
      }
      this.ticking = false;
    }
  }

  /** Run one card's step of the tick: an error is logged and kept as the card's failure, the tick goes on. */
  private guard(c: Card, fn: () => unknown): void {
    try {
      fn();
    } catch (e) {
      const why = errText(e);
      if (this.failures.get(c.id)?.why !== why) console.error(`dispatcher: ${this.kanban.ref(c.id)} (${c.status}) failed:`, e);
      this.failures.set(c.id, { status: c.status, why });
    }
  }

  /**
   * Start the work run of a ready task (status Running). A run that can't start leaves the task in Ready with the
   * reason (#327), without flipping its status on every tick (that reset its time in Ready, so it never showed as stuck).
   */
  private startWork(c: Card, kick: string | undefined = WORK_KICK): string | null {
    const refused = this.runner.refusal(c.id);
    if (refused) {
      this.failures.set(c.id, { status: 'ready', why: refused });
      return null;
    }
    this.kanban.update(c.id, { status: 'running' }, 'dispatcher');
    let id: string | null;
    try {
      id = this.runner.wake(c.id, { kind: 'work', kick });
    } catch (e) {
      // Never Running with no run on it: back to Ready, the error becomes its reason (guard).
      this.kanban.update(c.id, { status: 'ready' }, 'dispatcher');
      throw e;
    }
    if (id) {
      this.failures.delete(c.id);
      return id;
    }
    this.kanban.update(c.id, { status: 'ready' }, 'dispatcher');
    this.failures.set(c.id, { status: 'ready', why: this.runner.refusal(c.id) ?? 'the work run did not start' });
    return null;
  }

  /** Why a startable ready task did not start (#327), or null: it starts on the next tick. Stalls turn it into an Inbox item. */
  notStarting(c: Card): string | null {
    if (this.stopped) return 'the dispatcher is stopped (Atlas is stopping): no task starts until Atlas restarts';
    const failed = this.failures.get(c.id);
    if (failed?.status === c.status) return `could not start: ${failed.why}`;
    if (this.tickError) return `the dispatcher fails: ${this.tickError}`;
    return null;
  }

  /**
   * agent_message (#96), from the outbox, so a restart loses nothing: wake the target until a run of it has seen the
   * message and ended; post its last text in the sender's conversation (or why it couldn't answer); then wake the sender
   * until it has read that. One hop: the answer is a system note, never forwarded again.
   */
  private deliverAgentMessages(): void {
    for (const m of this.kanban.pendingAgentMessages()) {
      if (m.repliedAt) {
        // The sender's side: read once one of its replies had the answer in view (or it can't any more).
        if (this.nudge(m.fromCard, m.from, m.replySeq ?? 0, m.repliedAt, `The answer from @${m.to} is above.`).state !== 'busy')
          this.kanban.agentReplyDelivered(m.id);
        continue;
      }
      const t = this.nudge(m.toCard, m.to, m.seq, m.at, `Unread message from @${m.from} above: answer it.`);
      if (t.state === 'busy') continue;
      this.kanban.replyAgentMessage(
        m.id,
        t.state === 'gone'
          ? `@${m.to} could not answer: the conversation your message went to was deleted.`
          : t.state === 'failed'
            ? `@${m.to} could not answer: ${t.text}.`
            : `reply from @${m.to}: ${t.text ?? '(it answered without any text)'}`,
      );
      // Wake the sender now; a later tick marks the answer read.
      this.nudge(m.fromCard, m.from, Number.MAX_SAFE_INTEGER, new Date().toISOString(), '');
    }
  }

  /**
   * Get `agentId` to answer the message at `seq` on a card: 'busy' while a run is on it or it is woken now (`kick` if
   * nothing else is owed); 'answered' once it wrote a reply with the message in view and owes nothing; 'failed' if a run
   * since `since` failed or was stopped; 'gone' if the card was deleted.
   */
  private nudge(cardId: string, agentId: string, seq: number, since: string, kick: string): { state: 'busy' | 'answered' | 'failed' | 'gone'; text: string | null } {
    const answer = this.kanban.answerTo(cardId, agentId, seq);
    if (!answer) return { state: 'gone', text: null };
    if (this.runner.current(cardId)) return { state: 'busy', text: null };
    const last = this.runner.runs(cardId)[0];
    if (last && last.startedAt >= since && (last.status === 'failed' || last.status === 'stopped'))
      return { state: 'failed', text: `its run ${last.status}${last.error ? `: ${last.error}` : ''}` };
    if (answer.seen && !this.runner.owesReply(cardId)) return { state: 'answered', text: answer.text };
    const c = this.kanban.get(cardId);
    this.answerOn(c, answer.seen || !kick ? undefined : kick);
    return { state: 'busy', text: null };
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
    // In review (#189) waits for QA: writing there is a chat with the builder, the task stays in review.
    if (c.status === 'blocked') this.kanban.update(c.id, { status: 'ready' }, 'user');
    else if (c.status === 'triage') this.soon();
    else this.runner.wake(c.id, { kind: c.status === 'running' ? 'work' : 'chat' });
  }

  private afterRun({ run, terminal, transient, retryAt }: RunEnd): void {
    const c = this.kanban.get(run.cardId);
    if (run.status === 'interrupted') return; // resumes by itself (design §6)
    if (run.status === 'stopped' && run.error === REWOUND) return; // the rewind sets the card's status itself
    if (c.status === 'running' && run.kind === 'work' && !terminal && run.status === 'done' && this.routeStop(c, run)) return this.soon();
    if (c.status === 'running' && run.kind !== 'triage' && !terminal) {
      if (run.status === 'failed' && transient)
        // Every plan subscription paused: wait for the earliest reset, else retry in a minute.
        this.kanban.block(c.id, { kind: 'transient', reason: run.error ?? 'temporary failure', until: retryAt ?? new Date(Date.now() + TRANSIENT_RETRY_MS).toISOString() }, 'dispatcher');
      else if (run.status === 'failed') this.kanban.block(c.id, { kind: 'capability', reason: run.error ?? 'the run failed' }, 'dispatcher');
      else if (run.status === 'stopped')
        this.kanban.block(c.id, { kind: 'needs_input', reason: 'Stopped by you. Write what to do next.', stopped: true }, 'user');
      else if (run.limit) this.kanban.block(c.id, { kind: 'needs_input', reason: `${stopNote(run.limit)} Write what to do next: a reply resumes the task.` }, 'dispatcher');
      else this.kanban.block(c.id, { kind: 'needs_input', reason: this.lastText(c.id) ?? 'The agent stopped without finishing. What next?' }, 'dispatcher');
    }
    // A failed triage leaves the card in triage (no block): the Inbox still says so, with Retry.
    if (run.kind === 'triage' && run.status === 'failed' && !transient && c.board === 'main')
      this.kanban.notifyNow({ kind: 'run.failed', title: c.title, body: `Triage failed: ${run.error ?? 'the run failed'}`, cardId: c.id });
    this.soon();
  }

  /**
   * A work run on a running task ended without a terminal tool (#239). The loop guard or the ceiling stopped the
   * assignee: its project's lead is woken in the thread (it continues, re-scopes or blocks for Master). The lead's run
   * there ended without blocking or moving the task: the assignee goes on with what the lead wrote. True if handled;
   * false = the usual path (a stopped lead, or no lead, reaches Master as a block).
   */
  private routeStop(c: Card, run: Run): boolean {
    const lead = this.kanban.leadOf(c.projectId);
    if (run.limit) {
      if (!lead || lead === run.agentId || run.agentId !== c.assignee) return false;
      const before = this.kanban.eventCount(c.id, 'run_limited');
      this.kanban.event(c.id, 'run_limited', { by: run.agentId, runId: run.id, reason: run.limit, to: lead });
      this.after(c.id, () => this.runner.wake(c.id, { agentId: lead, kind: 'work', kickAlways: true, kick: leadKick(c, run, before) }));
      return true;
    }
    if (run.agentId === c.assignee || run.agentId !== lead || !c.assignee) return false;
    this.after(c.id, () => this.runner.wake(c.id, { kind: 'work', kickAlways: true, kick: `@${lead} (project lead) answered above: continue the task with that.` }));
    return true;
  }

  /** Once the run that is ending has let go of the card (afterRun is called from inside it). */
  private after(cardId: string, fn: () => void): void {
    void this.runner.settled(cardId).then(() => {
      // The task moved meanwhile (Master closed or blocked it): nothing to start.
      if (this.kanban.get(cardId).status === 'running') fn();
    }).catch((e: unknown) => console.error(`after the run on ${cardId}`, e));
  }

  /** The last run failed and the user hasn't written or pressed Retry since: retrying would fail the same way. */
  private failedSinceCanWrote(cardId: string): string | null {
    const last = this.runner.runs(cardId)[0];
    if (last?.status !== 'failed') return null;
    const wrote = this.kanban.messages(cardId).some((m) => m.author === 'user' && m.at > last.startedAt);
    return wrote || this.kanban.lastEventAt(cardId, 'retry') > last.startedAt ? null : (last.error ?? 'the last run failed');
  }

  /**
   * Another agent wrote on this card: its agent replies (or reads it at the next turn). On a ready task it can start,
   * the message starts the work (#327): a chat reply would do the task while the card stays in Ready.
   */
  onAgentMessage(cardId: string): void {
    const c = this.kanban.get(cardId);
    if (c.status === 'triage') this.soon();
    else this.answerOn(c);
  }

  /** Wake the card's agent to answer: the work run on a running task, or on a ready one it can start now; else a chat run. */
  private answerOn(c: Card, kick?: string): void {
    if (c.status === 'ready' && !this.runner.current(c.id) && !this.startProblem(c)) {
      this.guard(c, () => this.startWork(c, kick));
      return;
    }
    this.runner.wake(c.id, { kind: c.status === 'running' ? 'work' : 'chat', ...(kick ? { kick } : {}) });
  }

  /** The model of the agent that would act on this card, if it is marked failed. */
  private failedModelFor(cardId: string): string | null {
    const c = this.kanban.get(cardId);
    const agentId = c.status === 'triage' ? this.kanban.leadOf(c.projectId) : c.assignee;
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
    if (c.status === 'blocked' || c.retry) this.kanban.update(c.id, { status: 'ready' }, 'user');
    // Working with no run on it (#237 « Restart the run »): back to Ready, the next tick starts a fresh work run.
    else if (c.status === 'running' && !this.runner.current(c.id)) this.kanban.update(c.id, { status: 'ready' }, 'user');
    else if (c.status === 'review') this.recheck(c.id);
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
  startProblem(c: Card): string | null {
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
        const t = this.kanban.leadOf(c.projectId);
        if (!t) return 'no triage agent set: choose the project lead';
        if (this.runner.current(c.id)) return null;
        const bad = this.agentUsable(t);
        if (bad) return bad;
        const failed = this.failedSinceCanWrote(c.id);
        if (failed) return `triage failed: ${failed}. Write here or press Retry.`;
        return this.runner.runs(c.id).length ? 'waiting for your answer' : 'triage starting…';
      }
      case 'todo': {
        const open = this.kanban.openParents(c);
        if (c.retry && !open.length) return `retrying at ${hhmm(c.retry.at)}` + (c.retry.reason ? ` · ${c.retry.reason.split('\n')[0]}` : '');
        const closed = open.filter((p) => p.status === 'closed');
        if (closed.length)
          return `parent ${closed.map(cardRef).join(', ')} was closed (cancelled), so this task can't start: remove it from the parents, reopen it, or close this task too`;
        if (open.length) return 'waiting on ' + open.map((p) => `${cardRef(p)} (${p.status})`).join(', ');
        const failed = this.failures.get(c.id);
        if (failed?.status === 'todo') return `could not move to ready: ${failed.why}`;
        return c.parents.length ? 'parents done, moving to ready…' : 'parked: move it to ready when it is time';
      }
      case 'ready': {
        const cur = this.runner.current(c.id);
        if (cur) return cur.kind === 'triage' ? 'finishing triage' : 'answering you first';
        return this.startProblem(c) ?? this.notStarting(c) ?? 'starting…';
      }
      case 'blocked':
        return c.block?.kind === 'transient' && c.block.until ? `retrying at ${hhmm(c.block.until)}` : null;
      case 'review':
        return this.reviewReason(c);
      default:
        return null;
    }
  }
}
