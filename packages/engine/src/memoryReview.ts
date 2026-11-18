import { MEMORY_REVIEW_EVERY, MEMORY_TEXT_MAX, type Card, type Memory, type MemoryKind } from '@atlas/shared';
import { z } from 'zod';
import type { Agents } from './agents.ts';
import { renderForSummary } from './context.ts';
import type { Kanban } from './kanban.ts';
import { agentScope, memoryRef, parseMemoryRef, SHARED, type Memories } from './memory.ts';
import type { Models } from './models.ts';
import type { Provider } from './providers/types.ts';
import type { Settings } from './settings.ts';
import type { Db } from './store/db.ts';
import type { Usage } from './usage.ts';

/**
 * Background memory review (v3, after OpenBot/Hermes): after a successful run that ended a task, or once a chat has
 * REVIEW_EVERY new messages, a model with no tools reads what's new in the conversation and the agent's memory and
 * returns at most MAX_CHANGES changes. They are applied as `review:<agent>` (undo in Settings → Memory), never touch a
 * memory the user wrote or edited, and reach the agent as a [memory] note on its next turn (Runner.noteMemoryChanges).
 */
export const REVIEW_EVERY = MEMORY_REVIEW_EVERY;
const MAX_CHANGES = 3;
const MAX_CHARS = 60_000;

const Change = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), kind: z.enum(['rule', 'preference', 'fact', 'project']), scope: z.enum(['agent', 'shared']), text: z.string().trim().min(1) }),
  z.object({ action: z.literal('update'), id: z.union([z.string(), z.number()]), text: z.string().trim().min(1) }),
  z.object({ action: z.literal('forget'), id: z.union([z.string(), z.number()]) }),
]);
const Reply = z.object({ language: z.string().optional(), changes: z.array(Change).max(10) });
export type ReviewChange = z.infer<typeof Change>;

/** Text that looks like a credential: never stored in memory. */
export function looksSecret(text: string): boolean {
  return (
    /\b(sk|pk|rk|ghp|gho|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{12,}/.test(text) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ||
    /\b(password|passwd|secret|token|api[_ ]?key)\s*[:=]\s*\S{6,}/i.test(text) ||
    /\b[A-Za-z0-9+/_-]{40,}\b/.test(text)
  );
}

/**
 * The language rule (#108). "The language the user writes in" alone was not enough: a task's transcript is mostly the
 * agent's and tools' text, often with no message of the user at all, so the model copied the language of the memories
 * it was shown (one French memory begot more, updates kept the old text's language). So the prompt now carries the
 * user's own latest words, from any conversation, says plainly that adds and updates use their language, and has the
 * model name that language first in its reply (`"language"`), before it writes any text.
 */
const SYSTEM = (user: string, agent: string, voice: string[]) =>
  [
    `You review a conversation between ${user} and the AI agent @${agent}, to keep @${agent}'s long-term memory useful.`,
    'Most conversations need no change: then reply {"language":"...","changes":[]}.',
    `Keep only what stays true and useful in later conversations: ${user}'s lasting rules and preferences, facts about their`,
    'setup and projects, where things are, how things work. Never: progress or logs of the work, one-off details, secrets',
    '(keys, passwords, tokens), anything the memory below already says.',
    `One idea per memory, at most ${MEMORY_TEXT_MAX} characters, declarative.`,
    `Language: write every memory text (add and update) in the language of ${user}'s own messages, never in the language of`,
    `the agent, the tools or the existing memories; an update of a memory written in another language is rewritten in ${user}'s.`,
    ...(voice.length ? [`${user}'s latest messages, to tell their language:`, ...voice.map((v) => `- "${v}"`)] : []),
    `kind: rule (how the agent must work, as ${user} asked), preference (${user}'s taste), fact, project (about current`,
    'work; it goes stale). scope: agent (only this agent) or shared (true for every agent).',
    `You may update or forget a memory the conversation shows is wrong or outdated, except those marked "by ${user}".`,
    `Reply with JSON only, no prose: {"language":"<${user}'s language>","changes":[...]} with at most ${MAX_CHANGES} items, each one of`,
    '{"action":"add","kind":"fact","scope":"agent","text":"..."} {"action":"update","id":"m12","text":"..."} {"action":"forget","id":"m12"}',
  ].join('\n');

export class MemoryReview {
  private running = new Set<string>();
  /** Resolves when every review started so far has finished (tests). */
  idle: Promise<void> = Promise.resolve();

  constructor(
    private db: Db,
    private kanban: Kanban,
    private memories: Memories,
    private models: Models,
    private agents: Agents,
    private settings: Settings,
    private usage?: Usage,
  ) {}

  /** The review model: the setting, else a Sonnet model, else the agent's own. Null = off. */
  modelFor(agentModel: string): string | null {
    const s = this.settings.get().memoryReviewModel;
    if (s === 'off') return null;
    if (s) return s;
    const sonnet = this.models.list().find((m) => /sonnet/i.test(m.name) && !m.lastError);
    return sonnet?.id ?? agentModel;
  }

  /** After a successful run: start a review in the background when it's due. */
  after(cardId: string): void {
    const card = this.kanban.get(cardId);
    if (!card.assignee || this.running.has(card.id)) return;
    const done = card.board !== 'direct' && (card.status === 'done' || card.status === 'review');
    if (!done && this.newMessages(card) < REVIEW_EVERY) return;
    const p = this.review(card.id).catch((e: unknown) => {
      const error = e instanceof Error ? e.message : String(e);
      console.warn(`memory review of ${card.id} failed`, error);
      this.kanban.event(card.id, 'memory_review_failed', { error });
    });
    this.idle = Promise.all([this.idle, p]).then(() => {});
  }

  private reviewedUpto(card: Card): number {
    const r = this.db.prepare('SELECT reviewed_upto_seq FROM conversations WHERE id = ?').get(card.conversationId) as { reviewed_upto_seq: number | null } | undefined;
    return r?.reviewed_upto_seq ?? 0;
  }

  private newMessages(card: Card): number {
    const upto = this.reviewedUpto(card);
    return this.kanban.messages(card.id).filter((m) => m.seq > upto && (m.author === 'user' || (m.role === 'assistant' && m.author !== 'system'))).length;
  }

  /** Review what's new in the conversation; returns the changes applied. */
  async review(cardId: string): Promise<string[]> {
    const card = this.kanban.get(cardId);
    const agentId = card.assignee;
    if (!agentId || this.running.has(card.id)) return [];
    const agent = this.agents.get(agentId);
    const modelId = this.modelFor(card.modelId ?? agent.modelId);
    if (!modelId) return [];
    this.running.add(card.id);
    try {
      const upto = this.reviewedUpto(card);
      const fresh = this.kanban.messages(card.id).filter((m) => m.seq > upto && m.author !== 'system');
      if (!fresh.length) return [];
      const last = fresh.at(-1)!.seq;
      let convo = renderForSummary(fresh);
      if (convo.length > MAX_CHARS) convo = '…\n' + convo.slice(-MAX_CHARS);
      const user = this.settings.user().name;
      const mine = this.visible(agentId, convo);
      const memo = mine.length
        ? mine.map((m) => `- [${memoryRef(m.id)} · ${m.kind} · ${m.scope === SHARED ? 'shared' : 'agent'}${this.byUser(m.id) ? ` · by ${user}` : ''}] ${m.text}`).join('\n')
        : '(empty)';
      const { model, provider } = this.models.provider(modelId);
      const res = await (provider as Provider).complete(
        {
          model: model.name,
          maxTokens: Math.min(model.maxTokens, 2000),
          system: SYSTEM(user, agentId, this.userVoice()),
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: `Memory of @${agentId} now:\n${memo}\n\nConversation (new part):\n\n${convo}\n\nYour JSON ("language" first: the language of ${user}'s own messages; every text in it):` }],
            },
          ],
          tools: [],
        },
        () => {},
        new AbortController().signal,
      );
      this.usage?.record({ model, agentId, cardId: card.id, conversationId: card.conversationId, kind: 'review', usage: res.usage, accountId: res.account });
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      const applied = this.apply(parseReply(text), agentId, card, user);
      this.db.prepare('UPDATE conversations SET reviewed_upto_seq = ? WHERE id = ?').run(last, card.conversationId);
      if (applied.length) this.kanban.event(card.id, 'memory_reviewed', { model: modelId, changes: applied });
      return applied;
    } finally {
      this.running.delete(card.id);
    }
  }

  /** The agent's always-on memories, plus facts and notes that match the conversation. */
  private visible(agentId: string, convo: string): Memory[] {
    const seen = new Set<number>();
    return [...this.memories.alwaysOn(agentId), ...this.memories.search(agentId, convo.slice(-8000), { limit: 20, recall: true })].filter(
      (m) => !seen.has(m.id) && seen.add(m.id),
    );
  }

  /** The user's 3 latest typed (or spoken) messages, any conversation, each cut to 200 chars: their language, shown. */
  private userVoice(): string[] {
    const rows = this.db.prepare("SELECT content FROM messages WHERE author = 'user' ORDER BY at DESC LIMIT 20").all() as { content: string }[];
    const out: string[] = [];
    for (const r of rows) {
      const blocks = JSON.parse(r.content) as { type: string; text?: string }[];
      const t = blocks.flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])).join(' ').replace(/\s+/g, ' ').trim();
      if (t.length >= 8) out.push(t.length > 200 ? t.slice(0, 200) + '…' : t);
      if (out.length === 3) break;
    }
    return out;
  }

  /** The user wrote or edited this memory: the review leaves it alone. */
  private byUser(id: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM memory_changes WHERE memory_id = ? AND by = 'user'").get(id);
  }

  /** Apply what is allowed; a refused change (duplicate, budget, secret, the user's) is skipped, never forced. */
  private apply(changes: ReviewChange[], agentId: string, card: Card, user: string): string[] {
    const by = `review:${agentId}`;
    const scopes = [agentScope(agentId), SHARED];
    const out: string[] = [];
    for (const c of changes.slice(0, MAX_CHANGES)) {
      try {
        if (c.action === 'add') {
          if (looksSecret(c.text) || c.text.length > MEMORY_TEXT_MAX) continue;
          const scope = c.scope === 'shared' ? SHARED : agentScope(agentId);
          if (this.memories.similar(scopes, c.text).length) continue;
          const m = this.memories.add(
            { kind: c.kind as MemoryKind, scope, text: c.text, cardId: c.kind === 'project' && card.board !== 'direct' ? card.id : null },
            by,
            { conversationId: card.conversationId, seq: null },
          );
          out.push(`added ${memoryRef(m.id)}`);
          continue;
        }
        const id = parseMemoryRef(c.id);
        const m = this.memories.get(id);
        if (!scopes.includes(m.scope) || m.status === 'archived' || this.byUser(id)) continue;
        if (c.action === 'update') {
          if (looksSecret(c.text) || c.text.length > MEMORY_TEXT_MAX) continue;
          this.memories.update(id, { text: c.text }, by);
          out.push(`updated ${memoryRef(id)}`);
        } else {
          this.memories.forget(id, by);
          out.push(`forgot ${memoryRef(id)}`);
        }
      } catch (e) {
        console.warn(`memory review: skipped ${JSON.stringify(c)} (${user}'s memory unchanged)`, e instanceof Error ? e.message : e);
      }
    }
    return out;
  }
}

/** The model's JSON (also inside a ```json fence or after some prose). Throws when there is none: the review failed. */
export function parseReply(text: string): ReviewChange[] {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`memory review: no JSON in the reply: ${text.slice(0, 200)}`);
  const parsed = Reply.safeParse(JSON.parse(text.slice(start, end + 1)));
  if (!parsed.success) throw new Error(`memory review: unexpected reply: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  return parsed.data.changes;
}
