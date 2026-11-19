import { useEffect, useRef, useState } from 'react';
import { CARD_STATUSES, type Agent, type TriggerConfig, type Workflow, type WorkflowField, type WorkflowEdge, type WorkflowNode, type WorkflowNodeKind } from '@atlas/shared';
import { useProjects } from './projects.tsx';
import { STATUS_LABEL } from './StatusIcon.tsx';
import { api } from './api.ts';
import { WebhookFields } from './WorkflowWebhook.tsx';
import {
  blankTrigger,
  eventChoiceOf,
  fieldParts,
  groupFields,
  FILTER_LABEL,
  filterKeys,
  filterRows,
  PR_EVENT_CHOICES,
  runGets,
  TASK_EVENT_CHOICES,
  TRIGGER_KINDS,
  withEvent,
  withFilters,
  type FilterKey,
  type FilterRow,
  type TriggerKind,
} from './workflowView.ts';
import { BROWSER_TZ, DAYS, KIND_LABEL, cronOf, exitTarget, exitsOf, freeSpot, newNodeId, nodeMeta, nodeTitle, timeDraftOf, triggerOf, when, wire, withoutNode, type Repeat, type TimeDraft } from './workflowView.ts';

/** The canvas's right panel in Edit mode: the selected step's settings and exits (#171). */

type Graph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
type Change = (g: Graph, key?: string | null) => void;
type SetConfig = (c: WorkflowNode['config'], key?: string | null) => void;

const ICON: Record<WorkflowNodeKind, React.ReactNode> = {
  trigger: <path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" />,
  agent: (
    <>
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 14c.6-2.8 2.6-4.2 5-4.2s4.4 1.4 5 4.2" />
    </>
  ),
  approval: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="m5.5 8 1.8 1.8L10.8 6.3" />
    </>
  ),
  condition: <path d="M8 1.8 14.2 8 8 14.2 1.8 8z" />,
  action: <path d="M3 8h8M8 4.5 11.5 8 8 11.5" />,
  wait: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
};
export function KindIcon({ kind }: { kind: WorkflowNodeKind }) {
  return (
    <span className={'wf-ico ' + kind}>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {ICON[kind]}
      </svg>
    </span>
  );
}

export function StepPanel(props: { n: WorkflowNode; g: Graph; w: Workflow; agents: Agent[]; change: Change; onClose(): void; onDeleted(): void; go(hash: string): void; onError(e: unknown): void }) {
  const { n, g } = props;
  const fields = { workflowId: props.w.id, nodeId: n.id };
  const set: SetConfig = (config, key = null) =>
    props.change({ nodes: g.nodes.map((m) => (m.id === n.id ? ({ ...m, config } as WorkflowNode) : m)), edges: g.edges }, key && `${n.id}:${key}`);
  return (
    <aside className="wf-side" aria-label="Step">
      <div className="sd-head">
        <KindIcon kind={n.kind} />
        <b>{KIND_LABEL[n.kind]}</b>
        <span className="sd-sp" />
        <button className="sd-btn" aria-label="Close" onClick={props.onClose}>
          ✕
        </button>
      </div>
      <div className="wf-side-body">
        {n.kind === 'trigger' && <TriggerFields n={n} w={props.w} agents={props.agents} set={set} />}
        {n.kind === 'agent' && <AgentFields n={n} agents={props.agents} fields={fields} set={set} />}
        {n.kind === 'approval' && <ApprovalFields n={n} fields={fields} set={set} />}
        {n.kind === 'condition' && <ConditionFields n={n} g={g} set={set} />}
        {(n.kind === 'action' || n.kind === 'wait') && <p className="wf-sum">{nodeMeta(n, g.nodes)}</p>}
        <Exits n={n} g={g} change={props.change} />
      </div>
      <div className="wf-side-foot">
        {n.kind === 'trigger' ? (
          <>
            <span className="wf-sum">The trigger can't be deleted.</span>
            <button
              className="btn ghost danger"
              onClick={() => confirm(`Delete workflow "${props.w.name}"? Its tasks stay.`) && api.deleteWorkflow(props.w.id).then(() => props.go('#/workflows'), props.onError)}
            >
              Delete workflow
            </button>
          </>
        ) : (
          <>
            <button
              className="btn ghost"
              onClick={() => props.change({ nodes: [...g.nodes, { ...n, id: newNodeId(g.nodes), ...freeSpot(g.nodes, n) } as WorkflowNode], edges: g.edges })}
            >
              Duplicate
            </button>
            <button
              className="btn ghost danger"
              onClick={() => {
                props.change(withoutNode(g, n.id));
                props.onDeleted();
              }}
            >
              Delete step
            </button>
          </>
        )}
      </div>
    </aside>
  );
}

/** A textarea whose {{fields}} show as chips (a mirror behind the text), with « Insert a field » (#259). */
function PromptField(props: { label: string; value: string; placeholder: string; fields: FieldsOf; onChange(v: string): void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const insert = (field: string) => {
    const t = ref.current;
    let at = t ? t.selectionStart : props.value.length;
    const end = t ? t.selectionEnd : at;
    // Typed « {{ » opened the picker: the field replaces it.
    if (props.value.slice(at - 2, at) === '{{') at -= 2;
    const v = `{{${field}}}`;
    props.onChange(props.value.slice(0, at) + v + props.value.slice(end));
    setOpen(false);
    setQ('');
    requestAnimationFrame(() => {
      t?.focus();
      t?.setSelectionRange(at + v.length, at + v.length);
    });
  };
  return (
    <div className="field wf-prompt">
      <label htmlFor={undefined}>{props.label}</label>
      <div className="wf-ta">
        <div className="wf-mirror" ref={mirror} aria-hidden="true">
          {fieldParts(props.value).map((p, i) => (p.field ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
          {'\n'}
        </div>
        <textarea
          ref={ref}
          rows={6}
          aria-label={props.label}
          value={props.value}
          placeholder={props.placeholder}
          onScroll={(e) => mirror.current && (mirror.current.scrollTop = e.currentTarget.scrollTop)}
          onChange={(e) => {
            props.onChange(e.target.value);
            const at = e.target.selectionStart;
            if (e.target.value.slice(at - 2, at) === '{{') setOpen(true);
          }}
          onKeyDown={(e) => e.key === 'Escape' && open && (e.stopPropagation(), setOpen(false))}
        />
      </div>
      <div className="wf-ins">
        <button type="button" className={'btn' + (open ? ' on' : '')} aria-expanded={open} onClick={() => setOpen(!open)}>
          {'{ }'} Insert a field
        </button>
        <span className="muted">or type {'{{'}</span>
      </div>
      {open && <FieldPicker of={props.fields} q={q} setQ={setQ} onPick={insert} onClose={() => setOpen(false)} />}
    </div>
  );
}

type FieldsOf = { workflowId: string; nodeId: string };
/** The fields a step can use, with values from the last run (GET /api/workflows/:id/fields?node=), read when the picker opens (the graph is saved by then). */
function useFields(workflowId: string, nodeId: string): { list: WorkflowField[] | null; error: string | null } {
  const [f, setF] = useState<{ list: WorkflowField[] | null; error: string | null }>({ list: null, error: null });
  useEffect(() => {
    let live = true;
    api.workflowFields(workflowId, nodeId).then(
      (list) => live && setF({ list, error: null }),
      (e: Error) => live && setF({ list: null, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [workflowId, nodeId]);
  return f;
}

function FieldPicker({ of, q, setQ, onPick, onClose }: { of: FieldsOf; q: string; setQ(q: string): void; onPick(f: string): void; onClose(): void }) {
  const fields = useFields(of.workflowId, of.nodeId);
  const groups = groupFields(fields.list ?? [], q);
  return (
    <div className="wf-picker" role="dialog" aria-label="Insert a field" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search fields" aria-label="Search fields" />
      <div className="wf-picker-list" role="listbox">
        {fields.error && <p className="wf-sum bad">{fields.error}</p>}
        {!fields.list && !fields.error && <p className="wf-sum">Loading…</p>}
        {fields.list && !groups.length && <p className="wf-sum">No field matches.</p>}
        {groups.map((g) => (
          <div key={g.label} className="grp">
            <span className="gl">{g.label}</span>
            {g.fields.map((f) => (
              <button key={f.field} type="button" role="option" aria-selected={false} onClick={() => onPick(f.field)} title={`{{${f.field}}}`}>
                <span className="fl">
                  {f.label}
                  {f.optional && <span className="muted"> · may be empty</span>}
                </span>
                <span className="fv">{f.example ? f.example.split('\n')[0] : <code>{`{{${f.field}}}`}</code>}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {fields.list && <span className="help">Values from the last run.</span>}
    </div>
  );
}

function AgentFields({ n, agents, fields, set }: { n: Extract<WorkflowNode, { kind: 'agent' }>; agents: Agent[]; fields: FieldsOf; set: SetConfig }) {
  const c = n.config;
  return (
    <>
      <label className="field">
        Title
        <input value={c.title} placeholder={c.prompt.trim().split('\n')[0]?.slice(0, 80) || 'Validate the PR'} onChange={(e) => set({ ...c, title: e.target.value }, 'title')} />
      </label>
      <label className="field">
        Agent
        <select value={c.agentId ?? ''} onChange={(e) => set({ ...c, agentId: e.target.value || null })}>
          {!c.agentId && <option value="">Pick an agent</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.id}
            </option>
          ))}
          {c.agentId && !agents.some((a) => a.id === c.agentId) && <option value={c.agentId}>@{c.agentId} (missing)</option>}
        </select>
      </label>
      <PromptField
        fields={fields}
        label="Prompt"
        value={c.prompt}
        placeholder="What the agent should do, e.g. « Check the dependencies and open a PR for the safe updates. »"
        onChange={(v) => set({ ...c, prompt: v }, 'prompt')}
      />
      <div className="field">
        Task
        <div className="segmented">
          <button type="button" className={c.newTaskEachRun ? 'on' : ''} aria-pressed={c.newTaskEachRun} onClick={() => set({ ...c, newTaskEachRun: true })}>
            New each run
          </button>
          <button type="button" className={!c.newTaskEachRun ? 'on' : ''} aria-pressed={!c.newTaskEachRun} onClick={() => set({ ...c, newTaskEachRun: false })}>
            One, keeps history
          </button>
        </div>
      </div>
    </>
  );
}

function ApprovalFields({ n, fields, set }: { n: Extract<WorkflowNode, { kind: 'approval' }>; fields: FieldsOf; set: SetConfig }) {
  const c = n.config;
  return (
    <>
      <label className="field">
        Title
        <input value={c.title} placeholder="Merge it?" onChange={(e) => set({ ...c, title: e.target.value }, 'title')} />
      </label>
      <PromptField fields={fields} label="Question" value={c.question} placeholder="What you decide, e.g. « Merge the PR? Its summary: {{previous.summary}} »" onChange={(v) => set({ ...c, question: v }, 'question')} />
      <p className="wf-sum">A task blocked on you shows in the Inbox with Approve and Reject.</p>
    </>
  );
}

function ConditionFields({ n, g, set }: { n: Extract<WorkflowNode, { kind: 'condition' }>; g: Graph; set: SetConfig }) {
  const c = n.config;
  const steps = g.nodes.filter((x) => x.kind !== 'trigger' && x.id !== n.id);
  // Tests on fields (#261): edited in the stage 2 editor (5/6); shown read-only here.
  if (c.test === 'fields') return <p className="wf-sum">{nodeTitle({ ...n, config: { ...c, title: '' } }, g.nodes)}</p>;
  return (
    <>
      <label className="field">
        Title
        <input value={c.title} placeholder={nodeTitle({ ...n, config: { ...c, title: '' } }, g.nodes)} onChange={(e) => set({ ...c, title: e.target.value }, 'title')} />
      </label>
      <div className="field">
        Test
        <div className="segmented">
          <button
            type="button"
            className={c.test === 'ranFewer' ? 'on' : ''}
            aria-pressed={c.test === 'ranFewer'}
            onClick={() => c.test !== 'ranFewer' && set({ test: 'ranFewer', title: c.title, node: steps[0]?.id ?? 'trigger', times: 3 })}
          >
            Rounds
          </button>
          <button type="button" className={c.test === 'summaryContains' ? 'on' : ''} aria-pressed={c.test === 'summaryContains'} onClick={() => c.test !== 'summaryContains' && set({ test: 'summaryContains', title: c.title, text: 'OK' })}>
            Summary has
          </button>
        </div>
      </div>
      {c.test === 'ranFewer' ? (
        <div className="form-grid">
          <label className="field grow">
            Yes when this step
            <select value={c.node} onChange={(e) => set({ ...c, node: e.target.value })}>
              {steps.map((s) => (
                <option key={s.id} value={s.id}>
                  {nodeTitle(s, g.nodes)}
                </option>
              ))}
              {!steps.some((s) => s.id === c.node) && <option value={c.node}>{c.node}</option>}
            </select>
          </label>
          <label className="field">
            ran fewer than
            <input type="number" min={1} max={100} value={c.times} onChange={(e) => set({ ...c, times: Math.min(100, Math.max(1, Math.round(+e.target.value) || 1)) }, 'times')} />
          </label>
        </div>
      ) : (
        <label className="field">
          Yes when the previous step's summary contains
          <input value={c.text} onChange={(e) => e.target.value && set({ ...c, text: e.target.value }, 'text')} />
        </label>
      )}
      <p className="wf-sum">Nothing is judged by a model: the test is exact.</p>
    </>
  );
}

function TriggerFields({ n, w, agents, set }: { n: Extract<WorkflowNode, { kind: 'trigger' }>; w: Workflow; agents: Agent[]; set: SetConfig }) {
  const c = n.config;
  const [d, setD] = useState<TimeDraft>(() => timeDraftOf(c));
  const [preview, setPreview] = useState<{ next: string[] } | { error: string } | null>(null);
  const time = c.kind === 'time';
  const push = (patch: Partial<TimeDraft>) => {
    const next = { ...d, ...patch };
    setD(next);
    const t = triggerOf(next);
    if ((t.kind === 'time' && t.repeat === 'cron' && !t.cron) || (t.kind === 'time' && t.repeat === 'at' && !t.at)) return;
    set(t, 'when');
  };
  const cron = cronOf(d);
  const at = d.kind === 'at' && d.at ? new Date(d.at).toISOString() : null;
  useEffect(() => {
    if (!time) return;
    const t = setTimeout(() => {
      api
        .previewTrigger({ repeat: d.kind, cron: d.kind === 'cron' ? cron || null : null, at, timezone: d.timezone })
        .then((p) => setPreview(p.next.length ? p : { error: 'that time is already past' }), (e: Error) => setPreview({ error: e.message }));
    }, 250);
    return () => clearTimeout(t);
  }, [time, d.kind, cron, at, d.timezone]);
  return (
    <>
      <TriggerPick kind={c.kind} global={!w.projectId} compact onPick={(k) => set(k === 'time' ? triggerOf(d) : blankTrigger(k, c))} />
      {c.kind === 'manual' && <p className="wf-sum">It runs only when you press Run now (here, on a task, or an agent's run tool).</p>}
      {(c.kind === 'task' || c.kind === 'pr') && <EventFields t={c} projectId={w.projectId} agents={agents} set={set} />}
      {c.kind === 'webhook' && <WebhookFields t={c} w={w} set={set} />}
      {time && (
        <>
          <div className="field">
            When
            <div className="segmented">
              <button type="button" className={d.kind === 'cron' ? 'on' : ''} onClick={() => push({ kind: 'cron' })}>
                Repeats
              </button>
              <button type="button" className={d.kind === 'at' ? 'on' : ''} onClick={() => push({ kind: 'at' })}>
                Once
              </button>
            </div>
          </div>
          {d.kind === 'cron' ? (
            <div className="form-grid">
              <label className="field">
                Every
                <select value={d.repeat} onChange={(e) => push({ repeat: e.target.value as Repeat, ...(e.target.value === 'custom' ? { cron } : {}) })}>
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
                  <select value={d.weekday} onChange={(e) => push({ weekday: +e.target.value })}>
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
                  <input type="time" value={d.time} onChange={(e) => push({ time: e.target.value || '09:00' })} />
                </label>
              )}
              {d.repeat === 'hourly' && (
                <label className="field">
                  Minute
                  <input type="number" min={0} max={59} value={d.minute} onChange={(e) => push({ minute: Math.min(59, Math.max(0, +e.target.value)) })} />
                </label>
              )}
              {d.repeat === 'custom' && (
                <label className="field grow">
                  Cron <span className="muted">min hour day month weekday</span>
                  <input className="mono" value={d.cron} onChange={(e) => push({ cron: e.target.value })} placeholder="0 9 * * 1-5" />
                </label>
              )}
              <label className="field">
                Time zone
                <input list="wf-tz-list" value={d.timezone} onChange={(e) => push({ timezone: e.target.value })} />
                <datalist id="wf-tz-list">
                  {[BROWSER_TZ, 'UTC', 'Europe/Paris', 'Europe/London', 'America/New_York', 'Asia/Tokyo']
                    .filter((z, i, a) => a.indexOf(z) === i)
                    .map((z) => (
                      <option key={z} value={z} />
                    ))}
                </datalist>
              </label>
            </div>
          ) : (
            <label className="field">
              At <span className="muted">your time</span>
              <input type="datetime-local" value={d.at} onChange={(e) => push({ at: e.target.value })} />
            </label>
          )}
          <div className={'schedule-preview ' + (preview && 'error' in preview ? 'bad' : '')}>
            {!preview ? '…' : 'error' in preview ? preview.error : <>Next: {preview.next.map((x) => when(x)).join(' · ')}</>}
          </div>
        </>
      )}
      {c.kind !== 'manual' && <RunGets t={c} hasProject={!!w.projectId} />}
      {c.kind !== 'manual' && !w.enabled && <p className="wf-sum">The workflow is off: turn it on (top right) for the trigger to fire.</p>}
    </>
  );
}

type EventTrigger = Extract<TriggerConfig, { kind: 'task' | 'pr' }>;

/**
 * « Starts »: the five triggers (#259; Webhook #260). `compact` (the side panel): one per line, the help
 * only under the chosen one. A Global workflow (no project) starts at set times or by hand only.
 */
export function TriggerPick({ kind, global, compact, onPick }: { kind: TriggerKind; global: boolean; compact?: boolean; onPick(k: TriggerKind): void }) {
  return (
    <div className="field">
      Starts
      <div className={'wf-tks' + (compact ? ' compact' : '')} role="radiogroup" aria-label="How it starts">
        {TRIGGER_KINDS.map((k) => {
          const off = global && (k.kind === 'task' || k.kind === 'pr') && kind !== k.kind;
          return (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={kind === k.kind}
              disabled={off}
              title={off ? 'A Global workflow starts at set times or by hand: give it a project for task and PR events' : undefined}
              className={'wf-tk' + (kind === k.kind ? ' on' : '')}
              onClick={() => kind !== k.kind && onPick(k.kind)}
            >
              <TriggerIcon kind={k.kind} />
              <span className="tkx">
                <span className="tkt">
                  <b>{k.label}</b>
                  {k.isNew && <span className="wf-new">new</span>}
                </span>
                {(!compact || kind === k.kind) && <span className="help">{k.help}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A task or PR trigger (#259): its event, « Only if » filters (the project fixed to the workflow's), the loop guard. */
export function EventFields({ t, projectId, agents, set }: { t: EventTrigger; projectId: string | null; agents: Agent[]; set: SetConfig }) {
  const { byId } = useProjects();
  const choices = t.kind === 'task' ? TASK_EVENT_CHOICES : PR_EVENT_CHOICES;
  const on = eventChoiceOf(t);
  // Rows being edited, an empty value included (a new filter); the trigger keeps only the filled ones.
  const [rows, setRows] = useState<FilterRow[]>(() => filterRows(t));
  useEffect(() => {
    setRows((r) => {
      const filled = r.filter((x) => x.value);
      const now = filterRows(t);
      return JSON.stringify(filled) === JSON.stringify(now) ? r : now;
    });
  }, [t]);
  const keys = filterKeys(t);
  const put = (next: FilterRow[], key: string | null = null) => {
    setRows(next);
    set(withFilters(t, next), key);
  };
  const project = projectId ? (byId(projectId)?.name ?? projectId) : null;
  return (
    <>
      <div className="field">
        When a {t.kind === 'task' ? 'task' : 'pull request'}
        <div className="wf-events" role="radiogroup" aria-label="Event">
          {choices.map((x) => (
            <button key={x.key} type="button" role="radio" aria-checked={on === x.key} className={on === x.key ? 'on' : ''} onClick={() => set(withEvent(t, x))}>
              {x.label}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        Only if
        <div className="wf-filters">
          <div className="wf-flt">
            <span className="fx">Project</span>
            <span className="muted">is</span>
            <span className="fx">{project ?? 'any (Global)'}</span>
            <span className="muted lock" title="A workflow sees only its project's tasks and pull requests">
              fixed
            </span>
          </div>
          {rows.map((r, i) => (
            <div key={i} className="wf-flt">
              <select aria-label="Filter on" value={r.key} onChange={(e) => put(rows.map((x, j) => (j === i ? { key: e.target.value as FilterKey, value: '' } : x)))}>
                {keys.map((k) => (
                  <option key={k} value={k}>
                    {FILTER_LABEL[k]}
                  </option>
                ))}
              </select>
              <span className="muted">is</span>
              <FilterValue row={r} agents={agents} onChange={(v, typing) => put(rows.map((x, j) => (j === i ? { ...x, value: v } : x)), typing ? `filter${i}` : null)} />
              <button type="button" className="sd-btn" aria-label="Remove filter" onClick={() => put(rows.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="btn ghost small wf-addflt" onClick={() => setRows([...rows, { key: keys.find((k) => !rows.some((r) => r.key === k)) ?? keys[0]!, value: '' }])}>
            + Add a filter
          </button>
        </div>
        <span className="help">Exact tests, no model. Several values of one field: any of them.</span>
      </div>
      <label className="field">
        Loop guard
        <span className="wf-guardfld">
          At most
          <input
            type="number"
            min={1}
            max={100}
            aria-label="Runs per hour at most"
            value={t.maxRunsPerHour}
            onChange={(e) => set({ ...t, maxRunsPerHour: Math.min(100, Math.max(1, Math.round(+e.target.value) || 1)) }, 'guard')}
          />
          runs on the same {t.kind === 'task' ? 'task' : 'task or PR'} per hour
        </span>
      </label>
    </>
  );
}

function FilterValue({ row, agents, onChange }: { row: FilterRow; agents: Agent[]; onChange(v: string, typing?: boolean): void }) {
  if (row.key === 'status' || row.key === 'from')
    return (
      <select aria-label="Value" value={row.value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Pick a status</option>
        {CARD_STATUSES.filter((x) => x !== 'archived').map((x) => (
          <option key={x} value={x}>
            {STATUS_LABEL[x]}
          </option>
        ))}
      </select>
    );
  if (row.key === 'assignee')
    return (
      <select aria-label="Value" value={row.value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Pick an agent</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            @{a.id}
          </option>
        ))}
      </select>
    );
  if (row.key === 'result')
    return (
      <select aria-label="Value" value={row.value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Pick a result</option>
        <option value="success">validated</option>
        <option value="failure">refused</option>
      </select>
    );
  return <input aria-label="Value" value={row.value} placeholder={row.key === 'repo' ? 'owner/name' : 'main'} onChange={(e) => onChange(e.target.value.trim(), true)} />;
}

/** « The run gets »: what its steps can use with « Insert a field ». */
export function RunGets({ t, hasProject }: { t: TriggerConfig; hasProject: boolean }) {
  const gets = runGets(t, hasProject);
  if (!gets.length) return null;
  return (
    <div className="field">
      The run gets
      <span className="wf-gets">
        {gets.map((g) => (
          <code key={g}>{`{{${g}}}`}</code>
        ))}
        {t.kind === 'pr' && <span className="help">the PR's task, when it has one</span>}
      </span>
      <span className="help">Usable in every step's prompt and question, with « Insert a field ».</span>
    </div>
  );
}

const TRIGGER_ICON: Record<TriggerKind, React.ReactNode> = {
  time: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </>
  ),
  task: (
    <>
      <rect x="2" y="2.5" width="3.2" height="11" rx="1" />
      <rect x="6.6" y="2.5" width="3.2" height="7" rx="1" />
      <rect x="11.2" y="2.5" width="2.8" height="4.5" rx="1" />
    </>
  ),
  pr: (
    <>
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6" />
    </>
  ),
  webhook: (
    <>
      <circle cx="8" cy="4" r="2" />
      <circle cx="3.5" cy="12" r="2" />
      <circle cx="12.5" cy="12" r="2" />
      <path d="M7 5.8 4.6 10.2M5.5 12h5M9 5.8l2.4 4.2" />
    </>
  ),
  manual: <path d="M5.5 8V3.5a1.2 1.2 0 0 1 2.4 0V7.5M7.9 7V2.8a1.2 1.2 0 0 1 2.4 0V7.5M10.3 7.2V4.3a1.2 1.2 0 0 1 2.4 0v5.2a4.6 4.6 0 0 1-4.6 4.6H7.6a4 4 0 0 1-3.1-1.5L2.6 10.2a1.2 1.2 0 0 1 1.9-1.5L5.5 10" />,
};
/** The trigger's icon (#259): clock, tasks, pull request, webhook, hand. */
export function TriggerIcon({ kind }: { kind: TriggerKind }) {
  return (
    <span className={'wf-ico trig-' + kind}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {TRIGGER_ICON[kind]}
      </svg>
    </span>
  );
}

/** The step's exits: where each one leads, with a picker to wire or unwire it (the same as dragging on the canvas). */
function Exits({ n, g, change }: { n: WorkflowNode; g: Graph; change: Change }) {
  const targets = g.nodes.filter((x) => x.kind !== 'trigger' && x.id !== n.id);
  return (
    <div className="wf-exits">
      <span className="lbl">Exits</span>
      {exitsOf(n, g.edges).map((x) => (
        <label key={x.exit} className="row">
          <span className={'name' + (x.failing ? ' fail' : '')}>{x.exit}</span>
          <span className="arr" aria-hidden="true">
            →
          </span>
          <select aria-label={`${x.exit} leads to`} value={x.to ?? ''} onChange={(e) => change(wire(g, n.id, x.exit, e.target.value || null))}>
            <option value="">{exitTarget({ ...x, to: null }, g.nodes)}</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {nodeTitle(t, g.nodes)}
              </option>
            ))}
          </select>
        </label>
      ))}
      <p className="wf-sum">Or drag from an exit's dot onto a step. Click a link to remove it.</p>
    </div>
  );
}
