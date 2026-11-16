import type { Agents } from './agents.ts';
import type { Bus } from './events.ts';
import type { Kanban } from './kanban.ts';
import type { Db } from './store/db.ts';

export const VOICE_CHAT_TITLE = 'Voice';
/** The agent that answers by voice, when it exists and is enabled; otherwise the first enabled agent. */
const VOICE_AGENT = 'atlas';
/** A posted message must start a run this fast (the dispatcher wakes chat runs at once). */
const START_TIMEOUT_MS = 15_000;

/**
 * The dedicated « Voice » direct chat: what Master says by voice is posted there as their message (through the engine
 * API, like the chat box does: rewind snapshot, dispatcher wake), and the agent's reply is streamed back from the bus.
 * The chat and its messages are in SQLite like any chat (CLAUDE.md rule 2); its card id is the setting voice_chat.
 */
export class VoiceChat {
  /** ask() calls in flight: while one is, every reply text in the chat goes to it (spoken by the voice turn). */
  private asking = 0;
  /** Runs whose text went (even partly) to an ask(): never handed to watch() as well (no double speaking). */
  private claimed = new Set<string>();

  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private agents: Agents,
    /** The engine's own API (known once it listens). */
    private url: () => string,
  ) {}

  /** The Voice chat's card id; created (and named « Voice ») on first use, or again if it was deleted or archived. */
  id(): string {
    const saved = this.get();
    if (saved) {
      const card = this.kanban.directs().find((c) => c.id === saved); // deleted or archived: a new one
      if (card) return saved;
    }
    const enabled = this.agents.list().filter((a) => a.enabled);
    const agent = enabled.find((a) => a.id === VOICE_AGENT) ?? enabled[0];
    if (!agent) throw new Error('no enabled agent to answer the Voice chat: enable one in Settings → Agents');
    const card = this.kanban.newChat(agent.id);
    this.kanban.renameChat(card.id, VOICE_CHAT_TITLE); // a « renamed » event: never auto-titled
    this.kanban.emit(card.id);
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('voice_chat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(card.id);
    return card.id;
  }

  /** True for the Voice chat (its replies are spoken: the system prompt asks for short, plain sentences). */
  isVoiceChat(cardId: string): boolean {
    return this.get() === cardId;
  }

  /**
   * Posts `text` as Master's message and streams the agent's reply text to `onText` until it has finished (no run of the
   * chat still running). Rejects when the run fails or never starts. Abort: stops listening, resolves.
   */
  async ask(text: string, onText: (delta: string) => void, signal: AbortSignal): Promise<void> {
    const id = this.id();
    const { conversationId } = this.kanban.get(id);
    let off = () => {};
    this.asking++;
    let counted = true;
    const uncount = () => {
      if (counted) this.asking--;
      counted = false;
    };
    const done = new Promise<void>((resolve, reject) => {
      // a run already under way takes the message at its next turn (no new run starts)
      let started = this.kanban.get(id).working;
      const timer = setTimeout(() => {
        if (!started && !this.kanban.get(id).working) finish(new Error(`the agent did not start answering in the Voice chat within ${START_TIMEOUT_MS / 1000} s`));
      }, START_TIMEOUT_MS);
      const finish = (err?: Error) => {
        clearTimeout(timer);
        off();
        uncount();
        if (err) reject(err);
        else resolve();
      };
      if (signal.aborted) return finish();
      signal.addEventListener('abort', () => finish(), { once: true });
      off = this.bus.on((e) => {
        if (e.type === 'run.delta' && e.conversationId === conversationId) {
          this.claimed.add(e.runId);
          onText(e.text);
        }
        if (e.type !== 'run.updated' || e.run.cardId !== id) return;
        if (e.run.status === 'running') {
          started = true;
          this.claimed.add(e.run.id);
        }
        else if (e.run.status === 'failed' || e.run.status === 'interrupted') finish(new Error(`the agent's reply failed: ${e.run.error ?? e.run.status}`));
        else if (started && !this.kanban.get(id).working) finish();
      });
    });
    done.catch(() => {}); // awaited below; an early rejection (post failed) must not be « unhandled »
    const res = await fetch(`${this.url()}/api/cards/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    }).catch((e: unknown) => {
      off();
      uncount();
      if (signal.aborted) return null;
      throw e;
    });
    if (!res) return;
    if (!res.ok) {
      off();
      uncount();
      throw new Error(`posting to the Voice chat failed: HTTP ${res.status} ${await res.text()}`);
    }
    return done;
  }

  /**
   * Every other reply in the Voice chat (card reports, messages typed with the keyboard…): `onReply` gets a finished
   * run's whole text, unless an ask() took any of it (that one is already spoken). Returns the unsubscribe.
   */
  watch(onReply: (text: string) => void): () => void {
    const texts = new Map<string, string>();
    return this.bus.on((e) => {
      if (e.type === 'run.delta') {
        const id = this.get();
        if (!id || e.conversationId !== this.kanban.get(id).conversationId) return;
        if (this.asking > 0) this.claimed.add(e.runId);
        if (this.claimed.has(e.runId)) return;
        texts.set(e.runId, (texts.get(e.runId) ?? '') + e.text);
        return;
      }
      if (e.type !== 'run.updated' || e.run.status === 'running') return;
      const text = texts.get(e.run.id);
      texts.delete(e.run.id);
      if (this.claimed.delete(e.run.id)) return;
      // a failed run shows its error in the chat; a stopped one was stopped by Master
      if (text?.trim() && e.run.status === 'done' && e.run.cardId === this.get()) onReply(text);
    });
  }

  private get(): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = 'voice_chat'").get() as { value: string } | undefined)?.value || undefined;
  }
}
