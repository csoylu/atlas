import { useCallback, useEffect, useState } from 'react';
import type { Agent, ChatGptStatus, LocalModel, LocalPull, LocalStatus } from '@atlas/shared';
import { ModelSections } from './ModelSections.tsx';
import { UsageSection } from './Usage.tsx';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';

/**
 * Local models: the engine runs Ollama on its own machine (engine/src/local.ts). This page asks it to install, start
 * and stop the server, download models from the Ollama library, load them into memory and
 * hand them to agents. Everything here is a request to the engine; it keeps running with the window closed.
 */
export function ModelsView(props: {
  stream: MessageStream;
  agents: Agent[];
  chatgpt: ChatGptStatus | null;
  onModelsChanged(): void;
  onError(e: unknown): void;
}) {
  const { stream, agents, onError } = props;
  // Bumped after local actions (« Give to agents » makes a model), so the model list above re-reads.
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [models, setModels] = useState<LocalModel[] | null>(null);
  const [pulls, setPulls] = useState<Map<string, LocalPull>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setTick((t) => t + 1);
    api.local().then(setStatus, onError);
    api.localModels().then(
      (r) => {
        setModels(r.models);
        setPulls(new Map(r.pulls.map((p) => [p.name, p])));
      },
      onError,
    );
  }, [onError]);
  useEffect(refresh, [refresh]);
  useEffect(
    () =>
      stream.listen('local', (e) => {
        if (e.type === 'local') {
          setStatus(e.status);
          api.localModels().then((r) => setModels(r.models), () => {});
        } else if (e.type === 'pull') setPulls((m) => new Map(m).set(e.pull.name, e.pull));
      }),
    [stream],
  );

  const act = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await f();
      refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };
  const pull = (name: string) => act('pull:' + name, () => api.pull(name).then((p) => setPulls((m) => new Map(m).set(p.name, p))));

  const loadedMemory = (models ?? []).reduce((s, m) => s + (m.loaded?.memory ?? 0), 0);
  const installedNames = new Set((models ?? []).map((m) => m.name));

  return (
    <div className="agents-view models-view">
      <UsageSection stream={stream} onError={onError} />
      <ModelSections stream={stream} chatgpt={props.chatgpt} tick={tick} onChanged={props.onModelsChanged} onError={onError} />
      <section>
        <div className="section-head">
          <h2>Ollama on this machine</h2>
          <p>
            Atlas runs <b>Ollama</b> for you: it starts it when an agent needs a local model and restarts it if it
            crashes. Models run on this machine and nothing leaves it.
          </p>
        </div>
        {status ? <ServerPanel status={status} loadedMemory={loadedMemory} busy={busy} act={act} /> : <div className="model-row skeleton" />}
      </section>

      <section>
        <div className="section-head">
          <h2>Installed models</h2>
          <p>Give one to agents: it joins « Available to agents » above, then pick it as an agent's model on the Agents page.</p>
        </div>
        <Installed
          models={models}
          running={!!status?.running}
          total={status?.totalMemory ?? 0}
          agents={agents}
          busy={busy}
          act={act}
        />
      </section>

      <section>
        <div className="section-head">
          <h2>Download</h2>
          <p>
            Type a model name from the <a href="https://ollama.com/library" target="_blank" rel="noreferrer">Ollama library</a>, such as{' '}
            <code>qwen3:8b</code> (name, then a colon and the size).
          </p>
        </div>
        <Downloads pulls={pulls} onCancel={(n) => act('cancel:' + n, () => api.cancelPull(n))} />
        <Finder installed={installedNames} pulls={pulls} onPull={pull} disabled={!status?.binary} />
      </section>
    </div>
  );
}

/* ── Server ─────────────────────────────────────────────────────────────── */
const CONTEXTS = [8192, 16384, 32768, 65536, 131072];

function ServerPanel(props: {
  status: LocalStatus;
  loadedMemory: number;
  busy: string | null;
  act(key: string, f: () => Promise<unknown>): void;
}) {
  const { status: s, busy, act } = props;
  if (!s.binary)
    return (
      <div className="model-row server-row">
        <span className="dot-status" />
        <div className="model-main">
          <div className="model-title">Ollama is not installed</div>
          <div className="model-detail">
            {s.installing
              ? 'Installing with Homebrew… this takes a minute or two.'
              : s.canInstall
                ? 'Atlas can install it with Homebrew (about 100 MB).'
                : 'Install it from ollama.com/download, then come back here.'}
          </div>
          {s.error && <div className="model-error">{s.error}</div>}
        </div>
        {s.canInstall ? (
          <button className="primary small" disabled={s.installing} onClick={() => act('install', api.installLocal)}>
            {s.installing ? 'Installing…' : 'Install Ollama'}
          </button>
        ) : (
          <a className="primary small" href="https://ollama.com/download" target="_blank" rel="noreferrer">
            Download Ollama
          </a>
        )}
      </div>
    );
  return (
    <div className={'model-row server-row ' + (s.running ? 'ok' : s.error ? 'bad' : '')}>
      <span className="dot-status" />
      <div className="model-main">
        <div className="model-title">
          {s.running ? 'Running' : 'Stopped'}
          {s.version && <span className="badge">Ollama {s.version}</span>}
          {s.running && <span className="muted">{s.owner === 'atlas' ? 'started by Atlas' : 'started outside Atlas'}</span>}
        </div>
        <div className="model-detail">
          <span>
            Memory in use <b className="num">{gib(props.loadedMemory)}</b> of <span className="num">{gib(s.totalMemory)}</span>
          </span>
          <code>{s.url}</code>
        </div>
        <div className="server-settings">
          <label className="inline-switch">
            <span className="switch">
              <input type="checkbox" checked={s.autostart} onChange={(e) => act('auto', () => api.updateLocal({ autostart: e.target.checked }))} />
              <span />
            </span>
            Start automatically when an agent needs it
          </label>
          <label className="inline-field">
            Context per model
            <select value={s.contextLength} onChange={(e) => act('ctx', () => api.updateLocal({ contextLength: Number(e.target.value) }))}>
              {[...new Set([...CONTEXTS, s.contextLength])]
                .sort((a, b) => a - b)
                .map((c) => (
                  <option key={c} value={c}>
                    {c / 1024}k tokens
                  </option>
                ))}
            </select>
          </label>
          {s.owner === 'external' && <span className="muted">Context applies once Atlas runs the server (Stop, then Start).</span>}
        </div>
        {s.error && <div className="model-error">{s.error}</div>}
      </div>
      <div className="model-actions">
        {s.running ? (
          <button className="tool" disabled={busy === 'stop'} onClick={() => act('stop', api.stopLocal)}>
            {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <button className="primary small" disabled={busy === 'start'} onClick={() => act('start', api.startLocal)}>
            {busy === 'start' ? 'Starting…' : 'Start'}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Installed ──────────────────────────────────────────────────────────── */
function Installed(props: {
  models: LocalModel[] | null;
  running: boolean;
  total: number;
  agents: Agent[];
  busy: string | null;
  act(key: string, f: () => Promise<unknown>): void;
}) {
  const { models, busy, act } = props;
  if (!props.running && !models?.length) return <div className="empty-note">Start the server to see the models on this machine.</div>;
  if (!models) return <div className="model-row skeleton" />;
  if (!models.length) return <div className="empty-note">No models yet. Download one below.</div>;
  return (
    <div className="model-list">
      {models.map((m) => {
        const users = props.agents.filter((a) => m.usedBy.includes(a.modelId));
        return (
          <div key={m.name} className={'model-row local-row' + (m.loaded ? ' ok' : '')}>
            <span className="dot-status" title={m.loaded ? 'In memory' : 'On disk'} />
            <div className="model-main">
              <div className="model-title">
                <span className="model-name">{m.name}</span>
                {m.parameterSize && <span className="badge">{m.parameterSize}</span>}
                {m.quantization && <span className="badge">{m.quantization}</span>}
                {m.capabilities.includes('tools') ? null : <span className="badge bad" title="Agents need tool calls to work on cards">No tools</span>}
              </div>
              <div className="model-detail">
                <span className="num">{gb(m.size)} on disk</span>
                {m.loaded ? (
                  <span>
                    In memory, <span className="num">{gib(m.loaded.memory)}</span>
                    {m.loaded.contextLength ? `, ${Math.round(m.loaded.contextLength / 1024)}k context` : ''}
                    {m.loaded.until ? `, until ${new Date(m.loaded.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
                  </span>
                ) : (
                  <span>Not loaded</span>
                )}
                {m.usedBy.length > 0 && (
                  <span>
                    Atlas model <code>{m.usedBy.join(', ')}</code>
                    {users.length > 0 && ` · used by ${users.map((a) => '@' + a.id).join(', ')}`}
                  </span>
                )}
              </div>
            </div>
            <div className="model-actions">
              {m.usedBy.length === 0 && (
                <button className="primary small" disabled={busy === 'use:' + m.name} onClick={() => act('use:' + m.name, () => api.useLocal(m.name))}>
                  Give to agents
                </button>
              )}
              <button
                className="tool"
                disabled={busy === 'load:' + m.name}
                onClick={() => act('load:' + m.name, () => api.loadLocal(m.name, !m.loaded))}
                title={m.loaded ? 'Free its memory; it loads again on the next call' : 'Load it now and keep it in memory'}
              >
                {busy === 'load:' + m.name ? (m.loaded ? 'Unloading…' : 'Loading…') : m.loaded ? 'Unload' : 'Load'}
              </button>
              <button
                className="ghost danger"
                disabled={m.usedBy.length > 0}
                title={m.usedBy.length ? 'Used by an Atlas model: remove it from « Available to agents » first' : 'Delete from disk'}
                onClick={() => confirm(`Delete ${m.name} (${gb(m.size)}) from this machine?`) && act('del:' + m.name, () => api.deleteLocal(m.name))}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Downloads in progress ─────────────────────────────────────────────── */
function Downloads(props: { pulls: Map<string, LocalPull>; onCancel(name: string): void }) {
  const list = [...props.pulls.values()].filter((p) => !p.done || p.error);
  if (!list.length) return null;
  return (
    <div className="model-list pulls">
      {list.map((p) => {
        const pct = p.total ? Math.min(100, (p.completed / p.total) * 100) : 0;
        return (
          <div key={p.name} className={'model-row pull-row' + (p.error ? ' bad' : '')}>
            <div className="model-main">
              <div className="model-title">
                <span className="model-name">{p.name}</span>
              </div>
              {p.error ? (
                <div className="model-error">{p.error}</div>
              ) : (
                <>
                  <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: pct + '%' }} />
                  </div>
                  <div className="model-detail">
                    <span>{p.status}</span>
                    {p.total > 0 && (
                      <span className="num">
                        {gb(p.completed)} of {gb(p.total)} · {Math.round(pct)}%
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
            <div className="model-actions">
              <button className="ghost" onClick={() => props.onCancel(p.name)}>
                {p.done ? 'Dismiss' : 'Cancel'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Download by name from the Ollama library ───────────────────────────── */
function Finder(props: { installed: Set<string>; pulls: Map<string, LocalPull>; onPull(name: string): void; disabled: boolean }) {
  const [q, setQ] = useState('');
  const name = q.trim();
  const valid = /^[\w.-]+(\/[\w.-]+)?(:[\w.-]+)?$/.test(name);
  const pull = props.pulls.get(name);
  return (
    <form
      className="finder-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) props.onPull(name);
      }}
    >
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Model name, e.g. qwen3:8b" aria-label="Model name" spellCheck={false} />
      <button className="primary small" disabled={props.disabled || !valid || props.installed.has(name) || (!!pull && !pull.done)}>
        {props.installed.has(name) ? 'Installed' : pull && !pull.done ? 'Downloading…' : 'Download'}
      </button>
    </form>
  );
}

/** Memory in binary GB, as macOS shows it (36 GB, not 38.7). */
function gib(n: number): string {
  return (n / 2 ** 30).toFixed(n < 10 * 2 ** 30 ? 1 : 0).replace(/\.0$/, '') + ' GB';
}
function gb(n: number): string {
  if (n < 1e9) return Math.round(n / 1e6) + ' MB';
  return (n / 1e9).toFixed(n < 1e10 ? 1 : 0) + ' GB';
}
