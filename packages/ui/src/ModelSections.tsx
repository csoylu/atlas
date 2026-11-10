import { useCallback, useEffect, useState } from 'react';
import type { Agent, ChatGptStatus, Model, ModelTest } from '@atlas/shared';
import { api } from './api.ts';
import { AccountsSection } from './AccountsSection.tsx';
import { ChatGptSection } from './ChatGptSection.tsx';
import { ClaudePlanSection } from './ClaudePlanSection.tsx';
import type { MessageStream } from './useMessages.ts';

/**
 * Where agents' models come from (Models page, above the local Ollama sections): the models agents can pick, the
 * ChatGPT plan and the Anthropic accounts. `tick` changes when the page made a model elsewhere (« Give to agents »).
 */
export function ModelSections(props: { stream: MessageStream; chatgpt: ChatGptStatus | null; tick: number; onChanged(): void; onError(e: unknown): void }) {
  const { onError } = props;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [secrets, setSecrets] = useState<{ store: string | null; names: string[] }>({ store: null, names: [] });
  const reload = useCallback(() => {
    api.agents().then(setAgents, onError);
    api.models().then(setModels, onError);
    api.secrets().then(setSecrets, onError);
  }, [onError]);
  useEffect(reload, [reload, props.tick, props.chatgpt]);
  const changed = () => {
    reload();
    props.onChanged();
  };

  return (
    <>
      <section>
        <header className="section-head">
          <h2>Available to agents</h2>
          <p>
            The models an agent can pick on the <a href="#/agents">Agents</a> page: Claude, ChatGPT plan models, any
            OpenAI-compatible server, and the models on this machine (« Give to agents » below).{' '}
            {secrets.store
              ? `Keys are encrypted with the ${secrets.store}; they never come back to this screen.`
              : "Keys come from the engine's environment (.env on a dev machine or server); only the variable name is stored here."}
          </p>
        </header>
        <div className="model-list">
          {models.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              keyStore={secrets.store}
              stored={!!m.credentialEnv && secrets.names.includes(m.credentialEnv)}
              usedBy={agents.filter((a) => a.modelId === m.id).map((a) => a.id)}
              onChanged={changed}
              onError={onError}
            />
          ))}
          <NewModel onCreated={changed} onError={onError} />
        </div>
      </section>
      <ClaudePlanSection stream={props.stream} models={models} keyStore={secrets.store} onChanged={changed} onError={onError} />
      <ChatGptSection status={props.chatgpt} models={models} onChanged={changed} onError={onError} />
      <AccountsSection keyStore={secrets.store} onChanged={changed} onError={onError} />
    </>
  );
}

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(iso).toLocaleDateString();
};

/** Agents and models (design §12 « Agents » + « Settings »). */
/** 32768 → "32k", 200000 → "200k", 1048576 → "1M": binary sizes (local servers) and decimal ones (Anthropic) both read naturally. */
const tokens = (n: number) => {
  const [k, m] = n % 1024 === 0 ? [1024, 1_048_576] : [1000, 1_000_000];
  return n >= m ? `${+(n / m).toFixed(1)}M` : `${+(n / k).toFixed(n % k ? 1 : 0)}k`;
};

function ModelRow(props: { model: Model; keyStore: string | null; stored: boolean; usedBy: string[]; onChanged(): void; onError(e: unknown): void }) {
  const { model: m, onError } = props;
  const [keyDraft, setKeyDraft] = useState<string | null>(null);
  const [test, setTest] = useState<ModelTest | 'running' | null>(null);
  const [edit, setEdit] = useState(false);
  const fromModel = () => ({ name: m.name, baseUrl: m.baseUrl ?? '', credentialEnv: m.credentialEnv ?? '', contextWindow: String(m.contextWindow) });
  const [draft, setDraft] = useState(fromModel);
  const ctx = Number(draft.contextWindow);
  const ctxValid = Number.isInteger(ctx) && ctx >= 2048;
  const status = m.lastError ? 'bad' : m.verifiedAt ? 'ok' : 'unknown';
  return (
    <div className={'model-row ' + status}>
      <span className="dot-status" title={m.lastError ?? (m.verifiedAt ? 'answered ' + ago(m.verifiedAt) : 'not tested yet')} />
      <div className="model-main">
        <div className="model-title">
          <b>{m.id}</b> <span className="muted">{m.provider === 'claude_code' ? 'Claude subscription (removed — select another model)' : m.provider === 'anthropic' ? 'Anthropic API' : m.provider === 'chatgpt' ? 'ChatGPT plan' : m.provider === 'claude_plan' ? 'Claude plan' : 'OpenAI-compatible'}</span>
          {props.usedBy.map((a) => (
            <span key={a} className="badge">
              @{a}
            </span>
          ))}
        </div>
        {edit ? (
          <div className="model-edit">
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="model name" />
            {m.provider === 'openai_compat' && <input value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="http://127.0.0.1:11434/v1" />}
            {m.provider !== 'claude_code' && m.provider !== 'claude_plan' && m.provider !== 'chatgpt' && <input value={draft.credentialEnv} onChange={(e) => setDraft({ ...draft, credentialEnv: e.target.value.toUpperCase() })} placeholder="KEY_ENV_VAR (optional)" />}
            <label className="ctx-input" title="Tokens the model can read at once. Atlas summarizes older messages past 70 % of it. Test detects it for Ollama and llama.cpp.">
              <input type="number" min={2048} step={1024} value={draft.contextWindow} onChange={(e) => setDraft({ ...draft, contextWindow: e.target.value })} aria-invalid={!ctxValid} />
              <span className="muted">context tokens</span>
            </label>
          </div>
        ) : (
          <div className="model-detail">
            <code>{m.name}</code>
            {m.baseUrl && <code>{m.baseUrl}</code>}
            {m.provider === 'anthropic' && !m.credentialEnv && (
              <span className={m.credentialPresent ? 'key ok' : 'key bad'}>{m.credentialPresent ? 'uses the Anthropic accounts' : 'no Anthropic account with a key'}</span>
            )}
            {m.credentialEnv && (
              <span className={m.credentialPresent ? 'key ok' : 'key bad'}>
                {m.credentialEnv} {m.credentialPresent ? 'set' : 'missing'}
              </span>
            )}
            <span className="muted" title="Context window: older messages are summarized past 70 % of it">{tokens(m.contextWindow)} context</span>
            <span className="muted">checked {ago(m.verifiedAt)}</span>
          </div>
        )}
        {keyDraft !== null && m.credentialEnv && (
          <form
            className="key-form"
            onSubmit={(e) => {
              e.preventDefault();
              api.setSecret(m.credentialEnv!, keyDraft).then(() => {
                setKeyDraft(null);
                props.onChanged();
              }, onError);
            }}
          >
            <input type="password" autoFocus autoComplete="off" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder={`Paste ${m.credentialEnv}`} />
            <button type="button" className="ghost" onClick={() => setKeyDraft(null)}>
              Cancel
            </button>
            <button className="primary small" disabled={!keyDraft.trim()}>
              Save to {props.keyStore}
            </button>
          </form>
        )}
        {m.lastError && <div className="model-error">{m.lastError}</div>}
        {test && test !== 'running' && (test.ok || test.error !== m.lastError) && (
          <div className={test.ok ? 'model-ok' : 'model-error'}>
            {test.ok
              ? `Answered in ${(test.ms / 1000).toFixed(1)} s` + (test.detectedContextWindow ? ` · server runs it with ${tokens(test.detectedContextWindow)} context` : '')
              : test.error}
          </div>
        )}
      </div>
      <div className="model-actions">
        {edit ? (
          <>
            <button className="ghost" onClick={() => setEdit(false)}>
              Cancel
            </button>
            <button
              className="primary small"
              disabled={!ctxValid}
              onClick={() =>
                api
                  .updateModel(m.id, {
                    name: draft.name,
                    baseUrl: m.provider === 'openai_compat' ? draft.baseUrl || null : null,
                    credentialEnv: draft.credentialEnv || null,
                    contextWindow: ctx,
                  })
                  .then(() => {
                    setEdit(false);
                    props.onChanged();
                  }, onError)
              }
            >
              Save
            </button>
          </>
        ) : (
          <>
            <button
              className="tool"
              disabled={test === 'running'}
              onClick={() => {
                setTest('running');
                api.testModel(m.id).then((t) => {
                  setTest(t);
                  props.onChanged();
                }, onError);
              }}
            >
              {test === 'running' ? 'Testing…' : 'Test'}
            </button>
            {props.keyStore && m.credentialEnv && keyDraft === null && (
              <button className="ghost" onClick={() => setKeyDraft('')}>
                {m.credentialPresent ? 'Replace key' : 'Set key'}
              </button>
            )}
            {props.stored && (
              <button className="ghost" onClick={() => confirm(`Remove ${m.credentialEnv} from the ${props.keyStore}?`) && api.deleteSecret(m.credentialEnv!).then(props.onChanged, onError)}>
                Remove key
              </button>
            )}
            <button
              className="ghost"
              onClick={() => {
                setDraft(fromModel());
                setEdit(true);
              }}
            >
              Edit
            </button>
            {props.usedBy.length === 0 && (
              <button className="ghost danger" onClick={() => confirm(`Delete model ${m.id}?`) && api.deleteModel(m.id).then(props.onChanged, onError)}>
                Delete
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function NewModel(props: { onCreated(): void; onError(e: unknown): void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ id: '', provider: 'openai_compat' as 'anthropic' | 'openai_compat', name: '', baseUrl: 'http://127.0.0.1:11434/v1', credentialEnv: '' });
  if (!open)
    return (
      <button className="model-row add" onClick={() => setOpen(true)}>
        + Add a model
      </button>
    );
  return (
    <form
      className="model-row new"
      onSubmit={(e) => {
        e.preventDefault();
        api
          .createModel({
            id: f.id,
            provider: f.provider,
            name: f.name,
            baseUrl: f.provider === 'openai_compat' ? f.baseUrl : null,
            credentialEnv: f.credentialEnv || null,
          })
          .then(() => {
            setOpen(false);
            props.onCreated();
          }, props.onError);
      }}
    >
      <select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as typeof f.provider })}>
        <option value="openai_compat">OpenAI-compatible (local)</option>
        <option value="anthropic">Anthropic</option>
      </select>
      <input autoFocus value={f.id} onChange={(e) => setF({ ...f, id: e.target.value.toLowerCase() })} placeholder="id, e.g. qwen" required />
      <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={f.provider === 'anthropic' ? 'claude-sonnet-5-5' : 'model name on the server'} required />
      {f.provider === 'openai_compat' && <input value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder="base URL" required />}
      <input value={f.credentialEnv} onChange={(e) => setF({ ...f, credentialEnv: e.target.value.toUpperCase() })} placeholder={f.provider === 'anthropic' ? 'own key env var (optional; default: the accounts)' : 'key env var (optional)'} />
      <button type="button" className="ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
      <button className="primary small">Add</button>
    </form>
  );
}
