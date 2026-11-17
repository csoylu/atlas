import { tint } from './agentTint.ts';
import { useCallback, useEffect, useState } from 'react';
import { type Agent, type Memory, type Model, type ModelTest, type Settings } from '@atlas/shared';
import { api, ApiError } from './api.ts';
import { Icon } from './ScreenHeader.tsx';
import { memoryHref } from './memoryView.ts';

export function AgentsView(props: {
  settings: Settings | null;
  onSettings(s: Settings): void;
  onAgentsChanged(): void;
  onError(e: unknown): void;
}) {
  const { onError } = props;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const reload = useCallback(() => {
    api.agents().then(setAgents, onError);
    api.models().then(setModels, onError);
  }, [onError]);
  useEffect(reload, [reload]);
  const changed = () => {
    reload();
    props.onAgentsChanged();
  };

  return (
    <section>
        <header className="section-head">
          <h2>Agents</h2>
          <p>
            Each agent has a role, a model, a working folder and a memory it keeps itself. Models and their accounts
            are under <a href="#/settings/subscriptions">Models</a>; what every agent knows is in{' '}
            <a href={memoryHref()}>Settings → Memory</a>.
          </p>
        </header>
        <div className="agent-grid">
          {agents.map((a) => (
            <AgentCard key={a.id} agent={a} models={models} triage={props.settings?.triageAgent === a.id} onChanged={changed} onError={onError} />
          ))}
          <NewAgent models={models} onCreated={changed} onError={onError} />
        </div>
    </section>
  );
}

function AgentCard(props: { agent: Agent; models: Model[]; triage: boolean; onChanged(): void; onError(e: unknown): void }) {
  const { agent: a, onError } = props;
  const [draft, setDraft] = useState(a);
  const [memory, setMemory] = useState<Memory[] | null>(null);
  useEffect(() => setDraft(a), [a]);
  const [budget, setBudget] = useState<{ used: number; limit: number } | null>(null);
  useEffect(() => {
    api.memories({ scope: `agent:${a.id}`, status: 'active' }).then(setMemory, onError);
    api.memoryBudget(a.id).then(setBudget, onError);
  }, [a.id, onError]);
  const [confirming, setConfirming] = useState(false);
  /** Why the engine refused to delete (open cards, triage agent): shown in the card, not a far-away banner. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const remove = () =>
    api.deleteAgent(a.id).then(props.onChanged, (e: unknown) => {
      setConfirming(false);
      if (e instanceof ApiError && e.status === 409) setRefusal(e.message);
      else onError(e);
    });
  const dirty = JSON.stringify(draft) !== JSON.stringify(a);
  const model = props.models.find((m) => m.id === draft.modelId);
  return (
    <article className={'agent-card' + (a.enabled ? '' : ' disabled')}>
      <div className="agent-head">
        <span className="avatar" style={tint(a.id)}>{a.id.slice(0, 1).toUpperCase()}</span>
        <div>
          <div className="agent-name">@{a.id}</div>
          <div className="agent-sub">
            {props.triage && <span className="badge">triage</span>}
            {model?.lastError ? <span className="badge bad">model failing</span> : model?.provider === 'chatgpt' && !model.credentialPresent ? <span className="badge bad">ChatGPT not signed in</span> : model?.provider === 'claude_plan' && !model.credentialPresent ? <span className="badge bad">Claude not signed in</span> : model && !model.credentialPresent && (model.credentialEnv || model.provider === 'anthropic') ? <span className="badge bad">key missing</span> : null}
          </div>
        </div>
        <label className="switch" title="Enabled">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          <span />
        </label>
      </div>
      <label className="field">
        Role
        <textarea rows={3} value={draft.rolePrompt} onChange={(e) => setDraft({ ...draft, rolePrompt: e.target.value })} placeholder="Who this agent is and what it does. First line shows to other agents." />
      </label>
      <div className="field-row">
        <label className="field">
          Model
          <select value={draft.modelId} onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}>
            {props.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id} · {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field narrow">
          Parallel
          <input type="number" min={1} max={10} value={draft.maxRuns} onChange={(e) => setDraft({ ...draft, maxRuns: Number(e.target.value) || 1 })} />
        </label>
      </div>
      <label className="field">
        Working folder
        <input value={draft.workdir ?? ''} placeholder={`default: data/workspaces/${a.id}`} onChange={(e) => setDraft({ ...draft, workdir: e.target.value || null })} />
      </label>
      <div className="actions">
        {dirty && (
          <>
            <button className="ghost" onClick={() => setDraft(a)}>
              Cancel
            </button>
            <button
              className="primary small"
              onClick={() =>
                api
                  .updateAgent(a.id, { rolePrompt: draft.rolePrompt, modelId: draft.modelId, workdir: draft.workdir, enabled: draft.enabled, maxRuns: draft.maxRuns })
                  .then(props.onChanged, onError)
              }
            >
              Save
            </button>
          </>
        )}
        {!dirty && !confirming && (
          <button
            className="ghost danger"
            onClick={() => {
              setRefusal(null);
              setConfirming(true);
            }}
          >
            Delete
          </button>
        )}
        {!dirty && confirming && (
          <>
            <span className="confirm-text">Its schedules go with it; its chat is archived.</span>
            <button className="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="primary small danger" onClick={remove}>
              Delete @{a.id}
            </button>
          </>
        )}
      </div>
      {refusal && (
        <p className="agent-refusal" role="alert">
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
        </p>
      )}
      <a className="agent-memory" href={memoryHref('agent:' + a.id)} title="Open this agent's memory in Settings → Memory">
        <span>Memory</span>
        <span className="count">{memory === null ? '…' : `${memory.length} active`}</span>
        {budget && (
          <span className={'count' + (budget.used > budget.limit ? ' over' : '')} title="Always on: rules, preferences and pinned (own + shared)">
            · {budget.used}/{budget.limit} chars always on
          </span>
        )}
        <Icon.chev />
      </a>
    </article>
  );
}

function NewAgent(props: { models: Model[]; onCreated(): void; onError(e: unknown): void }) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [role, setRole] = useState('');
  const [modelId, setModelId] = useState('');
  if (!open)
    return (
      <button className="agent-card add" onClick={() => setOpen(true)}>
        + New agent
      </button>
    );
  return (
    <form
      className="agent-card"
      onSubmit={(e) => {
        e.preventDefault();
        api.createAgent({ id: id.trim(), rolePrompt: role, modelId: modelId || props.models[0]?.id || '' }).then(() => {
          setOpen(false);
          setId('');
          setRole('');
          props.onCreated();
        }, props.onError);
      }}
    >
      <label className="field">
        Name
        <input autoFocus value={id} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="munih" pattern="[a-z][a-z0-9_-]{1,30}" required />
      </label>
      <label className="field">
        Role
        <textarea rows={3} value={role} onChange={(e) => setRole(e.target.value)} placeholder="You are munih, a backend engineer…" />
      </label>
      <label className="field">
        Model
        <select value={modelId} onChange={(e) => setModelId(e.target.value)}>
          {props.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id} · {m.name}
            </option>
          ))}
        </select>
      </label>
      <div className="actions">
        <button type="button" className="ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button className="primary small">Create</button>
      </div>
    </form>
  );
}
