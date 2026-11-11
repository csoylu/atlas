import { useCallback, useEffect, useState } from 'react';
import { CLAUDE_PLAN_SETTINGS, type ClaudePlanModel, type ClaudePlanSetting, type ClaudePlanStatus, type Model } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';

/** Claude subscription sign-in, available models and limit status. */
export function ClaudePlanSection(props: { stream: MessageStream; models: Model[]; keyStore: string | null; onChanged(): void; onError(e: unknown): void }) {
  const { stream, onError } = props;
  const [s, setS] = useState<ClaudePlanStatus | null>(null);
  const [available, setAvailable] = useState<ClaudePlanModel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => api.claude().then(setS, onError), [onError]);
  useEffect(() => {
    void load();
    return stream.listen('claude', (e) => {
      if (e.type === 'claude') setS(e.status);
    });
  }, [load, stream]);
  const act = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await f();
      await load();
      props.onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };
  const ready = !!s?.signedIn && s.configured;
  useEffect(() => {
    if (ready) api.claudeModels().then(setAvailable, onError);
    else setAvailable(null);
  }, [ready, onError]);

  const signIn = () =>
    act('login', async () => {
      const { url } = await api.claudeLogin();
      window.open(url, '_blank', 'noopener');
    });
  const added = new Set(props.models.filter((m) => m.provider === 'claude_plan').map((m) => m.name));
  const showSettings = editing || (s && !s.configured);

  return (
    <section>
      <header className="section-head">
        <h2>Claude plan</h2>
        <p>
          Sign in with your Claude subscription using OAuth. No client setup is required. For normal API-key billing, use Anthropic accounts instead.
        </p>
      </header>
      {!s ? null : !s.available ? (
        <div className="empty-note">{s.unavailableReason}</div>
      ) : (
        <div className="model-list">
          {showSettings ? (
            <ClaudeSettings status={s} keyStore={props.keyStore} onDone={() => setEditing(false)} onSaved={load} onError={onError} />
          ) : null}
          {s.configured && !s.signedIn ? (
            <div className="model-row plan-card">
              <div className="model-main">
                <div className="model-title">
                  <span className="model-name">Use your Claude plan</span>
                </div>
                <p className="plan-text">Complete AI requests in Atlas with usage included in your Claude plan.</p>
                {s.lastError && <div className="model-error">{s.lastError}</div>}
              </div>
              <div className="model-actions">
                {s.pending ? (
                  <>
                    <label>Paste the authorization code shown by Claude
                      <input type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="code#state" />
                    </label>
                    <button className="primary" disabled={!code.trim() || busy === 'complete'} onClick={() => act('complete', async () => { await api.claudeComplete(code); setCode(''); })}>Finish sign-in</button>
                    <button className="ghost" onClick={() => act('cancel', () => api.claudeCancel())}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="primary" disabled={busy === 'login'} onClick={signIn}>
                    Sign in with Claude
                  </button>
                )}
                {!editing && (
                  <button className="ghost" onClick={() => setEditing(true)}>
                    Advanced settings
                  </button>
                )}
              </div>
            </div>
          ) : s.signedIn ? (
            <div className={'model-row plan-card ' + (s.pausedUntil ? 'bad' : 'ok')}>
              <span className="dot-status" />
              <div className="model-main">
                <div className="model-title">
                  <span className="model-name">{s.email ?? 'Claude account'}</span>
                  {s.pausedUntil ? <span className="badge bad">Limit reached</span> : <span className="pill ok-pill">Using Claude plan</span>}
                </div>
                {s.pausedUntil && <p className="plan-text">Requests are paused until {new Date(s.pausedUntil).toLocaleString()}.</p>}
                {s.lastError && !s.pausedUntil && <div className="model-error">{s.lastError}</div>}
              </div>
              <div className="model-actions">
                {s.pausedUntil && (
                  <button className="ghost" onClick={() => act('resume', () => api.updateClaude({ resume: true }))}>
                    Resume
                  </button>
                )}
                {!editing && (
                  <button className="ghost" onClick={() => setEditing(true)}>
                    Advanced settings
                  </button>
                )}
                <button className="ghost danger" onClick={() => confirm('Sign out of Claude? Agents on Claude plan models stop until you sign in again.') && act('out', () => api.claudeLogout())}>
                  Sign out
                </button>
              </div>
            </div>
          ) : null}
          {ready && (
            <div className="plan-models">
              <div className="plan-models-head">Models on your plan</div>
              {available === null ? (
                <span className="muted">Loading…</span>
              ) : available.length === 0 ? (
                <span className="muted">This account has no models for Atlas.</span>
              ) : (
                available.map((m) => (
                  <div key={m.id} className="plan-model">
                    <span>{m.displayName}</span>
                    <code>{m.id}</code>
                    {added.has(m.id) ? (
                      <span className="muted">Added: pick it on an agent</span>
                    ) : (
                      <button
                        className="tool"
                        disabled={busy === 'add:' + m.id}
                        onClick={() => act('add:' + m.id, () => api.createModel({ id: planModelId(m.id), provider: 'claude_plan', name: m.id }))}
                      >
                        Give to agents
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** An Atlas model id for a plan model ('claude-opus-5' → 'plan-claude-opus-5'), distinct from API-key models. */
const planModelId = (id: string) => ('plan-' + id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')).slice(0, 31);

/** The connection details: each one a keychain entry (desktop) or an env var (server). Secrets never come back. */
function ClaudeSettings(props: { status: ClaudePlanStatus; keyStore: string | null; onDone(): void; onSaved(): Promise<unknown>; onError(e: unknown): void }) {
  const { status: s } = props;
  const [draft, setDraft] = useState<Partial<Record<ClaudePlanSetting, string>>>({});
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      for (const [name, value] of Object.entries(draft)) {
        if (value.trim()) await api.setSecret(name, value.trim());
        else if (s.settings[name as ClaudePlanSetting] !== null) await api.deleteSecret(name);
      }
      setDraft({});
      await props.onSaved();
    } catch (e) {
      props.onError(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="model-row plan-card claude-settings">
      <div className="model-main">
        <div className="model-title">
          <span className="model-name">Advanced settings from Anthropic</span>
          {s.configured ? <span className="pill ok-pill">Complete</span> : <span className="badge bad">Not set up</span>}
        </div>
        <p className="plan-text">
          Subscription OAuth works with built-in defaults; only change these for a custom OAuth server.{' '}
          {props.keyStore ? `They are saved in the ${props.keyStore}.` : 'This engine reads them from its environment (.env); set them there and restart it.'}
          {s.redirectUri ? (
            <>
              {' '}Redirect URI to register: <code>{s.redirectUri}</code>
            </>
          ) : (
            <> Redirect URI: <code>http://127.0.0.1:&lt;any port&gt;/callback</code> (set a callback port if Anthropic registered a fixed one).</>
          )}
        </p>
        <div className="claude-fields">
          {CLAUDE_PLAN_SETTINGS.map((f) => (
            <label key={f.name}>
              <span>
                {f.label} {f.required && <b>*</b>}
              </span>
              <input
                type={f.secret ? 'password' : 'text'}
                name={f.name}
                autoComplete={f.secret ? 'new-password' : 'off'}
                spellCheck={false}
                data-1p-ignore=""
                data-lpignore="true"
                disabled={!props.keyStore}
                value={draft[f.name] ?? (f.secret ? '' : (s.settings[f.name] ?? ''))}
                placeholder={f.secret && s.settings[f.name] ? 'saved (type to replace)' : f.name}
                onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
              />
            </label>
          ))}
        </div>
        {s.configProblems.length > 0 && (
          <ul className="model-error claude-problems">
            {s.configProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="model-actions">
        {props.keyStore && (
          <button className="primary" disabled={saving || Object.keys(draft).length === 0} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        {s.configured && (
          <button className="ghost" onClick={props.onDone}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}

/** The one-time notice after the first Claude sign-in. */
export function ClaudeWelcome(props: { onDone(): void }) {
  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="claude-welcome">
        <h2 id="claude-welcome">You're using your Claude plan</h2>
        <p>Agents on Claude plan models now use your Claude plan's usage. When a limit is reached, Atlas pauses them until it resets.</p>
        <button className="primary" autoFocus onClick={props.onDone}>
          Got it
        </button>
      </div>
    </div>
  );
}
