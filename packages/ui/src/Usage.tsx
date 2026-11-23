import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CHATGPT_USAGE_URL, type ChatUsage, type Effort, type Model, type UsageSummary } from '@atlas/shared';
import { api } from './api.ts';
import { ago, QUOTA_WARN, resetLabel } from './PlanAccounts.tsx';
import type { MessageStream } from './useMessages.ts';

import { axisTicks, dayTotal, tok, usageHeadline } from './usageStats.ts';
import { Skeleton } from './Kit.tsx';
import { PopButton } from './HeadMenu.tsx';
import { friendlyModel } from './modelNames.ts';

export { tok };

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
 * The row under the composer's text (redesign #271, mockup « Chat »): the model pill « Fable 5.2 · Medium ▾ » that
 * opens the picker, then the context ring (amber past 50 %, red past the 70 % compaction point); this chat's tokens and
 * the plan meter are behind the ring (hover, or a click / tap for the card). The plan meter joins the row only past
 * QUOTA_WARN. OpenAI's « Using ChatGPT plan · Manage usage » stays visible when on that plan. Right: attach, the voice
 * toggle (desktop, the voice chat only), send. `sees`: the eye after the ring (#305), what the agent will see.
 */
/** `send`: the composer's teal send button (a submit button of the form around it), at the right end. */
export function ComposerMeta(props: { usage: ChatUsage | null; plan: boolean; models?: Model[]; pick?: PickProps; send?: { disabled: boolean; title?: string }; attach?: ReactNode; voice?: ReactNode; sees?: ReactNode }) {
  const u = props.usage;
  const pct = contextPct(u);
  const level = pct === null ? '' : pct >= 70 ? ' full' : pct >= 50 ? ' warm' : '';
  const hasUsage = !!u && u.calls > 0;
  // A friendly name or nothing: never a raw model id (a deleted model just isn't named).
  const lastM = u?.lastModelId ? (props.models ?? props.pick?.models ?? []).find((m) => m.id === u.lastModelId) : undefined;
  const lastModel = lastM ? friendlyModel(lastM.name) : null;
  const q = u?.plan?.quota;
  const planHot = !!q && Math.max(q.fiveHour?.usedPct ?? 0, q.week?.usedPct ?? 0) >= QUOTA_WARN;
  const lines = hasUsage
    ? [
        pct !== null ? `Context ${pct === 0 && u!.lastInput ? '<1' : pct}% used: ${tok(u!.lastInput!)} of ${tok(u!.contextWindow!)} at the last answer. Past 70 % the oldest messages are folded into a summary.` : null,
        `${tok(u!.input)} tokens in (${tok(u!.cached)} from cache) · ${tok(u!.output)} out`,
        `${u!.calls} model call${u!.calls === 1 ? '' : 's'}${lastModel ? ` · last answer by ${lastModel}` : ''}`,
        u!.plan ? planLine(u!.plan) : null,
      ].filter((x): x is string => !!x)
    : [];
  return (
    <div className="composer-strip">
      {props.pick && <PickMenu {...props.pick} />}
      {hasUsage && (
        <PopButton
          className={'ctx-ring' + level}
          label={<Ring pct={pct ?? 0} />}
          title={lines.join('\n')}
          ariaLabel={pct !== null ? `Context ${pct}% used: usage details` : 'Usage details'}
          width={300}
        >
          {() => (
            <div className="ring-pop">
              {lines.map((l) => (
                <p key={l}>{l}</p>
              ))}
            </div>
          )}
        </PopButton>
      )}
      {props.sees}
      {u?.plan && planHot && <PlanGauge plan={u.plan} />}
      {props.plan && !u?.plan?.quota?.fiveHour && (
        <span className="plan-inline">
          Using ChatGPT plan
          <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
            Manage usage
          </a>
        </span>
      )}
      <span className="strip-sp" />
      {props.attach}
      {props.voice}
      {props.send && (
        <button type="submit" className="send-btn" aria-label="Send" title={props.send.title ?? 'Send (Enter)'} disabled={props.send.disabled}>
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 13V3M4 7l4-4 4 4" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** « Claude · Max: 5-hour window 44 % used, resets 16:00 », for the ring's card. */
function planLine(plan: NonNullable<ChatUsage['plan']>): string {
  const q = plan.quota;
  const name = `${plan.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} · ${plan.label}`;
  const part = (k: string, w: { usedPct: number; resetsAt?: string | null } | null | undefined) =>
    w ? `${k} ${Math.round(w.usedPct)}% used${w.resetsAt ? `, resets ${resetLabel(w.resetsAt)}` : ''}` : null;
  const parts = [part('5-hour window', q?.fiveHour), part('week', q?.week)].filter(Boolean);
  return parts.length ? `${name}: ${parts.join(' · ')}` : `${name}: no usage numbers reported`;
}

/**
 * « ▮ 82% of 5h »: the plan window that answered this chat, shown beside the ring only past QUOTA_WARN (amber); the
 * weekly window joins it when that one is past it too.
 */
function PlanGauge({ plan }: { plan: NonNullable<ChatUsage['plan']> }) {
  const q = plan.quota!;
  const five = q.fiveHour ? Math.round(q.fiveHour.usedPct) : null;
  const week = q.week ? Math.round(q.week.usedPct) : null;
  const main = five !== null && five >= QUOTA_WARN ? five : (week ?? five!);
  const which = five !== null && five >= QUOTA_WARN ? '5h' : 'week';
  return (
    <span className="strip-plan warm" title={`${planLine(plan)}\nupdated ${ago(q.at)}`}>
      <span className="plan-cell" aria-hidden="true"><i style={{ height: `${Math.max(main, 8)}%` }} /></span>
      <span className="num">{main}% of {which}</span>
      {which === '5h' && week !== null && week >= QUOTA_WARN && <span className="num">· week {week}%</span>}
    </span>
  );
}

function Ring({ pct }: { pct: number }) {
  const r = 8, c = 2 * Math.PI * r;
  return (
    <svg className="ring" viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <circle cx="10" cy="10" r={r} className="ring-track" />
      <circle cx="10" cy="10" r={r} className="ring-fill" strokeDasharray={`${(Math.min(pct, 100) / 100) * c} ${c}`} transform="rotate(-90 10 10)" />
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
/** `label` in the menu's segments, `long` in the pill (« Fable 5.2 · Medium »). */
const EFFORTS: { value: Effort | null; label: string; long: string }[] = [
  { value: null, label: 'Auto', long: 'Auto' },
  { value: 'low', label: 'Low', long: 'Low' },
  { value: 'medium', label: 'Med', long: 'Medium' },
  { value: 'high', label: 'High', long: 'High' },
  { value: 'xhigh', label: 'XHigh', long: 'XHigh' },
  { value: 'max', label: 'Max', long: 'Max' },
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
  // Friendly names only (« Fable 5.2 », never plan-claude-fable-5-2): the exact id is on the agent's settings page.
  const picked = p.models.find((m) => m.id === p.modelId);
  const current = picked ? friendlyModel(picked.name) : p.modelId ? 'Deleted model' : own ? friendlyModel(own.name) : "Agent's model";
  // An effort the menu doesn't know (or undefined from an older payload) must not crash the chat: show it as is.
  const effort = p.effort ?? null;
  const effortLabel = EFFORTS.find((x) => x.value === effort)?.long ?? String(effort);
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
            <PickRow on={!p.modelId} label="Agent's model" sub={own ? friendlyModel(own.name) : 'not set'} onPick={() => p.onChange({ modelId: null })} />
            {missing && <PickRow on label="Deleted model" sub="pick another" onPick={() => {}} />}
            {models.map((m) => (
              <PickRow key={m.id} on={p.modelId === m.id} label={friendlyModel(m.name)} sub={SOURCE[m.provider] ?? m.provider} onPick={() => p.onChange({ modelId: m.id })} />
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
  { key: 'chatgpt', label: 'ChatGPT plan' },
  { key: 'openai_compat', label: 'Local and other servers' },
] as const;
const SOURCE_LABEL: Record<string, string> = {
  anthropic: 'Anthropic API',
  claude_plan: 'Claude plan',
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
        <Skeleton />
      </section>
    );

  const { today: todayTokens, todayCalls, max, active, peak } = usageHeadline(s);
  const usedPlan = s.models.some((m) => m.provider === 'chatgpt');
  const sources = SOURCES.filter((src) => s.perDay.some((d) => d[src.key] > 0));
  const month = (d: string) =>
    new Date(d + 'T12:00:00').toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
    });

  return (
    <section>
      <p className="set-lead">
        Tokens sent to and received from models over the last {s.days} days, counted by Atlas from what each provider reports. It is not a bill.
      </p>
      {s.total.calls === 0 ? (
        <div className="state-empty">No model calls in the last {s.days} days yet.</div>
      ) : (
        <div className="usage-card">
          <div className="usage-stats">
            <Stat label="Tokens, 30 days" value={tok(s.total.input + s.total.output)} sub={`${tok(s.total.input)} in · ${tok(s.total.output)} out`} />
            <Stat label="Today" value={tok(todayTokens)} sub={`${todayCalls} call${todayCalls === 1 ? '' : 's'}`} />
            <Stat label="Peak day" value={tok(peak)} sub={`${active} active day${active === 1 ? '' : 's'}`} />
            <Stat
              label="From cache"
              value={s.total.input ? `${Math.round((s.total.cached / s.total.input) * 100)}%` : '–'}
              sub="of prompt tokens, reused"
            />
          </div>
          <div className="usage-chart" role="img" aria-label={`Tokens per day over ${s.days} days`}>
            {s.perDay.map((d) => {
              const total = dayTotal(d);
              return (
                <div key={d.day} className="usage-col" title={`${month(d.day)}: ${total.toLocaleString()} tokens`}>
                  <div className="usage-stack" style={{ height: `${(total / max) * 100}%` }}>
                    {SOURCES.map((src) => (d[src.key] ? <span key={src.key} className={'src-' + src.key} style={{ flexGrow: d[src.key] }} /> : null))}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="usage-axis" aria-hidden="true">
            {axisTicks(s.perDay.map((d) => d.day), month).map((t) => (
              <span key={t.day} className={t.at < 8 ? 'usage-tick start' : t.at > 92 ? 'usage-tick end' : 'usage-tick'} style={{ left: `${t.at}%` }}>
                {t.label}
              </span>
            ))}
          </div>
          <div className="usage-legend">
            {sources.map((src) => (
              <span key={src.key}>
                <i className={'src-' + src.key} />
                {src.label}
              </span>
            ))}
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
