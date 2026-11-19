import { useEffect, useRef, useState } from 'react';
import type { Agent, Workflow, WorkflowEdge, WorkflowNode, WorkflowNodeKind } from '@atlas/shared';
import { api } from './api.ts';
import { BROWSER_TZ, DAYS, KIND_LABEL, cronOf, eventText, exitTarget, exitsOf, freeSpot, newNodeId, nodeMeta, nodeTitle, timeDraftOf, triggerOf, when, wire, withoutNode, type Repeat, type TimeDraft } from './workflowView.ts';

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
        {n.kind === 'trigger' && <TriggerFields n={n} w={props.w} set={set} />}
        {n.kind === 'agent' && <AgentFields n={n} agents={props.agents} set={set} />}
        {n.kind === 'approval' && <ApprovalFields n={n} set={set} />}
        {n.kind === 'condition' && <ConditionFields n={n} g={g} set={set} />}
        {(n.kind === 'action' || n.kind === 'wait') && <p className="wf-sum">{nodeMeta(n, g.nodes)}</p>}
        <Exits n={n} g={g} change={props.change} />
      </div>
      <div className="wf-side-foot">
        {n.kind === 'trigger' ? (
          <>
            <span className="wf-sum">The trigger can't be deleted.</span>
            <button
              className="ghost danger"
              onClick={() => confirm(`Delete workflow "${props.w.name}"? Its tasks stay.`) && api.deleteWorkflow(props.w.id).then(() => props.go('#/workflows'), props.onError)}
            >
              Delete workflow
            </button>
          </>
        ) : (
          <>
            <button
              className="ghost"
              onClick={() => props.change({ nodes: [...g.nodes, { ...n, id: newNodeId(g.nodes), ...freeSpot(g.nodes, n) } as WorkflowNode], edges: g.edges })}
            >
              Duplicate
            </button>
            <button
              className="ghost danger"
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

const VARS = ['{{previous.summary}}', '{{previous.task}}', '{{run.id}}'];

/** A textarea with the three variables to insert at the cursor. */
function PromptField(props: { label: string; value: string; placeholder: string; onChange(v: string): void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <label className="field">
        {props.label}
        <textarea ref={ref} rows={5} value={props.value} placeholder={props.placeholder} onChange={(e) => props.onChange(e.target.value)} />
      </label>
      <div className="wf-vars">
        <span>Insert</span>
        {VARS.map((v) => (
          <button
            key={v}
            type="button"
            className="wf-var"
            title={v === '{{previous.summary}}' ? "The previous step's summary" : v === '{{previous.task}}' ? "The previous step's task (#N)" : 'This run'}
            onClick={() => {
              const t = ref.current;
              const at = t ? t.selectionStart : props.value.length;
              const end = t ? t.selectionEnd : at;
              props.onChange(props.value.slice(0, at) + v + props.value.slice(end));
              requestAnimationFrame(() => {
                t?.focus();
                t?.setSelectionRange(at + v.length, at + v.length);
              });
            }}
          >
            <code>{v}</code>
          </button>
        ))}
      </div>
    </>
  );
}

function AgentFields({ n, agents, set }: { n: Extract<WorkflowNode, { kind: 'agent' }>; agents: Agent[]; set: SetConfig }) {
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

function ApprovalFields({ n, set }: { n: Extract<WorkflowNode, { kind: 'approval' }>; set: SetConfig }) {
  const c = n.config;
  return (
    <>
      <label className="field">
        Title
        <input value={c.title} placeholder="Merge it?" onChange={(e) => set({ ...c, title: e.target.value }, 'title')} />
      </label>
      <PromptField label="Question" value={c.question} placeholder="What you decide, e.g. « Merge the PR? Its summary: {{previous.summary}} »" onChange={(v) => set({ ...c, question: v }, 'question')} />
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

function TriggerFields({ n, w, set }: { n: Extract<WorkflowNode, { kind: 'trigger' }>; w: Workflow; set: SetConfig }) {
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
      <div className="field">
        Starts
        <div className="segmented">
          <button type="button" className={time ? 'on' : ''} aria-pressed={time} onClick={() => !time && set(triggerOf(d))}>
            At set times
          </button>
          <button type="button" className={!time ? 'on' : ''} aria-pressed={!time} onClick={() => time && set({ kind: 'manual' })}>
            Only by hand
          </button>
        </div>
      </div>
      {c.kind === 'manual' && <p className="wf-sum">It runs only when you press Run now (here, or an agent's run tool).</p>}
      {(c.kind === 'task' || c.kind === 'pr') && <p className="wf-sum">{eventText(c)}. Its filters are edited through the API for now.</p>}
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
          {!w.enabled && <p className="wf-sum">The workflow is off: turn it on (top right) for the trigger to fire.</p>}
        </>
      )}
    </>
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
