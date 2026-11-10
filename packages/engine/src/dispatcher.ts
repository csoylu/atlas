import type { Card } from '@atlas/shared';
import type { Bus } from './events.ts';
import type { Kanban } from './kanban.ts';
import type { Agents } from './agents.ts';
import type { Models } from './models.ts';
import type { Settings } from './settings.ts';
import type { RunEnd, Runner } from './runner.ts';
import { ModelError } from './providers/types.ts';

export const TRIAGE_KICK = 'New card in triage. Triage it.';
export const WORK_KICK = 'This card is ready and assigned to you. Do it.';
const TRANSIENT_RETRY_MS = 60_000;

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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

  /** Can wrote on a card: answering a block or a review puts it back to work; otherwise the agent replies in chat. */
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
    if (c.status === 'blocked' || c.status === 'review') this.kanban.update(c.id, { status: 'ready' }, 'can');
    else if (c.status === 'triage') this.soon();
    else this.runner.wake(c.id, { kind: c.status === 'running' ? 'work' : 'chat' });
  }

  private afterRun({ run, terminal, transient }: RunEnd): void {
    const c = this.kanban.get(run.cardId);
    if (run.status === 'interrupted') return; // resumes by itself (design §6)
    if (c.status === 'running' && run.kind !== 'triage' && !terminal) {
      if (run.status === 'failed' && transient)
        this.kanban.block(c.id, { kind: 'transient', reason: run.error ?? 'temporary failure', until: new Date(Date.now() + TRANSIENT_RETRY_MS).toISOString() }, 'dispatcher');
      else if (run.status === 'failed') this.kanban.block(c.id, { kind: 'capability', reason: run.error ?? 'the run failed' }, 'dispatcher');
      else if (run.status === 'stopped') this.kanban.block(c.id, { kind: 'needs_input', reason: 'Stopped by Can. Write what to do next.' }, 'dispatcher');
      else this.kanban.block(c.id, { kind: 'needs_input', reason: this.lastText(c.id) ?? 'The agent stopped without finishing. What next?' }, 'dispatcher');
    }
    this.soon();
  }

  /** The last run failed and Can hasn't written or pressed Retry since: retrying would fail the same way. */
  private failedSinceCanWrote(cardId: string): string | null {
    const last = this.runner.runs(cardId)[0];
    if (last?.status !== 'failed') return null;
    const wrote = this.kanban.messages(cardId).some((m) => m.author === 'can' && m.at > last.startedAt);
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

  /** Can pressed Retry: re-test the agent's model if it was marked failed, then retry the card. */
  async retry(cardId: string): Promise<void> {
    if (!(await this.retestFor(cardId))) return;
    const c = this.kanban.get(cardId);
    this.kanban.event(c.id, 'retry', { by: 'can' });
    if (c.status === 'blocked') this.kanban.update(c.id, { status: 'ready' }, 'can');
    else this.kanban.emit(c.id);
    this.soon();
  }

  private lastText(cardId: string): string | null {
    const last = this.kanban.messages(cardId).filter((m) => m.role === 'assistant').at(-1);
    const text = last?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    return text ? (text.length > 600 ? text.slice(0, 597) + '…' : text) : null;
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
    if (busy.length >= agent.maxRuns) return `@${agent.id} is busy with ${busy.map((r) => r.cardId).join(', ')}`;
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
        if (open.length) return 'waiting on ' + open.map((p) => `${p.id} (${p.status})`).join(', ');
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
