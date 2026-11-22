import { useCallback, useEffect, useState } from 'react';
import { type Agent, type Card, type Memory, type Model, type Settings, type Workflow } from '@atlas/shared';
import { api, ApiError } from './api.ts';
import { AgentFace } from './AgentFace.tsx';
import { HeaderActions, Icon } from './ScreenHeader.tsx';
import { SetRow, SetRows, SetSec } from './SettingsKit.tsx';
import { EmptyState, ErrorState, Skeleton } from './Kit.tsx';
import { memoryHref } from './memoryView.ts';
import { friendlyModel, friendlyModelOf } from './modelNames.ts';
import { useProjects } from './projects.tsx';
import { verdictSteps } from './workflowView.ts';

/**
 * Settings → Agents (redesign #272, mockup « Agents »): one row per agent (face, role and projects, friendly model
 * name, how many runs at once, memories, on/off), and the agent's own page at #/settings/agents/<id> with every field.
 */
export function AgentsView(props: {
  /** An agent id: its page; empty: the list. */
  rest: string;
  settings: Settings | null;
  cards: Card[];
  chats: Card[];
  onSettings(s: Settings): void;
  onAgentsChanged(): void;
  onError(e: unknown): void;
}) {
  const { onError } = props;
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const reload = useCallback(() => {
    api.agents().then(setAgents, onError);
    api.models().then(setModels, onError);
    api.memories({ status: 'active' }).then(setMemories, onError);
  }, [onError]);
  useEffect(reload, [reload]);
  const changed = () => {
    reload();
    props.onAgentsChanged();
  };

  if (props.rest) {
    const a = agents?.find((x) => x.id === props.rest);
    if (!agents) return <Skeleton rows={6} />;
    if (!a)
      return (
        <ErrorState title={`No agent @${props.rest}`} action={<a href="#/settings/agents">All agents</a>}>
          <p>It was deleted, or the link is wrong.</p>
        </ErrorState>
      );
    return <AgentPage key={a.id} agent={a} models={models} settings={props.settings} onChanged={changed} onError={onError} />;
  }
  return <AgentList agents={agents} models={models} memories={memories} settings={props.settings} cards={props.cards} chats={props.chats} onChanged={changed} onError={onError} />;
}

function AgentList(props: {
  agents: Agent[] | null;
  models: Model[];
  memories: Memory[] | null;
  settings: Settings | null;
  cards: Card[];
  chats: Card[];
  onChanged(): void;
  onError(e: unknown): void;
}) {
  const pinfo = useProjects();
  const [adding, setAdding] = useState(false);
  const busy = (id: string) => props.cards.some((c) => c.assignee === id && c.status === 'running') || props.chats.some((c) => c.assignee === id && c.working);
  return (
    <section className="set-page">
      {/* The header names the page (#307): « New agent » sits in its row. */}
      <HeaderActions>
        <span className="head-sp" />
        {!adding && (
          <button type="button" className="btn small" onClick={() => setAdding(true)}>
            <Icon.plus />
            New agent
          </button>
        )}
      </HeaderActions>
      <p className="set-lead">
        Who works on your tasks. Open one to change its role, model, folder and memory. Their models, plans and keys are in the Models group, starting with the{' '}
        <a href="#/settings/model-list">Model list</a>.
      </p>
      {adding && <NewAgent models={props.models} onCreated={() => { setAdding(false); props.onChanged(); }} onCancel={() => setAdding(false)} onError={props.onError} />}
      {!props.agents ? (
        <Skeleton rows={4} />
      ) : props.agents.length === 0 ? (
        <EmptyState title="No agent yet">Create one to give it tasks.</EmptyState>
      ) : (
        <div className="set-list agl" role="list" aria-label="Agents">
          {props.agents.map((a) => {
            const roles = [a.rolePrompt.split('\n')[0]?.trim() || 'no role', props.settings?.triageAgent === a.id && 'triage'].filter(Boolean).join(' · ');
            const projects = pinfo.active.filter((p) => p.members.some((m) => m.agentId === a.id)).map((p) => p.name);
            const mem = props.memories?.filter((m) => m.scope === 'agent:' + a.id).length;
            const model = props.models.find((m) => m.id === a.modelId);
            return (
              <div key={a.id} className={'agr' + (a.enabled ? '' : ' off')} role="listitem">
                <AgentFace id={a.id} />
                <div className="agr-main">
                  <a className="agr-open" href={'#/settings/agents/' + encodeURIComponent(a.id)}>
                    @{a.id}
                    {busy(a.id) && <span className="spin" role="img" aria-label="working" />}
                  </a>
                  <div className="agr-sub">
                    {roles}
                    {projects.length > 0 && ' · ' + projects.join(', ')}
                  </div>
                </div>
                <span className={'agr-model' + (model ? '' : ' bad')} title={model ? a.modelId : 'This model no longer exists'}>
                  {model ? friendlyModel(model.name) : a.modelId}
                </span>
                <span className="agr-n num">{a.maxRuns} at once</span>
                <span className="agr-n">{mem === undefined ? '…' : `${mem} ${mem === 1 ? 'memory' : 'memories'}`}</span>
                <span className="agr-state">{a.enabled ? '' : 'Off'}</span>
                <Icon.chev />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AgentPage(props: { agent: Agent; models: Model[]; settings: Settings | null; onChanged(): void; onError(e: unknown): void }) {
  const { agent: a, onError } = props;
  const pinfo = useProjects();
  const [draft, setDraft] = useState(a);
  const [memory, setMemory] = useState<Memory[] | null>(null);
  useEffect(() => setDraft(a), [a]);
  const [budget, setBudget] = useState<{ used: number; limit: number } | null>(null);
  useEffect(() => {
    api.memories({ scope: `agent:${a.id}`, status: 'active' }).then(setMemory, onError);
    api.memoryBudget(a.id).then(setBudget, onError);
  }, [a.id, onError]);
  // Where it gives the verdict on PRs (#334): the agent steps with « Verdict on the PR » on that chose it.
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  useEffect(() => {
    api.workflows().then(setWorkflows, onError);
  }, [onError]);
  const [confirming, setConfirming] = useState(false);
  /** Why the engine refused to delete (open cards, triage agent): shown on the page, not a far-away banner. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const remove = () =>
    api.deleteAgent(a.id).then(
      () => {
        props.onChanged();
        location.hash = '#/settings/agents';
      },
      (e: unknown) => {
        setConfirming(false);
        if (e instanceof ApiError && e.status === 409) setRefusal(e.message);
        else onError(e);
      },
    );
  const dirty = JSON.stringify(draft) !== JSON.stringify(a);
  const model = props.models.find((m) => m.id === draft.modelId);
  const projects = pinfo.active.filter((p) => p.members.some((m) => m.agentId === a.id));
  const triage = props.settings?.triageAgent === a.id;
  const verdicts = verdictSteps(workflows ?? []).filter((v) => v.agentId === a.id);
  const modelBadge = model?.lastError
    ? 'model failing'
    : model?.provider === 'chatgpt' && !model.credentialPresent
      ? 'ChatGPT not signed in'
      : model?.provider === 'claude_plan' && !model.credentialPresent
        ? 'Claude not signed in'
        : model && !model.credentialPresent && (model.credentialEnv || model.provider === 'anthropic')
          ? 'key missing'
          : null;
  return (
    <section className={'set-page agent-page' + (a.enabled ? '' : ' off')}>
      {(triage || modelBadge) && (
        <div className="set-tools">
          {triage && <span className="badge">triage</span>}
          {modelBadge && <span className="badge bad">{modelBadge}</span>}
        </div>
      )}
      <p className="set-lead">
        {projects.length ? <>Member of {projects.map((p) => p.name).join(', ')}. </> : 'Member of no project. '}
        {verdicts.length > 0 && (
          <>
            Gives the verdict on PRs in{' '}
            {verdicts.map((v, i) => (
              <span key={v.workflowId}>
                {i > 0 && (i === verdicts.length - 1 ? ' and ' : ', ')}
                <a href={`#/workflows/${encodeURIComponent(v.workflowId)}`}>{v.workflowName}</a>
                {v.projectId && ` (${pinfo.byId(v.projectId)?.name ?? v.projectId})`}
              </span>
            ))}
            .{' '}
          </>
        )}
        The triage role is set in <a href="#/settings/board">Board &amp; triage</a>.
      </p>
      <SetSec first>
        <SetRows>
          <SetRow label="Enabled" auto>
            <label className="switch" title="Enabled">
              <input type="checkbox" aria-label="Enabled" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              <span />
            </label>
          </SetRow>
          <SetRow label="Role" help="Who this agent is and what it does. The first line shows to other agents." stack>
            <textarea aria-label="Role" rows={4} value={draft.rolePrompt} onChange={(e) => setDraft({ ...draft, rolePrompt: e.target.value })} />
          </SetRow>
          <SetRow label="Model" help="Plans, keys and local models are in the Models group.">
            <select aria-label="Model" value={draft.modelId} onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}>
              {!model && <option value={draft.modelId}>{draft.modelId} (missing)</option>}
              {props.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {friendlyModel(m.name)} · {m.id}
                </option>
              ))}
            </select>
          </SetRow>
          <SetRow label="Tasks at once" help="How many of its tasks can run in parallel." auto>
            <input className="set-num" aria-label="Tasks at once" type="number" min={1} max={10} value={draft.maxRuns} onChange={(e) => setDraft({ ...draft, maxRuns: Number(e.target.value) || 1 })} />
          </SetRow>
          <SetRow label="Working folder" help="Its home workspace, where its commands run.">
            <input aria-label="Working folder" value={draft.workdir ?? ''} placeholder={`default: data/workspaces/${a.id}`} onChange={(e) => setDraft({ ...draft, workdir: e.target.value || null })} />
          </SetRow>
        </SetRows>
        {dirty && (
          <div className="actions">
            <button type="button" className="btn ghost" onClick={() => setDraft(a)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn primary small"
              onClick={() =>
                api
                  .updateAgent(a.id, { rolePrompt: draft.rolePrompt, modelId: draft.modelId, workdir: draft.workdir, enabled: draft.enabled, maxRuns: draft.maxRuns })
                  .then(props.onChanged, onError)
              }
            >
              Save
            </button>
          </div>
        )}
      </SetSec>
      <SetSec title="Memory">
        <a className="set-card set-link" href={memoryHref('agent:' + a.id)} title="Open this agent's memory in Settings → Memory">
          <Icon.memory />
          <span>Memory</span>
          <span className="muted">{memory === null ? '…' : `${memory.length} active`}</span>
          {budget && (
            <span className={'muted' + (budget.used > budget.limit ? ' over' : '')} title="Always on: rules, preferences and pinned (own + shared)">
              · <span className="num">{budget.used}/{budget.limit}</span> chars always on
            </span>
          )}
          <span className="head-sp" />
          <Icon.chev />
        </a>
      </SetSec>
      <SetSec title="Delete">
        <SetRows>
          <SetRow label={`Delete @${a.id}`} help="Its schedules go with it; its chat is archived." auto>
            {!confirming ? (
              <button
                type="button"
                className="btn danger"
                disabled={dirty}
                title={dirty ? 'Save or cancel your changes first' : undefined}
                onClick={() => {
                  setRefusal(null);
                  setConfirming(true);
                }}
              >
                Delete @{a.id}…
              </button>
            ) : (
              <>
                <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button type="button" className="btn primary small danger" onClick={remove}>
                  Delete @{a.id}
                </button>
              </>
            )}
          </SetRow>
        </SetRows>
      {refusal && (
        <ErrorState as="p">
          {refusal}
          {/triage agent/.test(refusal) && (
            <>
              {' '}
              <a href="#/settings/board">Open Board settings</a>
            </>
          )}
          {/open (cards|tasks)/.test(refusal) && (
            <>
              {' '}
              <a href="#/board">Open the board</a>
            </>
          )}
        </ErrorState>
      )}
      </SetSec>
    </section>
  );
}

function NewAgent(props: { models: Model[]; onCreated(): void; onCancel(): void; onError(e: unknown): void }) {
  const [id, setId] = useState('');
  const [role, setRole] = useState('');
  const [modelId, setModelId] = useState('');
  return (
    <form
      className="set-card"
      aria-label="New agent"
      onSubmit={(e) => {
        e.preventDefault();
        api.createAgent({ id: id.trim(), rolePrompt: role, modelId: modelId || props.models[0]?.id || '' }).then(() => {
          setId('');
          setRole('');
          props.onCreated();
        }, props.onError);
      }}
    >
      <div className="field-row">
        <label className="field">
          Name
          <input autoFocus value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="munih" pattern="[a-z][a-z0-9_-]{1,30}" required />
        </label>
        <label className="field">
          Model
          <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {props.models.map((m) => (
              <option key={m.id} value={m.id}>
                {friendlyModelOf(props.models, m.id)} · {m.id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        Role
        <textarea rows={3} value={role} onChange={(e) => setRole(e.target.value)} placeholder="You are munih, a backend engineer…" />
      </label>
      <div className="actions">
        <button type="button" className="btn ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <button className="btn primary small">Create</button>
      </div>
    </form>
  );
}
