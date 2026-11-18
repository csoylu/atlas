import { useEffect, useMemo, useState } from 'react';
import type { Agent, CreateWorkflow, Workflow, WorkflowRun } from '@atlas/shared';
import { api } from './api.ts';

/**
 * Schedules are one-step workflows since #170 (trigger → one agent step). This page reads /api/workflows and shows each
 * workflow as a schedule row; one with more steps is a row without editing. Replaced by the Workflows page (#171).
 */
interface Schedule {
  id: string;
  /** null: a workflow of several steps (or a manual trigger), shown but not edited here. */
  steps: number | null;
  revision: number;
  agentId: string;
  title: string;
  kind: 'cron' | 'at' | 'manual';
  cron: string | null;
  at: string | null;
  prompt: string;
  createCard: boolean;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastFiredAt: string | null;
  lastRun: WorkflowRun | null;
  lastError: string | null;
  createdAt: string;
}

function asSchedule(w: Workflow): Schedule {
  const t = w.nodes.find((n) => n.kind === 'trigger');
  const agents = w.nodes.flatMap((n) => (n.kind === 'agent' ? [n] : []));
  const time = t?.kind === 'trigger' && t.config.kind === 'time' ? t.config : null;
  const one = time && agents.length === 1 && w.nodes.length === 2 ? agents[0]! : null;
  return {
    id: w.id,
    steps: one ? null : w.nodes.length - 1,
    revision: w.revision,
    agentId: agents[0]?.config.agentId ?? '',
    title: w.name,
    kind: time ? time.repeat : 'manual',
    cron: time?.cron ?? null,
    at: time?.at ?? null,
    prompt: one?.config.prompt ?? '',
    createCard: one?.config.newTaskEachRun ?? false,
    timezone: time?.timezone ?? BROWSER_TZ,
    enabled: w.enabled,
    nextRunAt: w.nextRunAt,
    lastFiredAt: w.lastFiredAt,
    lastRun: w.lastRun,
    lastError: w.lastError ?? (w.lastRun?.state === 'failed' ? w.lastRun.reason : null),
    createdAt: w.createdAt,
  };
}

/** The graph of a one-step workflow: trigger → the agent step. */
function graphOf(b: { agentId: string; title: string; prompt: string; kind: 'cron' | 'at'; cron: string | null; at: string | null; timezone: string; createCard: boolean }): Pick<CreateWorkflow, 'nodes' | 'edges'> {
  return {
    nodes: [
      { id: 'trigger', kind: 'trigger', x: 40, y: 120, config: { kind: 'time', repeat: b.kind, cron: b.cron, at: b.at, timezone: b.timezone } },
      { id: 'step1', kind: 'agent', x: 300, y: 120, config: { title: b.title, agentId: b.agentId, prompt: b.prompt, newTaskEachRun: b.createCard } },
    ],
    edges: [{ from: 'trigger', exit: 'start', to: 'step1' }],
  };
}

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number | string) => String(n).padStart(2, '0');

/** The repeat patterns the form offers; anything else is « custom » (raw cron). */
type Repeat = 'weekdays' | 'daily' | 'weekly' | 'hourly' | 'custom';
interface Draft {
  agentId: string;
  title: string;
  prompt: string;
  kind: 'cron' | 'at';
  repeat: Repeat;
  time: string; // HH:MM
  weekday: number;
  minute: number; // hourly
  cron: string; // custom
  at: string; // datetime-local value, browser time
  timezone: string;
  createCard: boolean;
}

/** Read a cron expression back into the form's pattern, when it is one of them. */
function patternOf(cron: string): Pick<Draft, 'repeat' | 'time' | 'weekday' | 'minute'> | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5 || !/^\d+$/.test(f[0]!)) return null;
  const [mi, h, dom, mon, dow] = f as [string, string, string, string, string];
  if (h === '*' && dom === '*' && mon === '*' && dow === '*') return { repeat: 'hourly', minute: +mi, time: '09:00', weekday: 1 };
  if (!/^\d+$/.test(h) || dom !== '*' || mon !== '*') return null;
  const time = `${pad(h)}:${pad(mi)}`;
  if (dow === '*') return { repeat: 'daily', time, weekday: 1, minute: 0 };
  if (dow === '1-5') return { repeat: 'weekdays', time, weekday: 1, minute: 0 };
  if (/^[0-6]$/.test(dow)) return { repeat: 'weekly', time, weekday: +dow, minute: 0 };
  return null;
}

function cronOf(d: Draft): string {
  const [h, m] = d.time.split(':').map(Number) as [number, number];
  switch (d.repeat) {
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly':
      return `${m} ${h} * * ${d.weekday}`;
    case 'hourly':
      return `${d.minute} * * * *`;
    default:
      return d.cron.trim();
  }
}

/** « Weekdays at 09:00 », « Every Monday at 18:30 »… or the cron itself. */
function describeSchedule(s: Pick<Schedule, 'kind' | 'cron' | 'at'>): string {
  if (s.kind === 'manual') return 'By hand only';
  if (s.kind === 'at') return 'Once, ' + when(s.at!);
  const p = patternOf(s.cron ?? '');
  if (!p) return `cron ${s.cron}`;
  if (p.repeat === 'hourly') return `Every hour at :${pad(p.minute)}`;
  if (p.repeat === 'weekdays') return `Weekdays at ${p.time}`;
  if (p.repeat === 'daily') return `Every day at ${p.time}`;
  return `Every ${DAYS[p.weekday]} at ${p.time}`;
}

/** « Tue 11 Nov, 09:00 » in the browser's zone, with « today » / « tomorrow ». */
function when(iso: string): string {
  const d = new Date(iso);
  const day = (x: Date) => x.toDateString();
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (day(d) === day(now)) return `today ${time}`;
  if (day(d) === day(tomorrow)) return `tomorrow ${time}`;
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** A title made from the prompt's first line (maybe cut with « … ») says nothing more than the prompt. */
const sameText = (title: string, prompt: string) => {
  const p = prompt.trim();
  return !p.includes('\n') && (p === title || (title.endsWith('…') && p.startsWith(title.slice(0, -1))));
};

function relative(iso: string): string {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const a = Math.abs(s);
  if (a < 45) return 'just now';
  const t = a < 90 ? `${a} s` : a < 5400 ? `${Math.round(a / 60)} min` : a < 129_600 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86_400)} d`;
  return s >= 0 ? `in ${t}` : `${t} ago`;
}

/** datetime-local (browser time) ⇄ ISO. */
const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function draftOf(s: Schedule | null, agents: Agent[]): Draft {
  const base: Draft = {
    agentId: agents[0]?.id ?? '',
    title: '',
    prompt: '',
    kind: 'cron',
    repeat: 'weekdays',
    time: '09:00',
    weekday: 1,
    minute: 0,
    cron: '0 9 * * 1-5',
    at: toLocalInput(new Date(Date.now() + 3_600_000).toISOString()),
    timezone: BROWSER_TZ,
    createCard: false,
  };
  if (!s) return base;
  const p = s.cron ? patternOf(s.cron) : null;
  return {
    ...base,
    agentId: s.agentId,
    title: s.title,
    prompt: s.prompt,
    kind: s.kind === 'manual' ? 'cron' : s.kind,
    ...(p ?? (s.cron ? { repeat: 'custom' as const } : {})),
    cron: s.cron ?? base.cron,
    at: s.at ? toLocalInput(s.at) : base.at,
    timezone: s.timezone,
    createCard: s.createCard,
  };
}

export function SchedulesView(props: { workflows: Workflow[]; agents: Agent[]; onOpenCard(id: string): void; onError(e: unknown): void }) {
  const { agents, onError } = props;
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000); // keep « in 5 min » fresh
    return () => clearInterval(t);
  }, []);
  const schedules = useMemo(
    () =>
      props.workflows.map(asSchedule).sort(
        (a, b) => +b.enabled - +a.enabled || (a.nextRunAt ?? '~').localeCompare(b.nextRunAt ?? '~') || a.createdAt.localeCompare(b.createdAt),
      ),
    [props.workflows],
  );

  return (
    <div className="agents-view schedules-view">
      <section>
        <header className="section-head with-action">
          <div>
            <h2>Schedules</h2>
            <p>
              Give an agent a prompt at set times. Runs missed while Atlas was off happen once when it starts.
            </p>
          </div>
          {editing === null && (
            <button className="primary small" onClick={() => setEditing('new')} disabled={!agents.length}>
              New schedule
            </button>
          )}
        </header>
        {editing === 'new' && <ScheduleForm schedule={null} agents={agents} onDone={() => setEditing(null)} onError={onError} />}
        <div className="model-list">
          {schedules.map((s) =>
            editing !== 'new' && editing?.id === s.id ? (
              <ScheduleForm key={s.id} schedule={s} agents={agents} onDone={() => setEditing(null)} onError={onError} />
            ) : (
              <ScheduleRow key={s.id} s={s} onEdit={() => setEditing(s)} onOpenCard={props.onOpenCard} onError={onError} />
            ),
          )}
          {!schedules.length && editing === null && (
            <div className="empty-note">
              No schedules yet. Examples: a morning report on weekdays at 09:00, a weekly dependency check, a reminder once next
              Friday.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ScheduleRow(props: { s: Schedule; onEdit(): void; onOpenCard(id: string): void; onError(e: unknown): void }) {
  const { s, onError } = props;
  const [busy, setBusy] = useState(false);
  const status = s.lastError ? 'bad' : s.enabled ? 'ok' : 'unknown';
  return (
    <div className={'model-row schedule-row ' + status + (s.enabled ? '' : ' off')}>
      <span className="dot-status" title={s.lastError ?? (s.enabled ? 'on' : 'off')} />
      <div className="model-main">
        <div className="model-title">
          <b>{s.title}</b>
          {s.agentId && <span className="badge">@{s.agentId}</span>}
          {s.steps !== null && <span className="badge">{s.steps} steps</span>}
          <span className="muted">{describeSchedule(s)}</span>
          {s.kind === 'cron' && s.timezone !== BROWSER_TZ && <span className="muted">({s.timezone})</span>}
        </div>
        <div className="model-detail">
          {s.enabled && s.nextRunAt ? (
            <span title={new Date(s.nextRunAt).toLocaleString()}>
              next <b>{when(s.nextRunAt)}</b> <span className="muted">· {relative(s.nextRunAt)}</span>
            </span>
          ) : (
            <span className="muted">{s.kind === 'at' && s.lastFiredAt ? 'done' : 'paused'}</span>
          )}
          {s.steps === null && <span className="muted">{s.createCard ? 'new task each run' : 'one task, keeps history'}</span>}
          {s.lastRun && (
            <span className="muted" title={new Date(s.lastRun.startedAt).toLocaleString()}>
              last run {relative(s.lastRun.startedAt)} · {s.lastRun.state}
            </span>
          )}
        </div>
        {s.steps === null && !sameText(s.title, s.prompt) && <div className="schedule-prompt">{s.prompt}</div>}
        {s.lastError && <div className="model-error">Last run failed: {s.lastError}</div>}
      </div>
      <div className="model-actions">
        <label className="switch" title={s.enabled ? 'Pause' : 'Turn on'}>
          <input
            type="checkbox"
            checked={s.enabled}
            disabled={s.kind === 'at' && !s.enabled && !!s.at && new Date(s.at) < new Date()}
            onChange={(e) => api.updateWorkflow(s.id, { enabled: e.target.checked }).catch(onError)}
          />
          <span />
        </label>
        <button
          className="tool"
          disabled={busy}
          title="Give the agent the prompt now; the planned run stays"
          onClick={() => {
            setBusy(true);
            api
              .runWorkflow(s.id)
              .then((run) => {
                const card = run.steps?.find((x) => x.cardId)?.cardId;
                if (card) props.onOpenCard(card);
                else if (run.state !== 'running') onError(new Error(run.reason ?? `run ${run.state}`));
              }, onError)
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Starting…' : 'Run now'}
        </button>
        {s.steps === null && (
          <button className="ghost" onClick={props.onEdit}>
            Edit
          </button>
        )}
        <button className="ghost danger" onClick={() => confirm(`Delete schedule "${s.title}"? Its tasks stay.`) && api.deleteWorkflow(s.id).catch(onError)}>
          Delete
        </button>
      </div>
    </div>
  );
}

function ScheduleForm(props: { schedule: Schedule | null; agents: Agent[]; onDone(): void; onError(e: unknown): void }) {
  const { schedule, agents } = props;
  const [d, setD] = useState<Draft>(() => draftOf(schedule, agents));
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const [preview, setPreview] = useState<{ next: string[] } | { error: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const cron = cronOf(d);
  const at = d.kind === 'at' && d.at ? new Date(d.at).toISOString() : null;

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .previewTrigger({ repeat: d.kind, cron: d.kind === 'cron' ? cron || null : null, at, timezone: d.timezone })
        .then((p) => setPreview(p.next.length ? p : { error: 'that time is already past' }), (e: Error) => setPreview({ error: e.message }));
    }, 250);
    return () => clearTimeout(t);
  }, [d.kind, cron, at, d.timezone]);

  const valid = !!d.agentId && !!d.prompt.trim() && !!preview && 'next' in preview;
  const save = () => {
    setSaving(true);
    const body = {
      agentId: d.agentId,
      title: d.title.trim() || schedule?.title || d.prompt.trim().split('\n')[0]!.slice(0, 200),
      prompt: d.prompt,
      kind: d.kind,
      cron: d.kind === 'cron' ? cron : null,
      at,
      timezone: d.timezone,
      createCard: d.createCard,
    };
    const graph = graphOf(body);
    (schedule
      ? api.saveWorkflowGraph(schedule.id, { revision: schedule.revision, ...graph }).then(() => (body.title !== schedule.title ? api.updateWorkflow(schedule.id, { name: body.title }) : undefined))
      : api.createWorkflow({ name: body.title, ...graph })
    )
      .then(props.onDone, props.onError)
      .finally(() => setSaving(false));
  };

  return (
    <form
      className="model-row new schedule-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save();
      }}
    >
      <div className="form-grid">
        <label className="field">
          Agent
          <select value={d.agentId} onChange={(e) => set({ agentId: e.target.value })}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.id}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          Title
          <input value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder={d.prompt.trim().split('\n')[0] || 'Morning report'} />
        </label>
      </div>
      <label className="field">
        Prompt
        <textarea
          rows={3}
          autoFocus={!schedule}
          value={d.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          placeholder="What the agent should do each time, e.g. « Summarize yesterday's tasks and post blockers in the chat. »"
        />
      </label>

      <div className="form-grid">
        <div className="field">
          When
          <div className="segmented">
            <button type="button" className={d.kind === 'cron' ? 'on' : ''} onClick={() => set({ kind: 'cron' })}>
              Repeats
            </button>
            <button type="button" className={d.kind === 'at' ? 'on' : ''} onClick={() => set({ kind: 'at' })}>
              Once
            </button>
          </div>
        </div>
        {d.kind === 'cron' ? (
          <>
            <label className="field">
              Every
              <select value={d.repeat} onChange={(e) => set({ repeat: e.target.value as Repeat, ...(e.target.value === 'custom' ? { cron } : {}) })}>
                <option value="weekdays">weekday</option>
                <option value="daily">day</option>
                <option value="weekly">week</option>
                <option value="hourly">hour</option>
                <option value="custom">custom (cron)</option>
              </select>
            </label>
            {d.repeat === 'weekly' && (
              <label className="field">
                On
                <select value={d.weekday} onChange={(e) => set({ weekday: +e.target.value })}>
                  {DAYS.map((name, i) => (
                    <option key={i} value={i}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(d.repeat === 'weekdays' || d.repeat === 'daily' || d.repeat === 'weekly') && (
              <label className="field">
                At
                <input type="time" value={d.time} onChange={(e) => set({ time: e.target.value || '09:00' })} />
              </label>
            )}
            {d.repeat === 'hourly' && (
              <label className="field">
                Minute
                <input type="number" min={0} max={59} value={d.minute} onChange={(e) => set({ minute: Math.min(59, Math.max(0, +e.target.value)) })} />
              </label>
            )}
            {d.repeat === 'custom' && (
              <label className="field grow">
                Cron <span className="muted">min hour day month weekday</span>
                <input className="mono" value={d.cron} onChange={(e) => set({ cron: e.target.value })} placeholder="0 9 * * 1-5" />
              </label>
            )}
            <label className="field">
              Time zone
              <input list="tz-list" value={d.timezone} onChange={(e) => set({ timezone: e.target.value })} />
              <datalist id="tz-list">
                {[BROWSER_TZ, 'UTC', 'Europe/Paris', 'Europe/London', 'America/New_York', 'Asia/Tokyo'].filter((z, i, a) => a.indexOf(z) === i).map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </label>
          </>
        ) : (
          <label className="field">
            At <span className="muted">your time</span>
            <input type="datetime-local" value={d.at} onChange={(e) => set({ at: e.target.value })} />
          </label>
        )}
      </div>

      <div className={'schedule-preview ' + (preview && 'error' in preview ? 'bad' : '')}>
        {!preview ? '…' : 'error' in preview ? preview.error : <>Next: {preview.next.map(when).join(' · ')}</>}
      </div>

      <div className="field">
        Each run
        <div className="choice">
          <label>
            <input type="radio" checked={!d.createCard} onChange={() => set({ createCard: false })} />
            <span>
              <b>One task for this schedule</b>, reopened each run: the agent sees what earlier runs did
            </span>
          </label>
          <label>
            <input type="radio" checked={d.createCard} onChange={() => set({ createCard: true })} />
            <span>
              <b>A new task each run</b>, dated: separate tasks on the board
            </span>
          </label>
        </div>
      </div>

      <div className="actions">
        <button type="button" className="ghost" onClick={props.onDone}>
          Cancel
        </button>
        <button className="primary small" disabled={!valid || saving}>
          {saving ? 'Saving…' : schedule ? 'Save' : 'Create schedule'}
        </button>
      </div>
    </form>
  );
}
