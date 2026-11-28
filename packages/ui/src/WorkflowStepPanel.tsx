import { useEffect, useRef, useState } from 'react';
import {
  ACTION_STATUSES,
  CARD_STATUSES,
  FIELD_TEST_OPS,
  WAIT_FOR,
  workflowExits,
  type ActionConfig,
  type ConditionTryResult,
  type FieldTest,
  type FieldTestOp,
  type WaitFor,
  type WorkflowRun,
  type Agent,
  type TriggerConfig,
  type Workflow,
  type WorkflowField,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
} from '@atlas/shared';
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
  envOf,
  hasRunTask,
  incomingOf,
  limitParts,
  UNIT_MIN,
} from './workflowView.ts';
import { BROWSER_TZ, DAYS, KIND_LABEL, cronOf, exitTarget, exitsOf, freeSpot, newNodeId, nodeMeta, nodeTitle, timeDraftOf, triggerOf, when, wire, withoutNode, type Repeat, type TimeDraft } from './workflowView.ts';
import { EmptyState } from './Kit.tsx';

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
  // A change of what a step does can change its exits (an action that merges: merged / refused): links from an exit
  // that no longer exists go, else the save is refused.
  const set: SetConfig = (config, key = null) => {
    const next = { ...n, config } as WorkflowNode;
    const exits = workflowExits(next);
    props.change({ nodes: g.nodes.map((m) => (m.id === n.id ? next : m)), edges: g.edges.filter((e) => e.from !== n.id || exits.includes(e.exit)) }, key && `${n.id}:${key}`);
  };
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
        {n.kind === 'agent' && <AgentFields n={n} g={g} w={props.w} agents={props.agents} fields={fields} set={set} />}
        {n.kind === 'approval' && <ApprovalFields n={n} fields={fields} set={set} />}
        {n.kind === 'condition' && <ConditionFields n={n} g={g} w={props.w} set={set} onError={props.onError} />}
        {n.kind === 'action' && <ActionFields n={n} g={g} w={props.w} agents={props.agents} fields={fields} set={set} />}
        {n.kind === 'wait' && <WaitFields n={n} g={g} set={set} />}
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
        {fields.list && !groups.length && <EmptyState inline title="No field matches" />}
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

/**
 * An agent step (#262; #334 mockup): one agent picker (the project's members), in the task thread (the run's task: its
 * history and PR stay) or as a task of its own, and « Verdict on the PR » (thread only): its agent gets pr_validate and
 * the exits are approved / changes asked. Generic: nothing here knows the Review workflow.
 */
function AgentFields({ n, g, w, agents, fields, set }: { n: Extract<WorkflowNode, { kind: 'agent' }>; g: Graph; w: Workflow; agents: Agent[]; fields: FieldsOf; set: SetConfig }) {
  const c = n.config;
  const { byId } = useProjects();
  const project = w.projectId ? byId(w.projectId) : undefined;
  const thread = !!c.inThread;
  const canThread = hasRunTask(g);
  // The project's members (a workflow of no project: every agent); the one chosen stays listed, marked, if it no longer fits.
  const members = project ? agents.filter((a) => project.members.some((m) => m.agentId === a.id)) : agents;
  const chosen = c.agentId ? agents.find((a) => a.id === c.agentId) : undefined;
  const problem = !c.agentId
    ? null
    : !chosen
      ? 'missing'
      : !chosen.enabled
        ? 'off'
        : project && !members.some((a) => a.id === c.agentId)
          ? `not in ${project.name}`
          : null;
  return (
    <>
      <label className="field">
        Title
        <input value={c.title} placeholder={c.prompt.trim().split('\n')[0]?.slice(0, 80) || 'Review the PR'} onChange={(e) => set({ ...c, title: e.target.value }, 'title')} />
      </label>
      <PromptField
        fields={fields}
        label="Prompt"
        value={c.prompt}
        placeholder="What the agent should do, e.g. « Check the dependencies and open a PR for the safe updates. »"
        onChange={(v) => set({ ...c, prompt: v }, 'prompt')}
      />
      <label className="field">
        Agent
        <select aria-label="Agent" className={c.agentId ? undefined : 'bad'} value={c.agentId ?? ''} onChange={(e) => set({ ...c, agentId: e.target.value || null })}>
          {!c.agentId && <option value="">Pick an agent</option>}
          {members.map((a) => (
            <option key={a.id} value={a.id}>
              @{a.id} · {a.rolePrompt.trim().split('\n')[0] || 'no role'}
            </option>
          ))}
          {problem && c.agentId && <option value={c.agentId}>@{c.agentId} ({problem})</option>}
        </select>
        {!c.agentId && (
          <span className="help bad">
            <b>No agent.</b> A run stops here: « couldn't run: no agent chosen ».
          </span>
        )}
        {problem && <span className="help warn">{problem === 'off' ? `@${c.agentId} is off: runs stop here until you turn it on or choose another.` : problem === 'missing' ? `@${c.agentId} no longer exists: runs stop here until you choose another.` : `@${c.agentId} is not a member of ${project!.name}: runs stop here until you add it or choose another.`}</span>}
      </label>
      <div className="field">
        Works
        <div className="segmented">
          <button
            type="button"
            className={thread ? 'on' : ''}
            aria-pressed={thread}
            disabled={!canThread && !thread}
            title={!canThread ? 'Needs a run about a task: start the workflow on a task or PR event' : undefined}
            onClick={() => !thread && set({ ...c, inThread: true })}
          >
            In the task thread
          </button>
          <button
            type="button"
            className={!thread ? 'on' : ''}
            aria-pressed={!thread}
            onClick={() => thread && set({ ...c, inThread: undefined, verdict: undefined })}
          >
            As a new task
          </button>
        </div>
        <span className="help">
          {thread
            ? 'In the thread of the task that started the run: its history and PR stay, its assignee stays.'
            : 'A task of its own, assigned to the agent.'}
        </span>
      </div>
      {!thread && (
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
      )}
      <label className={'wf-switch-row' + (thread ? '' : ' off')}>
        <span className="tkx">
          <b>Verdict on the PR</b>
          <span className="help">
            {!thread
              ? "Only in the task thread: the verdict goes on the PR of the run's task."
              : c.verdict
                ? `${c.agentId ? `@${c.agentId}` : 'Its agent'} gets pr_validate. Exits: approved / changes asked.`
                : 'On: its agent gets pr_validate, and the exits become approved / changes asked.'}
          </span>
        </span>
        <span className="switch">
          <input type="checkbox" aria-label="Verdict on the PR" checked={thread && !!c.verdict} disabled={!thread} onChange={(e) => set({ ...c, verdict: e.target.checked || undefined })} />
          <span />
        </span>
      </label>
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

const OP_LABEL: Record<FieldTestOp, string> = { is: 'is', isNot: 'is not', contains: 'contains', notContains: 'does not contain', isEmpty: 'is empty', isNotEmpty: 'is not empty', gt: 'more than', lt: 'less than' };
const noValue = (op: FieldTestOp) => op === 'isEmpty' || op === 'isNotEmpty';

/** A condition (#262, mockup « Condition »): tests on the run's fields (or a summary, or rounds), tried on a past run. */
function ConditionFields({ n, g, w, set, onError }: { n: Extract<WorkflowNode, { kind: 'condition' }>; g: Graph; w: Workflow; set: SetConfig; onError(e: unknown): void }) {
  const c = n.config;
  const steps = g.nodes.filter((x) => x.kind !== 'trigger' && x.id !== n.id);
  const fields = useFields(w.id, n.id);
  const firstField = fields.list?.[0]?.field ?? 'task.status';
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
            className={c.test === 'fields' ? 'on' : ''}
            aria-pressed={c.test === 'fields'}
            onClick={() => c.test !== 'fields' && set({ test: 'fields', title: c.title, match: 'all', tests: [{ field: firstField, op: 'is', value: '' }] })}
          >
            Fields
          </button>
          <button type="button" className={c.test === 'summaryContains' ? 'on' : ''} aria-pressed={c.test === 'summaryContains'} onClick={() => c.test !== 'summaryContains' && set({ test: 'summaryContains', title: c.title, text: 'OK' })}>
            Summary has
          </button>
          <button
            type="button"
            className={c.test === 'ranFewer' ? 'on' : ''}
            aria-pressed={c.test === 'ranFewer'}
            onClick={() => c.test !== 'ranFewer' && set({ test: 'ranFewer', title: c.title, node: steps[0]?.id ?? 'trigger', times: 3 })}
          >
            Rounds
          </button>
        </div>
      </div>
      {c.test === 'fields' && (
        <div className="field">
          Yes when
          <div className="segmented wf-match">
            <button type="button" className={c.match === 'all' ? 'on' : ''} aria-pressed={c.match === 'all'} onClick={() => set({ ...c, match: 'all' })}>
              all
            </button>
            <button type="button" className={c.match === 'any' ? 'on' : ''} aria-pressed={c.match === 'any'} onClick={() => set({ ...c, match: 'any' })}>
              any
            </button>
          </div>
          <div className="wf-filters">
            {c.tests.map((t, i) => {
              const put = (x: FieldTest, key: string | null = null) => set({ ...c, tests: c.tests.map((y, j) => (j === i ? x : y)) }, key);
              const known = fields.list?.some((f) => f.field === t.field);
              return (
                <div key={i} className="wf-flt wf-test">
                  <select aria-label="Field" value={t.field} onChange={(e) => put({ ...t, field: e.target.value })}>
                    {fields.list?.map((f) => (
                      <option key={f.field} value={f.field}>
                        {f.label}
                      </option>
                    ))}
                    {!known && <option value={t.field}>{t.field}</option>}
                  </select>
                  <select aria-label="Test" value={t.op} onChange={(e) => put({ ...t, op: e.target.value as FieldTestOp, value: noValue(e.target.value as FieldTestOp) ? '' : t.value })}>
                    {FIELD_TEST_OPS.map((o) => (
                      <option key={o} value={o}>
                        {OP_LABEL[o]}
                      </option>
                    ))}
                  </select>
                  {noValue(t.op) ? (
                    <span />
                  ) : (
                    <input aria-label="Value" value={t.value} inputMode={t.op === 'gt' || t.op === 'lt' ? 'decimal' : undefined} onChange={(e) => put({ ...t, value: e.target.value }, `test${i}`)} />
                  )}
                  <button type="button" className="sd-btn" aria-label="Remove test" disabled={c.tests.length === 1} onClick={() => set({ ...c, tests: c.tests.filter((_, j) => j !== i) })}>
                    ✕
                  </button>
                </div>
              );
            })}
            {c.tests.length < 20 && (
              <button type="button" className="ghost small wf-addflt" onClick={() => set({ ...c, tests: [...c.tests, { field: firstField, op: 'is', value: '' }] })}>
                + Add a test
              </button>
            )}
          </div>
          <span className="help">
            Exact tests, no model: is, is not, contains, is empty, more / less than. A value is the text typed here: it does not follow another step (change the agent of a step, change its name here too).
          </span>
        </div>
      )}
      {c.test === 'ranFewer' && (
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
      )}
      {c.test === 'summaryContains' && (
        <label className="field">
          Yes when the previous step's summary contains
          <input value={c.text} onChange={(e) => e.target.value && set({ ...c, text: e.target.value }, 'text')} />
        </label>
      )}
      {c.test === 'fields' ? <TryOnRun w={w} config={c} labels={fields.list} onError={onError} /> : <p className="wf-sum">Nothing is judged by a model: the test is exact.</p>}
    </>
  );
}

/** « With run N »: the condition's tests on a past run's fields (POST /try-condition), before saving (#262). */
function TryOnRun({ w, config, labels, onError }: { w: Workflow; config: Extract<WorkflowNode, { kind: 'condition' }>['config']; labels: WorkflowField[] | null; onError(e: unknown): void }) {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [run, setRun] = useState<string | null>(null);
  const [res, setRes] = useState<{ ok: ConditionTryResult } | { error: string } | null>(null);
  const err = useRef(onError);
  err.current = onError;
  useEffect(() => {
    api.workflowRuns(w.id).then(
      (rs) => {
        const ran = rs.filter((r) => r.state !== 'skipped').slice(0, 20);
        setRuns(ran);
        setRun((x) => x ?? ran[0]?.id ?? null);
      },
      (e) => err.current(e),
    );
  }, [w.id]);
  const key = JSON.stringify(config);
  useEffect(() => {
    if (!run) return;
    // Typing a value: try once it rests.
    const t = setTimeout(() => {
      api.tryCondition(w.id, { run, config }).then(
        (ok) => setRes({ ok }),
        (e: Error) => setRes({ error: e.message }),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [run, key]);
  if (!runs) return null;
  if (!runs.length) return <EmptyState inline title="No run yet to try it on" />;
  const label = (f: string) => labels?.find((x) => x.field === f)?.label ?? f;
  return (
    <div className="field">
      <span className="wf-tryhead">
        Try on run
        <select aria-label="Try on run" value={run ?? ''} onChange={(e) => setRun(e.target.value)}>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              Run {r.number}
            </option>
          ))}
        </select>
      </span>
      {res && 'error' in res && <p className="wf-sum bad">{res.error}</p>}
      {res && 'ok' in res && (
        <div className={'wf-try ' + res.ok.exit}>
          {res.ok.tests.map((t, i) => (
            <span key={i} className={t.pass ? 'pass' : 'miss'}>
              {label(t.field)} = {t.actual ?? 'nothing'} <span aria-label={t.pass ? 'passes' : 'fails'}>{t.pass ? '✓' : '✗'}</span>
              {i < res.ok.tests.length - 1 ? ' · ' : ''}
            </span>
          ))}
          <span>
            {' '}
            → <b>{res.ok.exit}</b>
          </span>
        </div>
      )}
    </div>
  );
}

const WAIT_LABEL: Record<WaitFor, string> = { ciFinished: 'CI finished', ciGreen: 'CI green', conflict: 'A conflict', merged: 'The PR merged', unblocked: 'The task unblocked', status: 'The task changes status to…' };
const PR_WAITS: WaitFor[] = ['ciFinished', 'ciGreen', 'conflict', 'merged'];

/** A wait (#262, mockup « Wait »): an event on the run's task or PR, with a time limit. */
function WaitFields({ n, g, set }: { n: Extract<WorkflowNode, { kind: 'wait' }>; g: Graph; set: SetConfig }) {
  const c = n.config;
  const lim = limitParts(c.limitMin);
  const setLimit = (num: number, unit: keyof typeof UNIT_MIN) => set({ ...c, limitMin: Math.min(43_200, Math.max(1, Math.round(num) * UNIT_MIN[unit])) }, 'limit');
  return (
    <>
      <label className="field">
        Title
        <input value={c.title} placeholder={nodeTitle({ ...n, config: { ...c, title: '' } }, g.nodes)} onChange={(e) => set({ ...c, title: e.target.value }, 'title')} />
      </label>
      <div className="field">
        Wait for
        <div className="wf-events" role="radiogroup" aria-label="Wait for">
          {WAIT_FOR.map((x) => (
            <button key={x} type="button" role="radio" aria-checked={c.for === x} className={c.for === x ? 'on' : ''} onClick={() => set({ ...c, for: x, status: x === 'status' ? (c.status ?? 'done') : null })}>
              {WAIT_LABEL[x]}
            </button>
          ))}
        </div>
        {c.for === 'status' && (
          <select aria-label="Status" value={c.status ?? ''} onChange={(e) => set({ ...c, status: e.target.value as typeof c.status })}>
            {CARD_STATUSES.filter((x) => x !== 'archived').map((x) => (
              <option key={x} value={x}>
                {STATUS_LABEL[x]}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="field">
        On
        <span className="wf-fixed">{PR_WAITS.includes(c.for) ? "Pull request › this run's PR" : "Task › this run's task"}</span>
      </div>
      <div className="field">
        At most
        <div className="wf-limit">
          <input type="number" aria-label="Time limit" min={1} value={lim.n} onChange={(e) => setLimit(+e.target.value || 1, lim.unit)} />
          <select aria-label="Unit" value={lim.unit} onChange={(e) => setLimit(lim.n, e.target.value as keyof typeof UNIT_MIN)}>
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
        <span className="help">Already true when the step starts? It goes on at once. A wait costs nothing (no model, no process) and survives a restart.</span>
      </div>
    </>
  );
}

const DO_LABEL: Record<ActionConfig['do'], string> = { setStatus: 'Set the task status', setAssignee: 'Set the assignee', mergePr: 'Validate + merge the PR', notify: 'Notify Master', command: 'Run a command' };
const DOS = ['setStatus', 'setAssignee', 'mergePr', 'notify', 'command'] as const;

/** An action (#262, mockup « Action »): Atlas does it, no model. « Run a command » needs Master's OK. */
function ActionFields({ n, g, w, agents, fields, set }: { n: Extract<WorkflowNode, { kind: 'action' }>; g: Graph; w: Workflow; agents: Agent[]; fields: FieldsOf; set: SetConfig }) {
  const c = n.config;
  const { byId } = useProjects();
  const pick = (d: ActionConfig['do']) => {
    if (d === c.do) return;
    const title = c.title;
    if (d === 'setStatus') set({ do: d, title, status: 'ready', note: '' });
    else if (d === 'setAssignee') set({ do: d, title, assignee: null, note: '' });
    else if (d === 'mergePr') set({ do: d, title });
    else if (d === 'notify') set({ do: d, title, text: 'Run {{run.number}} of {{workflow.name}}' });
    else set({ do: d, title, command: 'echo "$TASK_REF"', secrets: [], limitMin: 10 });
  };
  const incoming = incomingOf(n, g);
  const approval = w.commandSteps.find((x) => x.nodeId === n.id);
  const repo = w.projectId ? byId(w.projectId)?.repo : null;
  return (
    <>
      <label className="field">
        Title
        <input value={c.title} placeholder={nodeTitle({ ...n, config: { ...c, title: '' } }, g.nodes)} onChange={(e) => set({ ...c, title: e.target.value }, 'title')} />
      </label>
      <div className="field">
        Do
        <div className="wf-tks compact" role="radiogroup" aria-label="Do">
          {DOS.map((d) => (
            <button key={d} type="button" role="radio" aria-checked={c.do === d} className={'wf-tk' + (c.do === d ? ' on' : '')} onClick={() => pick(d)}>
              <span className="tkx">
                <span className="tkt">
                  <b>{DO_LABEL[d]}</b>
                  {d === 'command' && <span className="wf-ok-chip">needs your OK</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
      {c.do === 'setStatus' && (
        <>
          <label className="field">
            Status
            <select value={c.status} onChange={(e) => set({ ...c, status: e.target.value as typeof c.status })}>
              {ACTION_STATUSES.map((x) => (
                <option key={x} value={x}>
                  {STATUS_LABEL[x]}
                </option>
              ))}
            </select>
          </label>
          <PromptField fields={fields} label="Note" value={c.note} placeholder="Optional: a note in the task's thread, e.g. {{previous.summary}}" onChange={(v) => set({ ...c, note: v }, 'note')} />
        </>
      )}
      {c.do === 'setAssignee' && (
        <>
          <label className="field">
            Assignee
            <select value={c.assignee ?? ''} onChange={(e) => set({ ...c, assignee: e.target.value || null })}>
              <option value="">Nobody</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.id}
                </option>
              ))}
              {c.assignee && !agents.some((a) => a.id === c.assignee) && <option value={c.assignee}>@{c.assignee} (missing)</option>}
            </select>
          </label>
          <PromptField fields={fields} label="Note" value={c.note} placeholder="Optional: a note in the task's thread" onChange={(v) => set({ ...c, note: v }, 'note')} />
        </>
      )}
      {c.do === 'mergePr' && <p className="wf-sum">Validates and merges the run's pull request with the project's gate, the same as pr_validate. GitHub saying no (a conflict, red CI) is the « refused » exit.</p>}
      {c.do === 'notify' && <PromptField fields={fields} label="Text" value={c.text} placeholder="What you read in the Inbox" onChange={(v) => v.trim() && set({ ...c, text: v }, 'text')} />}
      {c.do === 'command' && (
        <>
          <label className="field">
            Command
            <textarea className="mono" rows={4} value={c.command} spellCheck={false} onChange={(e) => e.target.value.trim() && set({ ...c, command: e.target.value }, 'command')} />
            <span className="help">
              Runs with bash in a clean checkout of {repo ?? "the project's repo"} (default branch). Every run field is an environment variable, never pasted into the text: {'{{task.ref}}'} →{' '}
              <code>${envOf('task.ref')}</code>, {'{{payload.after}}'} → <code>${envOf('payload.after')}</code>.
            </span>
          </label>
          <label className="field">
            Secrets
            <input className="mono" value={c.secrets.join(', ')} placeholder="VERCEL_TOKEN" onChange={(e) => set({ ...c, secrets: e.target.value.split(/[\s,]+/).filter(Boolean) }, 'secrets')} />
            <span className="help">Names from Settings → Secrets, given to this step only.</span>
          </label>
          <label className="field">
            Time limit (minutes)
            <input type="number" min={1} max={120} value={c.limitMin} onChange={(e) => set({ ...c, limitMin: Math.min(120, Math.max(1, Math.round(+e.target.value) || 1)) }, 'limit')} />
          </label>
          <p className={'wf-sum' + (approval?.approved ? '' : ' warn')}>
            {approval?.approved
              ? `Approved by ${approval.approvedBy === 'user' ? 'you' : `@${approval.approvedBy}`}${approval.approvedAt ? ` · ${when(approval.approvedAt)}` : ''}. An agent's later edit asks again; your own edits don't.`
              : 'Needs your OK: no run starts until you approve this command, its secrets and limit (the banner above the canvas).'}
          </p>
        </>
      )}
      {incoming.length > 0 && (
        <div className="field">
          Comes from · {incoming.length} {incoming.length === 1 ? 'exit' : 'exits'}
          <div className="wf-from">
            {incoming.map((x) => (
              <div key={x.from.id + ':' + x.exit} className={'row' + (x.failing ? ' fail' : '')}>
                <span className="xn">{x.exit}</span>
                <span className="arr" aria-hidden="true">
                  ←
                </span>
                <span className="fr">{nodeTitle(x.from, g.nodes)}</span>
              </div>
            ))}
          </div>
          <span className="help">The selected step lights up the exits that lead to it; the others dim.</span>
        </div>
      )}
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
      {exitMeaning(n) && <p className="wf-sum">{exitMeaning(n)}</p>}
      <p className="wf-sum">Or drag from an exit's dot onto a step. Click a link to remove it.</p>
    </div>
  );
}

/** What each exit of an agent step means, one line under Exits (#334: it replaced the « Exit from the verdict » box). */
function exitMeaning(n: WorkflowNode): string | null {
  if (n.kind !== 'agent') return null;
  if (!n.config.inThread) return 'done: its task reached Done. failed: the task was closed, or its run failed.';
  if (n.config.verdict) return "approved: pr_validate ok on the PR's head. changes asked: fail; its reason becomes the note.";
  return 'done: the agent finished the work. not done: it stopped or gave up.';
}
