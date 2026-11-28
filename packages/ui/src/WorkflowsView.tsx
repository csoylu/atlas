import { useEffect, useMemo, useState } from 'react';
import { type Agent, type Card, type CreateWorkflow, type TriggerConfig, type Workflow, type WorkflowNode } from '@atlas/shared';
import { api } from './api.ts';
import { AgentFace } from './AgentFace.tsx';
import { HeaderActions } from './ScreenHeader.tsx';
import { effectiveFilter, inFilter, ProjectFilterButton, ProjTag, projectForNew, useProjectFilter, useProjects } from './projects.tsx';
import type { MessageStream } from './useMessages.ts';
import { WorkflowCanvas } from './WorkflowCanvas.tsx';
import { EventFields, RunGets, TriggerIcon, TriggerPick } from './WorkflowStepPanel.tsx';
import { BROWSER_TZ, RUN_LABEL, blankTrigger, chainOf, describeTrigger, listGroup, loopGuardHit, nodeTitle, refOf, relative, runStrip, runTask, STATE_LABEL, TEMPLATES, type ListGroup, type Template, when } from './workflowView.ts';

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
    if (!open) return <div className="agents-view"><div className="state-empty">{workflows.length ? 'This workflow does not exist (deleted?).' : 'Loading…'} <a href="#/workflows">All workflows</a></div></div>;
    const [mode, runId] = props.rest.split('/');
    return (
      <WorkflowCanvas
        key={open.id}
        workflow={open}
        agents={props.agents}
        cards={props.cards}
        mode={mode === 'runs' ? 'runs' : 'edit'}
        runId={mode === 'runs' ? (runId ?? null) : null}
        initialSelect={mode === 'step' ? (runId ?? null) : select}
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
  const [pastOpen, setPastOpen] = useState(false);
  const pinfo = useProjects();
  const [pfRaw, setPf] = useProjectFilter();
  const pf = effectiveFilter(pfRaw, pinfo);
  const hasArchived = pinfo.all.some((p) => p.status === 'archived');
  // « Archived »: archived projects' workflows (off), fetched on demand; the app's list has active projects only.
  const [archived, setArchived] = useState<Workflow[]>([]);
  const { onError } = props;
  useEffect(() => {
    if (hasArchived) api.workflows(true).then((ws) => setArchived(ws.filter((w) => pinfo.byId(w.projectId)?.status === 'archived')), onError);
  }, [hasArchived, pinfo, onError]);
  const pool = pf === 'archived' ? archived : props.workflows;
  const shown = useMemo(() => pool.filter((w) => inFilter(pf, w.projectId, pinfo, true)), [pool, pf, pinfo]);
  const groups = useMemo(() => {
    const sorted = shown.slice().sort((a, b) => (a.nextRunAt ?? '~').localeCompare(b.nextRunAt ?? '~') || a.createdAt.localeCompare(b.createdAt));
    const g: Record<ListGroup, Workflow[]> = { on: [], off: [], past: [] };
    for (const w of sorted) g[listGroup(w)].push(w);
    return g;
  }, [shown]);
  const row = (w: Workflow) => <WorkflowRow key={w.id} w={w} cards={props.cards} onOpen={() => props.go('#/workflows/' + w.id)} onOpenCard={props.onOpenCard} onError={props.onError} />;
  return (
    <div className="wfl-view">
      {!props.creating && (
        <HeaderActions>
          <span className="head-sp" />
          <ProjectFilterButton value={pf} onChange={setPf} count={(f) => (f === 'archived' ? archived.length : props.workflows.filter((w) => inFilter(f, w.projectId, pinfo, true)).length)} />
          <button className="btn primary" onClick={() => props.setCreating(true)}>
            New workflow
          </button>
        </HeaderActions>
      )}
      <div className="wfl-inner">
        {props.creating && <NewWorkflow project={projectForNew(pf, pinfo)?.id ?? null} agents={props.agents} onCancel={() => props.setCreating(false)} onCreated={props.onCreated} onError={props.onError} />}
        {!props.workflows.length && !props.creating && <EmptyWorkflows agents={props.agents} onCreated={props.onCreated} onScratch={() => props.setCreating(true)} onError={props.onError} />}
        {props.workflows.length > 0 && !shown.length && !props.creating && <div className="state-empty">No workflow in this project yet.</div>}
        {groups.on.length > 0 && (
          <section className="wfl-group">
            <div className="wfl-ghead">
              <span>On</span>
              <span className="n">{groups.on.length}</span>
            </div>
            <div className="wfl-list">
              <div className="wfl-cols" aria-hidden="true">
                <span>Workflow</span>
                <span>Last runs</span>
                <span>Next run</span>
                <span />
              </div>
              {groups.on.map(row)}
            </div>
          </section>
        )}
        {groups.off.length > 0 && (
          <section className="wfl-group">
            <div className="wfl-ghead">
              <span>Off</span>
              <span className="n">{groups.off.length}</span>
            </div>
            <div className="wfl-list">{groups.off.map(row)}</div>
          </section>
        )}
        {groups.past.length > 0 && (
          <section className={'wfl-group' + (pastOpen ? '' : ' folded')}>
            <button className="wfl-ghead" aria-expanded={pastOpen} onClick={() => setPastOpen(!pastOpen)}>
              <svg className="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m4 6 4 4 4-4" />
              </svg>
              <span>Past</span>
              <span className="n">{groups.past.length}</span>
              <span className="wfl-hint">· one-off workflows that already ran</span>
            </button>
            {pastOpen && <div className="wfl-list">{groups.past.map(row)}</div>}
          </section>
        )}
      </div>
    </div>
  );
}

const TRIG_ICON = {
  clock: (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8V8l2.2 1.4" />
    </svg>
  ),
  once: (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </svg>
  ),
  hand: (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 3.2v9.6L12.6 8z" />
    </svg>
  ),
};
const PLAY = (
  <svg className="icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 3.2v9.6L12.6 8z" />
  </svg>
);

/** The trigger in plain words with its icon. */
function TriggerText({ t, bare }: { t: TriggerConfig | null; bare?: boolean }) {
  if (!t) return <span className="part trig">no trigger</span>;
  const icon = t.kind !== 'time' ? TRIG_ICON.hand : t.repeat === 'at' ? TRIG_ICON.once : TRIG_ICON.clock;
  return (
    <span className="part trig">
      {!bare && icon}
      {t.kind === 'manual' ? 'By hand' : describeTrigger(t)}
      {t.kind === 'time' && t.repeat === 'cron' && t.timezone !== BROWSER_TZ && <span className="muted">({t.timezone})</span>}
    </span>
  );
}

/** One token of a row's chain: an agent's face and @id (or the step's title when it has no agent), « your OK », a condition's title. */
function ChainStep({ n, nodes }: { n: WorkflowNode; nodes: WorkflowNode[] }) {
  if (n.kind === 'agent')
    return n.config.agentId ? (
      <span className="who">
        <AgentFace id={n.config.agentId} />@{n.config.agentId}
      </span>
    ) : (
      <span>{nodeTitle(n, nodes)}</span>
    );
  if (n.kind === 'approval') return <span>your OK</span>;
  return <span>{nodeTitle(n, nodes)}</span>;
}

function WorkflowRow(props: { w: Workflow; cards: Card[]; onOpen(): void; onOpenCard(id: string): void; onError(e: unknown): void }) {
  const { w, onError } = props;
  const [busy, setBusy] = useState(false);
  const trigger = w.nodes.find((n) => n.kind === 'trigger');
  const t = trigger?.kind === 'trigger' ? trigger.config : null;
  const group = listGroup(w);
  const chain = chainOf(w);
  const only = chain.steps.length === 1 && chain.more === 0 && chain.steps[0]?.kind === 'agent' ? chain.steps[0] : null;
  const how = only?.kind === 'agent' ? (only.config.newTaskEachRun ? 'new task each run' : 'one task, keeps history') : null;
  const run = w.lastRun;
  const task = runTask(run);
  const open = run && (run.state === 'running' || run.state === 'waiting');
  const current = open ? run.steps?.findLast((s) => s.state === 'running' || s.state === 'waiting') : undefined;
  const currentNode = current ? w.nodes.find((n) => n.id === current.nodeId) : undefined;
  const guard = loopGuardHit(w);
  const failure = guard ? null : (w.lastError ?? (run?.state === 'failed' ? run.reason : null));
  const needsYou = open && current?.state === 'waiting' && current.cardId ? current : null;
  const strip = runStrip(w.recentRuns ?? []);
  return (
    <div className={'wfl-row wf-row ' + group} tabIndex={0} onClick={(e) => !(e.target as HTMLElement).closest('button, label, a, input') && props.onOpen()} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && props.onOpen()}>
      <div className="wfl-main">
        <TriggerIcon kind={t?.kind ?? 'manual'} />
        <div className="wfl-mtext">
        <div className="wfl-name" title={w.name}>
          {w.name}
          {w.origin === 'review' && (
            <span className="badge wfl-def" title="Made by Atlas for this project: Reset to default brings its steps and layout back">
              default
            </span>
          )}
        </div>
        <div className="wfl-sub">
          <TriggerText t={t} bare />
          <span className="part" aria-label="Steps">
            {chain.steps.map((n, i) => (
              <span key={n.id} className="tok">
                {i > 0 && <span className="arr" aria-hidden="true">→</span>}
                <ChainStep n={n} nodes={w.nodes} />
              </span>
            ))}
            {chain.more > 0 && <span className="sep">+{chain.more} more</span>}
            {!chain.steps.length && <span>no step yet</span>}
            {how && (
              <>
                <span className="sep">·</span>
                <span>{how}</span>
              </>
            )}
          </span>
          <ProjTag id={w.projectId} global />
        </div>
        {failure && (
          <div className="wfl-err">
            <b>{w.lastError ? 'Could not start.' : 'Last run failed.'}</b> {failure}
          </div>
        )}
        {guard && (
          <div className="wfl-alert bad" role="status">
            <span>
              <b>Stopped by the loop guard:</b> {w.lastError!.replace(/^loop guard: /, '')}
            </span>
            <button className="small" onClick={() => api.updateWorkflow(w.id, { enabled: true }).catch(onError)}>
              Turn on again
            </button>
          </div>
        )}
        {needsYou && currentNode && (
          <div className="wfl-alert need" role="status">
            <span>
              <b>Needs you:</b> {nodeTitle(currentNode, w.nodes)}
            </span>
            <button className="small" onClick={() => props.onOpenCard(needsYou.cardId!)}>
              Review…
            </button>
          </div>
        )}
        </div>
      </div>
      <div className="wfl-runs">
        <div className="wfl-strip" role="img" aria-label={`Last ${w.recentRuns?.length ?? 0} runs`}>
          {strip.map((s, i) => (
            <i key={i} className={s ?? ''} title={s ? RUN_LABEL[s] : undefined} />
          ))}
        </div>
        {run ? (
          <div className="wfl-last">
            <span className={'st ' + run.state}>{open && current?.state === 'waiting' ? STATE_LABEL.waiting : RUN_LABEL[run.state]}</span>
            {open && current && currentNode && run.steps && run.steps.length > 0 ? (
              <span title={nodeTitle(currentNode, w.nodes)}>{nodeTitle(currentNode, w.nodes)}</span>
            ) : (
              <span title={new Date(run.startedAt).toLocaleString()}>{relative(run.startedAt)}</span>
            )}
            {task && (
              <button className="linklike" title={`Run ${run.number}: open its task`} onClick={() => props.onOpenCard(task)}>
                → {refOf(task, props.cards)}
              </button>
            )}
          </div>
        ) : (
          <div className="wfl-last">
            <span className="none">No runs yet</span>
          </div>
        )}
      </div>
      <div className="wfl-next">
        {group === 'past' ? (
          <span>Ran once, finished</span>
        ) : guard ? (
          <>
            <b>Off</b>
            <span>stopped by the loop guard</span>
          </>
        ) : !w.enabled ? (
          <span>Off: turn it on to plan runs</span>
        ) : w.nextRunAt ? (
          <>
            <b title={new Date(w.nextRunAt).toLocaleString()}>{when(w.nextRunAt)}</b>
            <span>{relative(w.nextRunAt)}</span>
          </>
        ) : t?.kind === 'manual' ? (
          <span>Only when you click ▶</span>
        ) : t?.kind === 'task' || t?.kind === 'pr' ? (
          <span>On each matching {t.kind === 'task' ? 'task' : 'PR'} event</span>
        ) : t?.kind === 'webhook' ? (
          <span>On each call of its URL</span>
        ) : null}
      </div>
      <div className="wfl-acts">
        {group !== 'past' && (
          <>
            <button
              className="icon-btn"
              disabled={busy}
              title="Run now (the planned runs stay)"
              aria-label="Run now"
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
              {PLAY}
            </button>
            <label className="switch" title={w.enabled ? 'Turn off' : 'Turn on'}>
              <input type="checkbox" aria-label={w.enabled ? 'Turn off' : 'Turn on'} checked={w.enabled} onChange={(e) => api.updateWorkflow(w.id, { enabled: e.target.checked }).catch(onError)} />
              <span />
            </label>
          </>
        )}
      </div>
    </div>
  );
}

/** No workflow yet: what a workflow is, three examples to start from, or from scratch (#234). */
function EmptyWorkflows(props: { agents: Agent[]; onCreated(w: Workflow): void; onScratch(): void; onError(e: unknown): void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const ids = props.agents.map((a) => a.id);
  const create = (tpl: Template) => {
    setSaving(tpl.key);
    const g = tpl.build(ids);
    const manual = g.nodes.some((n) => n.kind === 'trigger' && n.config.kind === 'manual');
    api
      .createWorkflow({ ...g, enabled: manual })
      .then(props.onCreated, props.onError)
      .finally(() => setSaving(null));
  };
  return (
    <div className="wfl-empty">
      <div>
        <h2>Nothing runs on its own yet</h2>
        <p>A workflow starts at set times or when you click ▶, gives a task to an agent, and can stop for your OK before the next step. Start from an example and change it, or from scratch.</p>
      </div>
      <div className="wfl-tpls">
        {TEMPLATES.map((tpl) => {
          const g = tpl.build(ids);
          const t = g.nodes.find((n) => n.kind === 'trigger');
          const steps = chainOf(g).steps;
          return (
            <button key={tpl.key} className="wfl-tpl" disabled={!!saving} onClick={() => create(tpl)}>
              <b>{saving === tpl.key ? 'Creating…' : tpl.name}</b>
              <span className="desc">{tpl.description}</span>
              <div className="wfl-sub">
                <TriggerText t={t?.kind === 'trigger' ? t.config : null} />
                <span className="part">
                  {steps.map((n, i) => (
                    <span key={n.id} className="tok">
                      {i > 0 && <span className="arr" aria-hidden="true">→</span>}
                      <ChainStep n={n} nodes={g.nodes} />
                    </span>
                  ))}
                </span>
              </div>
            </button>
          );
        })}
      </div>
      <div className="wfl-empty-foot">
        <button className="btn" onClick={props.onScratch}>
          Start from scratch
        </button>
        <span>Runs missed while Atlas was off happen once when it starts.</span>
      </div>
    </div>
  );
}

/** « New workflow » (#259): a name, its project, how it starts (four triggers, an event's filters); then the canvas opens with one empty agent step selected. */
function NewWorkflow(props: { project: string | null; agents: Agent[]; onCancel(): void; onCreated(w: Workflow): void; onError(e: unknown): void }) {
  const pinfo = useProjects();
  const [projectId, setProjectId] = useState(props.project);
  const project = pinfo.byId(projectId);
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState<TriggerConfig>(() => blankTrigger('time', { kind: 'manual' }));
  const [saving, setSaving] = useState(false);
  const create = () => {
    setSaving(true);
    const body: CreateWorkflow = {
      name: name.trim(),
      ...(pinfo.multi && projectId ? { projectId } : {}),
      // Off until its step is filled in: a trigger would otherwise fire an empty step (Run now still works).
      enabled: trigger.kind === 'manual',
      nodes: [
        { id: 'trigger', kind: 'trigger', x: 40, y: 80, config: trigger },
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
    <div className="modal-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()} onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}>
    <form
      className="modal wf-newdlg"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wf-new-title"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create();
      }}
    >
      <div className="wf-new-head">
        <h2 id="wf-new-title">New workflow</h2>
        <button type="button" className="sd-btn" aria-label="Close" onClick={props.onCancel}>
          ×
        </button>
      </div>
      <div className="wf-new-body">
      <div className="form-grid">
        <label className="field grow">
          Name
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Fix red CI" />
        </label>
        {pinfo.multi && project && (
          <label className="field grow">
            Project
            <select value={project.id} onChange={(e) => setProjectId(e.target.value)}>
              {pinfo.active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <TriggerPick kind={trigger.kind} global={false} onPick={(k) => setTrigger(blankTrigger(k, trigger))} />
      {(trigger.kind === 'task' || trigger.kind === 'pr') && <EventFields t={trigger} projectId={projectId} agents={props.agents} set={(c) => setTrigger(c as TriggerConfig)} />}
      {trigger.kind === 'webhook' && <p className="wf-sum">Its secret URL and its « Only if » tests on the JSON body are in the trigger's panel, once it is created.</p>}
      <RunGets t={trigger} hasProject={!!projectId} />
      </div>
      <div className="wf-form-foot">
        {trigger.kind !== 'manual' && <span className="wf-sum">It starts off: add its steps, then turn it on.</span>}
        <span className="sp" />
        <button type="button" className="btn ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="btn primary small" disabled={!name.trim() || saving}>
          {saving ? 'Creating…' : 'Create and open'}
        </button>
      </div>
    </form>
    </div>
  );
}
