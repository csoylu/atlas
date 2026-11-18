import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CHATGPT_USAGE_URL, type ChatUsage, type Effort, type Model, type UsageSummary } from '@atlas/shared';
import { api } from './api.ts';
import { ago, QUOTA_WARN, resetLabel } from './PlanAccounts.tsx';
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
 * The status strip at the bottom of the composer (design option C, 11 Nov 2026). Left: always-visible gauges —
 * context fill at the latest answer (amber past 50 %, red past the 70 % compaction point) and this chat's tokens;
 * OpenAI's « Using ChatGPT plan · Manage usage » when on that plan. Right: one pill « model · effort » that opens
 * the picker.
 */
/** `send`: the composer's teal send button (a submit button of the form around it), after the model pill. */
export function ComposerMeta(props: { usage: ChatUsage | null; plan: boolean; pick?: PickProps; send?: { disabled: boolean }; attach?: ReactNode }) {
  const u = props.usage;
  const pct = contextPct(u);
  const level = pct === null ? '' : pct >= 70 ? ' full' : pct >= 50 ? ' warm' : '';
  const hasUsage = !!u && u.calls > 0;
  return (
    <div className="composer-strip">
      <span className="strip-gauges">
        {hasUsage && (
          <span
            className={'strip-ctx' + level}
            title={[
              pct !== null ? `Context ${tok(u!.lastInput!)} of ${tok(u!.contextWindow!)} at the last answer (past 70 % the oldest messages are folded into a summary)` : null,
              `${u!.input.toLocaleString()} tokens in (${u!.cached.toLocaleString()} from cache) · ${u!.output.toLocaleString()} out`,
              `${u!.calls} model call${u!.calls === 1 ? '' : 's'}${u!.lastModelId ? ` · last answer by ${u!.lastModelId}` : ''}`,
            ].filter(Boolean).join('\n')}
          >
            {pct !== null && (
              <>
                <Ring pct={pct} />
                <span>{pct === 0 && u!.lastInput ? '<1' : pct}%<span className="strip-word"> context</span></span>
                <span className="strip-dot">·</span>
              </>
            )}
            <span className="num">
              {tok(u!.input)} in · {tok(u!.output)} out
            </span>
          </span>
        )}
        {u?.plan && <PlanGauge plan={u.plan} />}
        {props.plan && !u?.plan?.quota?.fiveHour && (
          <span className="plan-inline">
            Using ChatGPT plan
            <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
              Manage usage
            </a>
          </span>
        )}
      </span>
      {props.pick && <PickMenu {...props.pick} />}
      {props.attach}
      {props.send && (
        <button type="submit" className="send-btn" aria-label="Send" title="Send (Enter)" disabled={props.send.disabled}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 13V3M4 7l4-4 4 4" />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * « ▮ 62% of 5h »: the plan subscription that answered this chat, its 5-hour window (amber past 80 %); the weekly
 * window joins it when that one is past 80 % too. Without usage numbers: just which subscription answered.
 */
function PlanGauge({ plan }: { plan: NonNullable<ChatUsage['plan']> }) {
  const q = plan.quota;
  const name = `${plan.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} · ${plan.label}`;
  if (!q?.fiveHour && !q?.week) return <span className="strip-plan" title={`${name}: no usage numbers reported`}>{name}</span>;
  const five = q.fiveHour ? Math.round(q.fiveHour.usedPct) : null;
  const week = q.week ? Math.round(q.week.usedPct) : null;
  const warm = (five ?? 0) >= QUOTA_WARN || (week ?? 0) >= QUOTA_WARN;
  const title = [
    name,
    five !== null ? `5-hour window: ${five}% used${q.fiveHour!.resetsAt ? `, resets ${resetLabel(q.fiveHour!.resetsAt)}` : ''}` : null,
    week !== null ? `Weekly: ${week}% used${q.week!.resetsAt ? `, resets ${resetLabel(q.week!.resetsAt)}` : ''}` : null,
    `updated ${ago(q.at)}`,
  ].filter(Boolean).join('\n');
  const main = five ?? week!;
  return (
    <span className={'strip-plan' + (warm ? ' warm' : '')} title={title}>
      <span className="plan-cell" aria-hidden="true"><i style={{ height: `${Math.max(main, 8)}%` }} /></span>
      <span className="num">{main}% of {five !== null ? '5h' : 'week'}</span>
      {five !== null && week !== null && week >= QUOTA_WARN && <span className="num">· week {week}%</span>}
    </span>
  );
}

function Ring({ pct }: { pct: number }) {
  const r = 5.5, c = 2 * Math.PI * r;
  return (
    <svg className="ring" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
      <circle cx="7" cy="7" r={r} className="ring-track" />
      <circle cx="7" cy="7" r={r} className="ring-fill" strokeDasharray={`${(Math.max(pct, 3) / 100) * c} ${c}`} transform="rotate(-90 7 7)" />
    </svg>
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
const EFFORTS: { value: Effort | null; label: string }[] = [
  { value: null, label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Med' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
];
const SOURCE: Record<string, string> = {
  anthropic: 'Anthropic API',
  claude_plan: 'Claude plan',
  chatgpt: 'ChatGPT plan',
  openai_compat: 'Local',
};
const ORDER = ['claude_plan', 'chatgpt', 'anthropic', 'openai_compat'];

/** Context fill at the latest answer, in percent of the answering model's window; null before the first answer. */
export function contextPct(u: ChatUsage | null): number | null {
  return u?.lastInput != null && u.contextWindow ? Math.min(100, Math.round((u.lastInput / u.contextWindow) * 100)) : null;
}

/** The pill: model and effort for this chat or card. Empty pick = agent's model / model's default effort. */
function PickMenu(p: PickProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const own = p.models.find((m) => m.id === p.agentModelId);
  const current = p.modelId ?? own?.id ?? "Agent's model";
  // An effort the menu doesn't know (or undefined from an older payload) must not crash the chat: show it as is.
  const effort = p.effort ?? null;
  const effortLabel = EFFORTS.find((x) => x.value === effort)?.label ?? String(effort);
  const missing = p.modelId && !p.models.some((m) => m.id === p.modelId);
  const models = [...p.models].sort((a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider));

  return (
    <div className="pick-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className={'pick-pill' + (open ? ' open' : '')}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Model and effort for this chat"
        onClick={() => setOpen(!open)}
      >
        <span className="pick-model">{current}</span>
        <span className="pick-effort">· {effortLabel}</span>
        <Chevron />
      </button>
      {open && (
        <div className="pick-pop" role="dialog" aria-label="Model and effort">
          <div className="pick-k">Model</div>
          <div className="pick-list" role="radiogroup" aria-label="Model">
            <PickRow on={!p.modelId} label="Agent's model" sub={own?.id ?? 'not set'} onPick={() => p.onChange({ modelId: null })} />
            {missing && <PickRow on label={p.modelId!} sub="deleted" onPick={() => {}} />}
            {models.map((m) => (
              <PickRow key={m.id} on={p.modelId === m.id} label={m.id} sub={SOURCE[m.provider] ?? m.provider} onPick={() => p.onChange({ modelId: m.id })} />
            ))}
          </div>
          <div className="pick-k">Effort</div>
          <div className="pick-seg" role="radiogroup" aria-label="Effort">
            {EFFORTS.map((x) => (
              <button
                key={x.label}
                type="button"
                role="radio"
                aria-checked={effort === x.value}
                className={effort === x.value ? 'on' : ''}
                onClick={() => p.onChange({ effort: x.value })}
              >
                {x.label}
              </button>
            ))}
          </div>
          <div className="pick-hint">Higher thinks longer and uses more tokens. Auto = the model's default.</div>
        </div>
      )}
    </div>
  );
}

function PickRow(p: { on: boolean; label: string; sub: string; onPick(): void }) {
  return (
    <button type="button" role="radio" aria-checked={p.on} className={'pick-row' + (p.on ? ' on' : '')} onClick={p.onPick}>
      <span className="pick-row-label">{p.label}</span>
      <span className="pick-row-sub">{p.sub}</span>
      <span className="pick-check" aria-hidden="true">{p.on ? '✓' : ''}</span>
    </button>
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

/** Settings → Usage: the last 30 days by day and source, and per model. Live through the same usage events. */
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
