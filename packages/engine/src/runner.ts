import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Agent, Card, ContentBlock, Model, Run, RunKind, RunStatus } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import type { Kanban } from './kanban.ts';
import type { Agents } from './agents.ts';
import type { Models } from './models.ts';
import type { Usage } from './usage.ts';
import { ModelError, type ModelRequest, type Provider, type ToolSpec } from './providers/types.ts';
import { buildMessages, COMPACT_AT, compactedView, degrade, estimateTokens, INTERRUPTED, needsTurn, pickCut, renderForSummary } from './context.ts';
import { runTool, toolSpecs } from './tools.ts';
import { cardToolSpecs, describeCard, isCardTool, runCardTool, type Terminal } from './cardTools.ts';
import { canvasToolSpecs, isCanvasTool, runCanvasTool } from './canvasTools.ts';
import { isTeamTool, runTeamTool, teamToolSpecs } from './teamTools.ts';
import { SHARED, type Memories } from './memory.ts';
import type { Canvases } from './canvas.ts';
import type { Schedules } from './schedules.ts';
import { workdirOf } from './agents.ts';

interface RunRow {
  id: string;
  card_id: string;
  agent_id: string;
  kind: RunKind;
  status: RunStatus;
  error: string | null;
  started_at: string;
  ended_at: string | null;
}
const toRun = (r: RunRow): Run => ({
  id: r.id,
  cardId: r.card_id,
  agentId: r.agent_id,
  kind: r.kind,
  status: r.status,
  error: r.error,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export interface RunnerOptions {
  dataDir: string;
  maxTurns?: number;
  /** Lease length; renewed every third of it (design §6: 60 s / 20 s). */
  leaseMs?: number;
  /** Token usage of every call (usage.ts); omitted in runner-only tests. */
  usage?: Usage;
}

export interface WakeOptions {
  /** Defaults to the card's assignee. */
  agentId?: string;
  kind?: RunKind;
  /** If the agent owes no reply, append this note (author 'system') so the transcript says why the run started. */
  kick?: string;
}

/** What the dispatcher needs to know when a run ends. */
export interface RunEnd {
  run: Run;
  terminal: Terminal;
  transient: boolean;
}

const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();

/** Runs an agent on a card's conversation until the agent owes no reply (design §4). One run per card at a time. */
export class Runner {
  private active = new Map<string, { runId: string; agentId: string; kind: RunKind; ctrl: AbortController; done: Promise<void> }>();
  private maxTurns: number;
  private leaseMs: number;
  /** This engine instance; owns the leases of the runs it executes. */
  readonly instance = 'e_' + randomUUID().slice(0, 8);
  private timers: NodeJS.Timeout[] = [];
  /** Set by the dispatcher. */
  onRunEnd: (end: RunEnd) => void = () => {};
  /** Set by the dispatcher: deliver a message an agent posted on another card. */
  deliver: (cardId: string) => void = (id) => void this.wake(id);

  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private agents: Agents,
    private models: Models,
    private canvases: Canvases,
    private memories: Memories,
    private schedules: Schedules,
    private opts: RunnerOptions,
  ) {
    this.maxTurns = opts.maxTurns ?? 60;
    this.leaseMs = opts.leaseMs ?? 60_000;
  }

  /** Begin lease renewal and periodic recovery of runs whose owner died. */
  start(): void {
    this.recover();
    this.timers.push(setInterval(() => this.renew(), this.leaseMs / 3).unref());
    this.timers.push(setInterval(() => this.recover(), this.leaseMs / 2).unref());
  }

  runs(cardId: string): Run[] {
    return (this.db.prepare('SELECT * FROM runs WHERE card_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 20').all(cardId) as RunRow[]).map(toRun);
  }

  /** The run currently executing on a card (any engine), if any. */
  current(cardId: string): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE card_id = ? AND status = 'running'").get(cardId) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** Work runs an agent has in progress (slot accounting, design §7). */
  workRuns(agentId: string): Run[] {
    return (this.db.prepare("SELECT * FROM runs WHERE agent_id = ? AND status = 'running' AND kind = 'work'").all(agentId) as RunRow[]).map(toRun);
  }

  /** True if the card's agent owes a reply (the transcript ends with a user message). */
  owesReply(cardId: string): boolean {
    return needsTurn(buildMessages(this.transcript(this.kanban.get(cardId))));
  }

  /** Start a run if none is active on the card and the agent owes a reply (or `kick` is given). Returns the run id. */
  wake(cardId: string, o: WakeOptions = {}): string | null {
    const card = this.kanban.get(cardId);
    const agentId = o.agentId ?? card.assignee;
    if (!agentId || this.active.has(card.id)) return null;
    const owed = needsTurn(buildMessages(this.transcript(card)));
    if (!owed && !o.kick) return null;
    const runId = 'r_' + randomUUID().slice(0, 8);
    const kind = o.kind ?? 'chat';
    // Claim atomically: another engine on the same database may hold a live run for this card.
    const claimed = this.db
      .transaction(() => {
        if (this.db.prepare("SELECT 1 FROM runs WHERE card_id = ? AND status = 'running'").get(card.id)) return false;
        this.db
          .prepare(
            "INSERT INTO runs (id, card_id, agent_id, kind, status, started_at, owner, lease_until) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)",
          )
          .run(runId, card.id, agentId, kind, new Date().toISOString(), this.instance, isoIn(this.leaseMs));
        return true;
      })
      .immediate();
    if (!claimed) return null;
    if (!owed && o.kick) this.kanban.appendMessage(card.id, 'user', 'system', [{ type: 'text', text: o.kick }]);
    this.emitRun(runId);
    const ctrl = new AbortController();
    const done = this.loop(runId, card.id, agentId, kind, ctrl.signal).finally(() => this.active.delete(card.id));
    this.active.set(card.id, { runId, agentId, kind, ctrl, done });
    return runId;
  }

  stop(cardId: string): boolean {
    const a = this.active.get(cardId);
    a?.ctrl.abort(new Error('stopped by can'));
    return !!a;
  }

  /** Resolves when the card's current run (if any) has finished. */
  async settled(cardId: string): Promise<void> {
    await this.active.get(cardId)?.done;
  }

  /**
   * Runs whose lease expired (their engine died) become 'interrupted' — not failed, no human needed — and every card
   * whose latest run was interrupted is resumed (design §6). Orphan shell processes are killed first.
   */
  recover(): string[] {
    const now = new Date().toISOString();
    const stale = this.db
      .prepare("SELECT * FROM runs WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)")
      .all(now) as RunRow[];
    for (const r of stale) {
      const orphans = this.db
        .prepare("SELECT id, pid FROM tool_calls WHERE run_id = ? AND status = 'running'")
        .all(r.id) as { id: number; pid: number | null }[];
      const notes = new Map(orphans.map((o) => [o.id, killOrphan(o.pid)]));
      this.db.transaction(() => {
        this.db
          .prepare("UPDATE runs SET status = 'interrupted', error = 'engine stopped during the run', ended_at = ? WHERE id = ?")
          .run(now, r.id);
        for (const o of orphans)
          this.db
            .prepare("UPDATE tool_calls SET status = 'error', output = ?, ended_at = ? WHERE id = ?")
            .run(`interrupted by a restart${notes.get(o.id)}`, now, o.id);
      })();
      this.emitRun(r.id);
    }
    const toResume = this.db
      .prepare(
        `SELECT card_id, agent_id, kind FROM runs r WHERE status = 'interrupted'
           AND rowid = (SELECT rowid FROM runs WHERE card_id = r.card_id ORDER BY started_at DESC, rowid DESC LIMIT 1)`,
      )
      .all() as { card_id: string; agent_id: string; kind: RunKind }[];
    return toResume.flatMap(({ card_id, agent_id, kind }) =>
      // Chat runs resume only if a reply is still owed; work and triage runs continue their task.
      this.wake(card_id, {
        agentId: agent_id,
        kind,
        kick: kind === 'chat' ? undefined : 'The engine restarted during your work. Continue where you left off.',
      })
        ? [card_id]
        : [],
    );
  }

  /** Graceful stop: abort runs (they end 'interrupted' and resume at next start), stop timers. */
  async shutdown(): Promise<void> {
    this.timers.forEach(clearInterval);
    const all = [...this.active.values()];
    for (const a of all) a.ctrl.abort(new Error('engine shutting down'));
    await Promise.allSettled(all.map((a) => a.done));
  }

  private renew(): void {
    const ids = [...this.active.values()].map((a) => a.runId);
    if (!ids.length) return;
    const stmt = this.db.prepare("UPDATE runs SET lease_until = ? WHERE id = ? AND owner = ? AND status = 'running'");
    const until = isoIn(this.leaseMs);
    this.db.transaction(() => ids.forEach((id) => stmt.run(until, id, this.instance)))();
  }

  private transcript(card: Card) {
    return this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(card.conversationId)
      .map((r) => {
        const row = r as {
          id: string;
          conversation_id: string;
          seq: number;
          role: 'user' | 'assistant';
          author: string;
          content: string;
          at: string;
          context_upto: number | null;
        };
        return {
          id: row.id,
          conversationId: row.conversation_id,
          seq: row.seq,
          role: row.role,
          author: row.author,
          content: JSON.parse(row.content) as ContentBlock[],
          at: row.at,
          contextUpto: row.context_upto,
        };
      });
  }

  private async loop(runId: string, cardId: string, agentId: string, kind: RunKind, signal: AbortSignal): Promise<void> {
    let status: RunStatus = 'done';
    let error: string | null = null;
    let terminal: Terminal = null;
    let transient = false;
    try {
      const agent = this.agents.get(agentId);
      if (!agent.enabled) throw new ModelError(`agent ${agentId} is disabled`);
      const first = this.kanban.get(cardId);
      // The card's own model (chosen above the composer) wins over the agent's.
      const { model, provider } = this.models.provider(first.modelId ?? agent.modelId);
      const workdir = workdirOf(agent, this.opts.dataDir);
      mkdirSync(workdir, { recursive: true });
      const tools = [...toolSpecs(), ...cardToolSpecs(), ...canvasToolSpecs(), ...teamToolSpecs()];

      for (let turn = 0; !terminal; turn++) {
        const card = this.kanban.get(cardId);
        this.closeDanglingToolUses(card);
        const transcript = this.transcript(card);
        if (!needsTurn(buildMessages(transcript))) break;
        if (turn >= this.maxTurns) throw new Error(`turn limit (${this.maxTurns}) reached; send a message to continue`);
        const upto = transcript.at(-1)?.seq ?? 0;
        const system = this.systemPrompt(agent, card, kind, workdir);
        const view = await this.contextFor(card, transcript, model, provider, system, tools, signal);

        const res = await this.call(model.id, () => provider.complete(
          {
            model: model.name,
            maxTokens: model.maxTokens,
            system,
            messages: view,
            tools,
            ...(card.effort ? { effort: card.effort } : {}),
          },
          (text) => this.bus.emit({ type: 'run.delta', runId, conversationId: card.conversationId, text }),
          signal,
        ));
        this.opts.usage?.record({ model, agentId: agent.id, cardId, conversationId: card.conversationId, kind: 'turn', usage: res.usage });
        if (res.content.length === 0) throw new ModelError(`model ${model.id} returned an empty answer (stop: ${res.stopReason})`);
        if (turn === 0 && model.lastError) this.models.record(model.id, null);
        this.kanban.appendMessage(cardId, 'assistant', agent.id, res.content, upto);

        const uses = res.content.filter((b) => b.type === 'tool_use');
        if (!uses.length) continue;
        const results = await Promise.all(
          uses.map(async (u) => {
            const { lastInsertRowid } = this.db
              .prepare("INSERT INTO tool_calls (run_id, tool_use_id, name, input, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)")
              .run(runId, u.id, u.name, JSON.stringify(u.input), new Date().toISOString());
            let r: { output: string; isError: boolean };
            if (isCardTool(u.name)) {
              const c = runCardTool(u.name, u.input, { kanban: this.kanban, agentId: agent.id, cardId });
              if (c.terminal && !c.isError) terminal = c.terminal;
              r = c;
            } else if (isCanvasTool(u.name)) r = runCanvasTool(u.name, u.input, { canvases: this.canvases, agentId: agent.id });
            else if (isTeamTool(u.name))
              r = runTeamTool(u.name, u.input, {
                kanban: this.kanban,
                memories: this.memories,
                schedules: this.schedules,
                agentId: agent.id,
                cardId,
                deliver: (id) => this.deliver(id),
              });
            else
              r = await runTool(u.name, u.input, {
                workdir,
                signal,
                onSpawn: (pid) => this.db.prepare('UPDATE tool_calls SET pid = ? WHERE id = ?').run(pid, lastInsertRowid),
              });
            this.db
              .prepare('UPDATE tool_calls SET status = ?, output = ?, ended_at = ? WHERE id = ?')
              .run(r.isError ? 'error' : 'done', r.output, new Date().toISOString(), lastInsertRowid);
            return { type: 'tool_result' as const, tool_use_id: u.id, content: r.output, ...(r.isError ? { is_error: true } : {}) };
          }),
        );
        signal.throwIfAborted();
        this.kanban.appendMessage(cardId, 'user', 'tool', results);
      }
    } catch (e) {
      if (signal.aborted) {
        const reason = signal.reason instanceof Error ? signal.reason.message : 'stopped';
        status = reason === 'engine shutting down' ? 'interrupted' : 'stopped';
        error = reason;
      } else {
        status = 'failed';
        error = e instanceof Error ? e.message : String(e);
        transient = e instanceof ModelError && e.transient;
        if (!(e instanceof ModelError)) console.error(`run ${runId} failed`, e);
      }
    }
    this.db.prepare('UPDATE runs SET status = ?, error = ?, ended_at = ? WHERE id = ?').run(status, error, new Date().toISOString(), runId);
    const run = this.emitRun(runId);
    try {
      this.onRunEnd({ run, terminal, transient });
    } catch (e) {
      console.error(`after run ${runId}`, e);
    }
  }

  /**
   * A model call. A model that fails to answer (unreachable, rejected request) is marked, so the dispatcher stops
   * starting runs on it until a test passes; transient failures (429, 5xx) are not.
   */
  private async call<T>(modelId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ModelError && !e.transient) this.models.record(modelId, e.message);
      throw e;
    }
  }

  /**
   * The view sent to the model (design §8): summary + recent messages. Past COMPACT_AT of the context window, the
   * oldest messages are folded into the conversation's summary with a call to the same model (a few rounds at most,
   * each leaving about half the budget free so it doesn't happen every turn). If that fails, the view is degraded
   * (old tool outputs first) and the summary is retried at the next turn. The stored transcript never changes.
   */
  private async contextFor(
    card: Card,
    transcript: ReturnType<Runner['transcript']>,
    model: Model,
    provider: Provider,
    system: string,
    tools: ToolSpec[],
    signal: AbortSignal,
  ): Promise<ModelRequest['messages']> {
    const overhead = estimateTokens(system) + estimateTokens(tools);
    const budget = Math.floor(model.contextWindow * COMPACT_AT);
    let conv = this.conversation(card.conversationId);
    let view = compactedView(transcript, conv.summary, conv.uptoSeq);
    for (let round = 0; overhead + estimateTokens(view) > budget && round < 4; round++) {
      const rest = conv.uptoSeq == null ? transcript : transcript.filter((m) => m.seq > conv.uptoSeq!);
      const room = Math.floor(model.contextWindow * 0.5) - estimateTokens(conv.summary ?? '') - 1000;
      const cut = pickCut(rest, Math.floor((budget - overhead) / 2), room);
      if (cut == null) break;
      try {
        const summary = await this.summarize(model, provider, conv.summary, rest.filter((m) => m.seq <= cut), signal, card);
        this.db.prepare('UPDATE conversations SET summary = ?, summary_upto_seq = ? WHERE id = ?').run(summary, cut, card.conversationId);
        this.kanban.event(card.id, 'compacted', { upto: cut, summaryChars: summary.length });
      } catch (e) {
        signal.throwIfAborted();
        const error = e instanceof Error ? e.message : String(e);
        console.warn(`summary of ${card.id} failed; old tool outputs are left out of the view instead`, error);
        this.kanban.event(card.id, 'compaction_failed', { error });
        break;
      }
      conv = this.conversation(card.conversationId);
      view = compactedView(transcript, conv.summary, conv.uptoSeq);
    }
    return overhead + estimateTokens(view) > budget ? degrade(view, budget, overhead) : view;
  }

  private conversation(id: string): { summary: string | null; uptoSeq: number | null } {
    const r = this.db.prepare('SELECT summary, summary_upto_seq FROM conversations WHERE id = ?').get(id) as
      | { summary: string | null; summary_upto_seq: number | null }
      | undefined;
    return { summary: r?.summary ?? null, uptoSeq: r?.summary_upto_seq ?? null };
  }

  /** Fold `messages` into the previous summary, with the agent's own model. */
  private async summarize(
    model: Model,
    provider: Provider,
    previous: string | null,
    messages: ReturnType<Runner['transcript']>,
    signal: AbortSignal,
    card: Card,
  ): Promise<string> {
    const body =
      (previous ? `Summary so far:\n${previous}\n\nNext part of the conversation, to fold into it:\n\n` : 'Conversation:\n\n') +
      renderForSummary(messages) +
      '\n\nWrite the updated summary.';
    const res = await provider.complete(
      {
        model: model.name,
        maxTokens: Math.min(model.maxTokens, 4000),
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: body }] }],
        tools: [],
      },
      () => {},
      signal,
    );
    this.opts.usage?.record({ model, agentId: card.assignee, cardId: card.id, conversationId: card.conversationId, kind: 'summary', usage: res.usage });
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n').trim();
    if (!text) throw new ModelError(`model ${model.id} returned no summary text (stop: ${res.stopReason})`);
    return text;
  }

  /** Store a result for every tool_use left without one (restart, stop), so the transcript stays valid. */
  private closeDanglingToolUses(card: Card): void {
    const answered = new Set<string>();
    const uses: string[] = [];
    for (const m of this.transcript(card))
      for (const b of m.content) {
        if (b.type === 'tool_use') uses.push(b.id);
        if (b.type === 'tool_result') answered.add(b.tool_use_id);
      }
    const missing = uses.filter((id) => !answered.has(id));
    if (missing.length)
      this.kanban.appendMessage(
        card.id,
        'user',
        'tool',
        missing.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: INTERRUPTED, is_error: true })),
      );
  }

  private emitRun(runId: string): Run {
    const run = toRun(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow);
    this.bus.emit({ type: 'run.updated', run });
    return run;
  }

  private systemPrompt(agent: Agent, card: Card, kind: RunKind, workdir: string): string {
    const roster = this.agents
      .list()
      .filter((a) => a.enabled)
      .map((a) => `- ${a.id}: ${a.rolePrompt.split('\n')[0] || '(no role description)'}`)
      .join('\n');
    const own = this.memories.get(agent.id).text;
    const shared = this.memories.get(SHARED).text;
    const parts = [
      agent.rolePrompt,
      '',
      ...(shared ? ['Shared memory (all agents):', shared, ''] : []),
      ...(own ? ['Your memory:', own, ''] : []),
      `You are the agent "${agent.id}" in Atlas, a kanban board where agents work on cards. Can is the only human.`,
      card.board === 'direct'
        ? 'This is your direct chat with Can, not a card: he talks to you here about anything. Answer him. For work that'
          + ' should be tracked, create cards with card_create (assignee, parents for order) and say which.'
        : 'This conversation is the chat of the card below: Can reads it live and may write to you at any time.',
      'Be concise; say what you did and how you verified it.',
      `Your working directory is ${workdir}. File tools and shell run there; paths outside it are refused.`,
      `Files you write there are served at /api/files/${agent.id}/<path>: show pages, built apps (dist/) or images on a`,
      'canvas with a url node. Use canvases to explain (drawing nodes for system design, markdown for notes) and to',
      'showcase designs (html nodes); mention the canvas id in the chat so Can can open it.',
      '',
      'Agents:',
      roster,
      '',
      ...(card.board === 'direct' ? [] : [`Current card: ${describeCard(card)}`, card.body || '(no description)', '']),
    ];
    if (kind === 'triage')
      parts.push(
        'TASK: triage this card. Can dropped a raw idea. Turn it into work agents can do:',
        '- If it is one piece of work: rewrite it with card_update (clear title, body with context and acceptance',
        '  criteria, assignee, priority 0-3) and set status ready.',
        '- If it is several pieces: create one card per piece with card_create (parents for order), then archive this',
        '  card with card_update(status=archived) and say which cards you created.',
        '- If something essential is unclear, ask Can ONE short question in plain text, recommended answer first,',
        '  and leave the card in triage; he answers in this chat.',
        'Do not do the work itself.',
      );
    else if (kind === 'work')
      parts.push(
        'TASK: do this card. End your run with exactly one of: card_complete (done and verified), card_request_review',
        '(Can should look before it is done), or card_block (you need an answer, access, or another card first).',
        'If you stop without one of these, the card is blocked with your last message as the question to Can.',
      );
    else if (card.board !== 'direct') parts.push('Can wrote to you on this card. Answer him; change the card only if he asks.');
    return parts.join('\n');
  }
}

const SUMMARY_SYSTEM = [
  "You compress an agent's working conversation so the agent can continue it with less context.",
  'Write what the agent needs to carry on: the goal; what Can asked and decided (his exact words where they matter);',
  'what was done (files, commands, results, card and canvas ids); what was learned; errors and how they were fixed;',
  'what remains. Keep identifiers, paths, numbers and URLs exact. Plain text, no preamble.',
].join(' ');

/** Kill a shell left running by a dead engine (its whole process group on Unix). Returns a note for the transcript. */
function killOrphan(pid: number | null): string {
  if (!pid) return '';
  try {
    if (process.platform === 'win32') process.kill(pid, 'SIGKILL');
    else process.kill(-pid, 'SIGKILL');
    return `; its process ${pid} was still running and was killed`;
  } catch {
    return ''; // already gone: nothing to report
  }
}
