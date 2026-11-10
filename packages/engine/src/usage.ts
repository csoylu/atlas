import type { ChatUsage, Model, UsageSummary } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';

/**
 * Token usage of every model call (migration 0014), for the chat screens (this conversation, how full its context
 * is) and the Models page (per day, per model, per source). Counted from what each provider reports, so it covers
 * Claude, the ChatGPT plan and local models alike; it is not a bill (OpenAI's plan usage lives in ChatGPT settings).
 */
export class Usage {
  constructor(
    private db: Db,
    private bus: Bus,
    private now: () => Date = () => new Date(),
  ) {}

  record(u: {
    model: Pick<Model, 'id' | 'provider'>;
    agentId: string | null;
    cardId: string | null;
    conversationId: string | null;
    kind: 'turn' | 'summary';
    usage: { input: number; output: number; cached?: number };
  }): void {
    this.db
      .prepare(
        `INSERT INTO model_usage (at, model_id, provider, agent_id, card_id, conversation_id, kind, input, output, cached)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(this.now().toISOString(), u.model.id, u.model.provider, u.agentId, u.cardId, u.conversationId, u.kind, u.usage.input, u.usage.output, u.usage.cached ?? 0);
    this.bus.emit({ type: 'usage.recorded', conversationId: u.conversationId, cardId: u.cardId });
  }

  /** One conversation: totals, and the prompt size of its latest answer (how full the context was then). */
  conversation(conversationId: string): Omit<ChatUsage, 'contextWindow'> {
    const t = this.db
      .prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cached), 0) AS cached FROM model_usage WHERE conversation_id = ?')
      .get(conversationId) as { calls: number; input: number; output: number; cached: number };
    const last = this.db
      .prepare("SELECT input, model_id FROM model_usage WHERE conversation_id = ? AND kind = 'turn' ORDER BY id DESC LIMIT 1")
      .get(conversationId) as { input: number; model_id: string } | undefined;
    return { ...t, lastInput: last?.input ?? null, lastModelId: last?.model_id ?? null };
  }

  /** The last `days` days (local dates, today included): per day and source, per model, and totals. */
  summary(days = 30): UsageSummary {
    const today = this.day(this.now());
    const from = this.day(new Date(this.now().getTime() - (days - 1) * 86_400_000));
    const rows = this.db
      .prepare(
        `SELECT date(at, 'localtime') AS day, model_id, provider, COUNT(*) AS calls, SUM(input) AS input, SUM(output) AS output, SUM(cached) AS cached
         FROM model_usage WHERE date(at, 'localtime') >= ? GROUP BY day, model_id, provider`,
      )
      .all(from) as { day: string; model_id: string; provider: string; calls: number; input: number; output: number; cached: number }[];
    const dayList: string[] = [];
    for (let i = days - 1; i >= 0; i--) dayList.push(this.day(new Date(this.now().getTime() - i * 86_400_000)));
    const byDay = new Map(dayList.map((d) => [d, { day: d, anthropic: 0, chatgpt: 0, claude_plan: 0, claude_code: 0, openai_compat: 0 }]));
    const models = new Map<string, UsageSummary['models'][number]>();
    const zero = () => ({ calls: 0, input: 0, output: 0 });
    const total = { ...zero(), cached: 0 };
    const weekFrom = this.day(new Date(this.now().getTime() - 6 * 86_400_000));
    for (const r of rows) {
      const d = byDay.get(r.day);
      if (d && (r.provider === 'claude_plan' || r.provider === 'claude_code' || r.provider === 'anthropic' || r.provider === 'chatgpt' || r.provider === 'openai_compat')) d[r.provider] += r.input + r.output;
      const m = models.get(r.model_id) ?? { modelId: r.model_id, provider: r.provider as Model['provider'], today: zero(), week: zero(), month: zero() };
      const add = (k: 'today' | 'week' | 'month') => {
        m[k].calls += r.calls;
        m[k].input += r.input;
        m[k].output += r.output;
      };
      add('month');
      if (r.day >= weekFrom) add('week');
      if (r.day === today) add('today');
      models.set(r.model_id, m);
      total.calls += r.calls;
      total.input += r.input;
      total.output += r.output;
      total.cached += r.cached;
    }
    return { days, perDay: [...byDay.values()], models: [...models.values()].sort((a, b) => b.month.input + b.month.output - (a.month.input + a.month.output)), total };
  }

  /** Local calendar date, as SQLite's date(at, 'localtime'). */
  private day(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
}
