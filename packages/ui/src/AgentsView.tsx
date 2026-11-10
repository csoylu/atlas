import { tint } from './agentTint.ts';
import { useCallback, useEffect, useState } from 'react';
import { MEMORY_LIMIT, type Agent, type Model, type ModelTest, type Settings } from '@atlas/shared';
import { api } from './api.ts';

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
    <div className="agents-view">
      <section>
        <header className="section-head">
          <h2>Agents</h2>
          <p>
            Each agent has a role, a model, a working folder and a memory it keeps itself. Models, the ChatGPT plan and
            Anthropic accounts are on the <a href="#/models">Models</a> page.
          </p>
        </header>
        <div className="agent-grid">
          {agents.map((a) => (
            <AgentCard key={a.id} agent={a} models={models} triage={props.settings?.triageAgent === a.id} onChanged={changed} onError={onError} />
          ))}
          <NewAgent models={models} onCreated={changed} onError={onError} />
        </div>
        <SharedMemory onError={onError} />
      </section>
    </div>
  );
}

function AgentCard(props: { agent: Agent; models: Model[]; triage: boolean; onChanged(): void; onError(e: unknown): void }) {
  const { agent: a, onError } = props;
  const [draft, setDraft] = useState(a);
  const [memory, setMemory] = useState<string | null>(null);
  const [memDraft, setMemDraft] = useState('');
  useEffect(() => setDraft(a), [a]);
  useEffect(() => {
    api.memory(a.id).then((m) => {
      setMemory(m.text);
      setMemDraft(m.text);
    }, onError);
  }, [a.id, onError]);
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
        {!dirty && (
          <button className="ghost danger" onClick={() => confirm(`Delete @${a.id}?`) && api.deleteAgent(a.id).then(props.onChanged, onError)}>
            Delete
          </button>
        )}
      </div>
      <details className="memory">
        <summary>
          Memory <span className="count">{memory === null ? '…' : `${memory.length}/${MEMORY_LIMIT}`}</span>
        </summary>
        <textarea rows={6} value={memDraft} maxLength={MEMORY_LIMIT} onChange={(e) => setMemDraft(e.target.value)} placeholder="Empty. The agent adds durable facts here with memory_edit." />
        {memDraft !== memory && (
          <button className="primary small" onClick={() => api.setMemory(a.id, memDraft).then((m) => setMemory(m.text), onError)}>
            Save memory
          </button>
        )}
      </details>
    </article>
  );
}

function SharedMemory({ onError }: { onError(e: unknown): void }) {
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  useEffect(() => {
    api.memory('shared').then((m) => {
      setText(m.text);
      setDraft(m.text);
    }, onError);
  }, [onError]);
  return (
    <details className="memory shared">
      <summary>
        Shared memory, in every agent's instructions <span className="count">{text === null ? '…' : `${text.length}/${MEMORY_LIMIT}`}</span>
      </summary>
      <textarea rows={5} value={draft} maxLength={MEMORY_LIMIT} onChange={(e) => setDraft(e.target.value)} placeholder="Team conventions, where things live, Can's preferences…" />
      {draft !== text && (
        <button className="primary small" onClick={() => api.setMemory('shared', draft).then((m) => setText(m.text), onError)}>
          Save shared memory
        </button>
      )}
    </details>
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
