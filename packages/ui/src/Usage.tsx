import { useEffect, useState } from 'react';
import { CHATGPT_USAGE_URL, type ChatUsage, type Effort, type Model, type UsageSummary } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';

/** 1234 → "1.2k", 3_400_000 → "3.4M". */
export const tok = (n: number) =>
  n < 1000 ? String(n) : n < 1e6 ? `${+(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k` : `${+(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`;

/** This chat's usage, live: re-read whenever the engine records a call for this card. */
export function useChatUsage(cardId: string, stream: MessageStream, onError: (e: unknown) => void): ChatUsage | null {
  const [u, setU] = useState<ChatUsage | null>(null);
  useEffect(() => {
    const read = () => void api.cardUsage(cardId).then(setU, onError);
    read();
    return stream.listen('usage:' + cardId, read);
  }, [cardId, stream, onError]);
  return u;
}

/**
 * The line above the composer: how full the context was at the last answer (the model forgets the oldest part past
 * 70 %: it is folded into a summary), what this chat used, and when the agent is on the ChatGPT plan, OpenAI's
 * « Using ChatGPT plan · Manage usage ».
 */
export function ComposerMeta(props: { usage: ChatUsage | null; plan: boolean; pick?: PickProps }) {
  const u = props.usage;
  const pct = u?.lastInput != null && u.contextWindow ? Math.min(100, Math.round((u.lastInput / u.contextWindow) * 100)) : null;
  if (!props.pick && !props.plan && (!u || u.calls === 0)) return null;
  const level = pct === null ? '' : pct >= 70 ? ' full' : pct >= 50 ? ' warm' : '';
  return (
    <div className="composer-meta">
      {props.pick && <ModelEffort {...props.pick} />}
      {u && u.calls > 0 && (
        <span
          className="usage-line"
          title={`${u.calls} model call${u.calls === 1 ? '' : 's'} in this chat · ${u.input.toLocaleString()} tokens in (${u.cached.toLocaleString()} from cache) · ${u.output.toLocaleString()} out${
            u.lastInput != null ? ` · last prompt ${u.lastInput.toLocaleString()} tokens` : ''
          }`}
        >
          {pct !== null && (
            <span className={'ctx' + level}>
              <span className="ctx-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(pct, 2)}%` }} />
              </span>
              Context {pct === 0 && u.lastInput ? '<1' : pct}% of {tok(u.contextWindow!)}
            </span>
          )}
          <span className="num">
            {tok(u.input)} in · {tok(u.output)} out
          </span>
        </span>
      )}
      {props.plan && (
        <span className="plan-inline">
          Using ChatGPT plan
          <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
            Manage usage
          </a>
        </span>
      )}
    </div>
  );
}

export interface PickProps {
  models: Model[];
  /** The agent's own model, used when modelId is null. */
  agentModelId: string | null;
  modelId: string | null;
  effort: Effort | null;
  onChange(patch: { modelId?: string | null; effort?: Effort | null }): void;
}
const EFFORTS: { value: Effort; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];
const GROUPS = [
  { provider: 'anthropic', label: 'Anthropic API' },
  { provider: 'claude_plan', label: 'Claude plan' },
  { provider: 'chatgpt', label: 'ChatGPT plan' },
  { provider: 'openai_compat', label: 'Local and other servers' },
] as const;

/** Model and effort for this chat or card. Empty = the agent's model / the model's own default effort. */
export function ModelEffort(p: PickProps) {
  const own = p.models.find((m) => m.id === p.agentModelId);
  const missing = p.modelId && !p.models.some((m) => m.id === p.modelId);
  return (
    <span className="model-effort">
      <span className="meta-pick">
        <span className="meta-label">{p.modelId ? p.modelId : own ? `Agent's model (${own.id})` : "Agent's model"}</span>
        <select
          className="meta-select"
          aria-label="Model"
          title="Model for this chat. « Agent's model » follows what the agent is set to on the Agents page."
          value={p.modelId ?? ''}
          onChange={(e) => p.onChange({ modelId: e.target.value || null })}
        >
          <option value="">{own ? `Agent's model (${own.id})` : "Agent's model"}</option>
          {missing && <option value={p.modelId!}>{p.modelId} (deleted)</option>}
          {GROUPS.map((g) => {
            const ms = p.models.filter((m) => m.provider === g.provider);
            return ms.length ? (
              <optgroup key={g.provider} label={g.label}>
                {ms.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
        <Chevron />
      </span>
      <span className="meta-pick">
        <span className="meta-label">Effort: {p.effort ? EFFORTS.find((x) => x.value === p.effort)!.label.toLowerCase() : 'auto'}</span>
        <select
          className="meta-select"
          aria-label="Effort"
          title="How hard the model thinks before answering: higher is slower and uses more tokens. Auto = the model's default. Local models get low, medium or high."
          value={p.effort ?? ''}
          onChange={(e) => p.onChange({ effort: (e.target.value || null) as Effort | null })}
        >
          <option value="">Effort: auto</option>
          {EFFORTS.map((x) => (
            <option key={x.value} value={x.value}>
              Effort: {x.label.toLowerCase()}
            </option>
          ))}
        </select>
        <Chevron />
      </span>
    </span>
  );
}

function Chevron() {
  return (
    <svg
      className="meta-chev"
      viewBox="0 0 10 10"
      width="10"
      height="10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4l2.5 2.5L7.5 4" />
    </svg>
  );
}

const SOURCES = [
  { key: 'anthropic', label: 'Anthropic API' },
  { key: 'claude_plan', label: 'Claude plan' },
  { key: 'claude_code', label: 'Removed Claude integration (history)' },
  { key: 'chatgpt', label: 'ChatGPT plan' },
  { key: 'openai_compat', label: 'Local and other servers' },
] as const;
const SOURCE_LABEL: Record<string, string> = {
  anthropic: 'Anthropic API',
  claude_plan: 'Claude plan',
  claude_code: 'Removed Claude integration',
  chatgpt: 'ChatGPT plan',
  openai_compat: 'Local / server',
};

/** Models page: the last 30 days by day and source, and per model. Live through the same usage events. */
export function UsageSection(props: { stream: MessageStream; onError(e: unknown): void }) {
  const { stream, onError } = props;
  const [s, setS] = useState<UsageSummary | null>(null);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const read = () => void api.usage(30).then(setS, onError);
    read();
    // Many calls in a row (a busy board): one re-read per second at most.
    const off = stream.listen('usage', () => {
      if (!t) t = setTimeout(() => ((t = null), read()), 1000);
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
  }, [stream, onError]);
  if (!s)
    return (
      <section>
        <div className="model-row skeleton" />
      </section>
    );

  const today = s.perDay.at(-1)!;
  const todayTokens = today.claude_code + today.anthropic + today.chatgpt + today.openai_compat;
  const max = Math.max(1, ...s.perDay.map((d) => d.claude_code + d.anthropic + d.chatgpt + d.openai_compat));
  const active = s.perDay.filter((d) => d.claude_code + d.anthropic + d.chatgpt + d.openai_compat > 0).length;
  const peak = s.perDay.reduce((a, d) => Math.max(a, d.claude_code + d.anthropic + d.chatgpt + d.openai_compat), 0);
  const usedPlan = s.models.some((m) => m.provider === 'chatgpt');
  const sources = SOURCES.filter((src) => s.perDay.some((d) => d[src.key] > 0));
  const month = (d: string) =>
    new Date(d + 'T12:00:00').toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });

  return (
    <section>
      <header className="section-head">
        <h2>Usage</h2>
        <p>
          Tokens sent to and received from models over the last {s.days} days, counted by Atlas from what each provider reports. It is not a bill.
        </p>
      </header>
      {s.total.calls === 0 ? (
        <div className="empty-note">No model calls in the last {s.days} days yet.</div>
      ) : (
        <div className="usage-card">
          <div className="usage-stats">
            <Stat label="Tokens, 30 days" value={tok(s.total.input + s.total.output)} sub={`${tok(s.total.input)} in · ${tok(s.total.output)} out`} />
            <Stat label="Today" value={tok(todayTokens)} sub={`${s.models.reduce((a, m) => a + m.today.calls, 0)} calls`} />
            <Stat label="Peak day" value={tok(peak)} sub={`${active} active day${active === 1 ? '' : 's'}`} />
            <Stat
              label="From cache"
              value={s.total.input ? `${Math.round((s.total.cached / s.total.input) * 100)}%` : '–'}
              sub="of prompt tokens, reused"
            />
          </div>
          <div className="usage-chart" role="img" aria-label={`Tokens per day over ${s.days} days`}>
            {s.perDay.map((d) => {
              const total = d.claude_code + d.anthropic + d.chatgpt + d.openai_compat;
              return (
                <div key={d.day} className="usage-col" title={`${month(d.day)}: ${total.toLocaleString()} tokens`}>
                  <div className="usage-stack" style={{ height: `${(total / max) * 100}%` }}>
                    {SOURCES.map((src) => (d[src.key] ? <span key={src.key} className={'src-' + src.key} style={{ flexGrow: d[src.key] }} /> : null))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="usage-axis">
            <span>{month(s.perDay[0]!.day)}</span>
            <span className="usage-legend">
              {sources.map((src) => (
                <span key={src.key}>
                  <i className={'src-' + src.key} />
                  {src.label}
                </span>
              ))}
            </span>
            <span>Today</span>
          </div>
          {usedPlan && (
            <div className="usage-plan">
              ChatGPT plan usage and the limit you set for Atlas are in ChatGPT settings.{' '}
              <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                Manage usage
              </a>
            </div>
          )}
          <table className="usage-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Source</th>
                <th className="num">Today</th>
                <th className="num">7 days</th>
                <th className="num">30 days</th>
                <th className="num">Calls</th>
              </tr>
            </thead>
            <tbody>
              {s.models.map((m) => (
                <tr key={m.modelId}>
                  <td>
                    <i className={'src-dot src-' + m.provider} />
                    {m.modelId}
                  </td>
                  <td className="muted">{SOURCE_LABEL[m.provider] ?? m.provider}</td>
                  <td className="num">{m.today.calls ? tok(m.today.input + m.today.output) : '–'}</td>
                  <td className="num">{m.week.calls ? tok(m.week.input + m.week.output) : '–'}</td>
                  <td className="num" title={`${m.month.input.toLocaleString()} in · ${m.month.output.toLocaleString()} out`}>
                    {tok(m.month.input + m.month.output)}
                  </td>
                  <td className="num">{m.month.calls.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Stat(props: { label: string; value: string; sub: string }) {
  return (
    <div className="usage-stat">
      <span className="usage-stat-label">{props.label}</span>
      <span className="usage-stat-value num">{props.value}</span>
      <span className="usage-stat-sub">{props.sub}</span>
    </div>
  );
}
