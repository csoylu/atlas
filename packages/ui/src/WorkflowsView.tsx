import { useEffect, useMemo, useState } from 'react';
import { type Agent, type Card, type CreateWorkflow, type Workflow, type WorkflowNode } from '@atlas/shared';
import { api } from './api.ts';
import { AgentFace } from './AgentFace.tsx';
import { HeaderActions } from './ScreenHeader.tsx';
import type { MessageStream } from './useMessages.ts';
import { WorkflowCanvas } from './WorkflowCanvas.tsx';
import { BROWSER_TZ, RUN_LABEL, chainOf, chipClass, describeTrigger, nodeRunState, nodeTitle, refOf, relative, runTask, STATE_LABEL, when } from './workflowView.ts';

/**
 * The Workflows page (#171, replaces Schedules; mockup /api/files/paris/pages/workflows-165.html): the list of workflows
 * (#/workflows) and one workflow's canvas (#/workflows/<id>, Runs mode #/workflows/<id>/runs[/<run id>]).
 */
export function WorkflowsView(props: {
  workflows: Workflow[];
  agents: Agent[];
  cards: Card[];
  /** The open workflow, or null for the list. */
  target: string | null;
  /** What follows the id: '' (Edit) or 'runs[/<run id>]'. */
  rest: string;
  stream: MessageStream;
  go(hash: string): void;
  onOpenCard(id: string): void;
  onError(e: unknown): void;
}) {
  const { workflows, target } = props;
  const [creating, setCreating] = useState(false);
  /** The step to select when the canvas opens (the empty agent step of a new workflow). */
  const [select, setSelect] = useState<string | null>(null);
  const open = target ? workflows.find((w) => w.id === target) : undefined;

  if (target) {
    if (!open) return <div className="agents-view"><div className="empty-note">{workflows.length ? 'This workflow does not exist (deleted?).' : 'Loading…'} <a href="#/workflows">All workflows</a></div></div>;
    const [mode, runId] = props.rest.split('/');
    return (
      <WorkflowCanvas
        key={open.id}
        workflow={open}
        agents={props.agents}
        cards={props.cards}
        mode={mode === 'runs' ? 'runs' : 'edit'}
        runId={mode === 'runs' ? (runId ?? null) : null}
        initialSelect={select}
        stream={props.stream}
        go={props.go}
        onOpenCard={props.onOpenCard}
        onError={props.onError}
      />
    );
  }
  return (
    <WorkflowList
      {...props}
      creating={creating}
      setCreating={setCreating}
      onCreated={(w) => {
        setCreating(false);
        setSelect(w.nodes.find((n) => n.kind === 'agent')?.id ?? null);
        props.go('#/workflows/' + w.id);
      }}
    />
  );
}

function WorkflowList(props: {
  workflows: Workflow[];
  agents: Agent[];
  cards: Card[];
  creating: boolean;
  setCreating(on: boolean): void;
  onCreated(w: Workflow): void;
  go(hash: string): void;
  onOpenCard(id: string): void;
  onError(e: unknown): void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000); // keep « in 5 min » fresh
    return () => clearInterval(t);
  }, []);
  const sorted = useMemo(
    () => props.workflows.slice().sort((a, b) => +b.enabled - +a.enabled || (a.nextRunAt ?? '~').localeCompare(b.nextRunAt ?? '~') || a.createdAt.localeCompare(b.createdAt)),
    [props.workflows],
  );
  return (
    <div className="agents-view schedules-view">
      {!props.creating && (
        <HeaderActions>
          <button className="primary small" onClick={() => props.setCreating(true)}>
            New workflow
          </button>
        </HeaderActions>
      )}
      <section>
        <header className="section-head">
          <div>
            <p>
              A trigger starts a chain of steps: an agent does a task, you approve, a condition picks the next step. Runs missed while Atlas was off happen once when
              it starts.
            </p>
          </div>
        </header>
        {props.creating && <NewWorkflow onCancel={() => props.setCreating(false)} onCreated={props.onCreated} onError={props.onError} />}
        <div className="model-list">
          {sorted.map((w) => (
            <WorkflowRow key={w.id} w={w} cards={props.cards} onOpen={() => props.go('#/workflows/' + w.id)} onOpenCard={props.onOpenCard} onError={props.onError} />
          ))}
          {!sorted.length && !props.creating && (
            <div className="empty-note">No workflows yet. Examples: a morning report on weekdays at 09:00; a task for an agent, then your approval, then a second agent.</div>
          )}
        </div>
      </section>
    </div>
  );
}

/** One token of a list row's chain. */
function ChainStep({ n, nodes, one }: { n: WorkflowNode; nodes: WorkflowNode[]; one: string | null }) {
  if (n.kind === 'agent')
    return (
      <span className="tok">
        {n.config.agentId && <AgentFace id={n.config.agentId} />}
        {n.config.agentId ? `@${n.config.agentId} · ` : ''}
        {one ?? nodeTitle(n, nodes)}
      </span>
    );
  if (n.kind === 'approval') return <span className="tok">your OK · {nodeTitle(n, nodes)}</span>;
  return <span className="tok">{nodeTitle(n, nodes)}</span>;
}

function WorkflowRow(props: { w: Workflow; cards: Card[]; onOpen(): void; onOpenCard(id: string): void; onError(e: unknown): void }) {
  const { w, onError } = props;
  const [busy, setBusy] = useState(false);
  const trigger = w.nodes.find((n) => n.kind === 'trigger');
  const t = trigger?.kind === 'trigger' ? trigger.config : null;
  const chain = chainOf(w);
  const steps = w.nodes.length - 1;
  // A one-step workflow named after its step (every migrated schedule): the step says how it runs instead.
  const only = steps === 1 && chain.steps[0]?.kind === 'agent' ? chain.steps[0] : null;
  const one = only && only.kind === 'agent' && nodeTitle(only) === w.name ? (only.config.newTaskEachRun ? 'new task each run' : 'one task, keeps history') : null;
  const run = w.lastRun;
  const task = runTask(run);
  const open = run && (run.state === 'running' || run.state === 'waiting');
  const current = open ? run.steps?.findLast((s) => s.state === 'running' || s.state === 'waiting') : undefined;
  const currentNode = current ? w.nodes.find((n) => n.id === current.nodeId) : undefined;
  const pastOnce = t?.kind === 'time' && t.repeat === 'at' && !!t.at && new Date(t.at) < new Date();
  const status = w.lastError ? 'bad' : w.enabled ? 'ok' : 'unknown';
  return (
    <div className={'model-row wf-row ' + status + (w.enabled ? '' : ' off')} onClick={(e) => !(e.target as HTMLElement).closest('button, label, a, input') && props.onOpen()}>
      <span className="dot-status" title={w.lastError ?? (w.enabled ? 'on' : 'off')} />
      <div className="model-main">
        <div className="model-title">
          <b>{w.name}</b>
          {t && <span className="badge">{describeTrigger(t)}</span>}
          {t?.kind === 'time' && t.repeat === 'cron' && t.timezone !== BROWSER_TZ && <span className="muted">({t.timezone})</span>}
          {w.origin === 'schedules' && <span className="muted">from Schedules</span>}
        </div>
        <div className="wf-chain" aria-label="Steps">
          <span className="tok">Trigger</span>
          {chain.steps.map((n) => (
            <span key={n.id} className="tok">
              <span className="arr" aria-hidden="true">→</span>
              <ChainStep n={n} nodes={w.nodes} one={one} />
            </span>
          ))}
          {chain.more > 0 && <span className="tok muted">+{chain.more} more</span>}
          {!chain.steps.length && <span className="tok"><span className="arr" aria-hidden="true">→</span>no step yet</span>}
        </div>
        <div className="model-detail">
          {w.enabled && w.nextRunAt ? (
            <span title={new Date(w.nextRunAt).toLocaleString()}>
              next <b>{when(w.nextRunAt)}</b> <span className="muted">· {relative(w.nextRunAt)}</span>
            </span>
          ) : t?.kind === 'manual' ? null : (
            <span className="muted">{pastOnce && w.lastFiredAt ? 'done' : 'off'}</span>
          )}
          {run && (
            <span className={'st-chip ' + chipClass(open && current ? nodeRunState(run, current.nodeId).state : run.state)}>
              {open && current ? `${current.state === 'waiting' ? STATE_LABEL.waiting : 'Running'} · ${currentNode ? nodeTitle(currentNode, w.nodes) : current.nodeId}` : RUN_LABEL[run.state]}
            </span>
          )}
          {run &&
            (task ? (
              <button className="linklike" title={`Run ${run.number}, ${new Date(run.startedAt).toLocaleString()}: open its task`} onClick={() => props.onOpenCard(task)}>
                run {run.number} · {relative(run.startedAt)} → {refOf(task, props.cards)}
              </button>
            ) : (
              <span className="muted">run {run.number} · {relative(run.startedAt)}</span>
            ))}
          {steps > 1 && <span className="muted">{steps} steps</span>}
        </div>
        {(w.lastError ?? (run?.state === 'failed' ? run.reason : null)) && <div className="model-error">Last run failed: {w.lastError ?? run?.reason}</div>}
      </div>
      <div className="model-actions">
        <label className="switch" title={w.enabled ? 'Turn off' : 'Turn on'}>
          <input type="checkbox" aria-label={w.enabled ? 'Turn off' : 'Turn on'} checked={w.enabled} disabled={pastOnce && !w.enabled} onChange={(e) => api.updateWorkflow(w.id, { enabled: e.target.checked }).catch(onError)} />
          <span />
        </label>
        <button
          className="tool"
          disabled={busy}
          title="Start a run now; the planned runs stay"
          onClick={() => {
            setBusy(true);
            api
              .runWorkflow(w.id)
              .then((r) => {
                if (r.state === 'skipped' || r.state === 'failed') return onError(new Error(r.reason ?? `run ${r.state}`));
                // Like Run now on a schedule: open the task it started.
                const task = runTask(r);
                if (task) props.onOpenCard(task);
              }, onError)
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Starting…' : 'Run now'}
        </button>
        <button className="ghost" onClick={props.onOpen}>
          Open
        </button>
      </div>
    </div>
  );
}

/** « New workflow »: a name and how it starts; then the canvas opens with one empty agent step selected. */
function NewWorkflow(props: { onCancel(): void; onCreated(w: Workflow): void; onError(e: unknown): void }) {
  const [name, setName] = useState('');
  const [starts, setStarts] = useState<'time' | 'manual'>('time');
  const [saving, setSaving] = useState(false);
  const create = () => {
    setSaving(true);
    const body: CreateWorkflow = {
      name: name.trim(),
      // Off until its step is filled in: a time trigger would otherwise fire an empty step (Run now still works).
      enabled: starts === 'manual',
      nodes: [
        { id: 'trigger', kind: 'trigger', x: 40, y: 80, config: starts === 'time' ? { kind: 'time', repeat: 'cron', cron: '0 9 * * 1-5', at: null, timezone: BROWSER_TZ } : { kind: 'manual' } },
        { id: 'step1', kind: 'agent', x: 300, y: 80, config: { title: '', agentId: null, prompt: '', newTaskEachRun: true } },
      ],
      edges: [{ from: 'trigger', exit: 'start', to: 'step1' }],
    };
    api
      .createWorkflow(body)
      .then(props.onCreated, props.onError)
      .finally(() => setSaving(false));
  };
  return (
    <form
      className="model-row schedule-form wf-new"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create();
      }}
    >
      <label className="field">
        Name
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Weekly dependency check" />
      </label>
      <div className="field">
        Starts
        <div className="wf-trig-pick" role="radiogroup" aria-label="How it starts">
          <button type="button" role="radio" aria-checked={starts === 'time'} className={starts === 'time' ? 'on' : ''} onClick={() => setStarts('time')}>
            At set times<span>Every day, weekdays, weekly, hourly, once, or cron</span>
          </button>
          <button type="button" role="radio" aria-checked={starts === 'manual'} className={starts === 'manual' ? 'on' : ''} onClick={() => setStarts('manual')}>
            Only by hand<span>Run now, from here</span>
          </button>
        </div>
      </div>
      {starts === 'time' && <p className="wf-sum">It starts off: set the time and the step on the canvas, then turn it on.</p>}
      <div className="wf-form-foot">
        <button type="button" className="ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="primary small" disabled={!name.trim() || saving}>
          {saving ? 'Creating…' : 'Create and open the canvas'}
        </button>
      </div>
    </form>
  );
}
