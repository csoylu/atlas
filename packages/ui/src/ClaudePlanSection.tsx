import { useCallback, useEffect, useState } from 'react';
import { CLAUDE_PLAN_SETTINGS, type ClaudePlanModel, type ClaudePlanSetting, type ClaudePlanStatus, type Model } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';

/**
 * Can's Claude plan (Claude subscription OAuth, matching Hermes agent):
 * Authorize in browser with your Claude Pro/Max subscription, exchange code with PKCE,
 * and complete agent requests using your subscription.
 */
export function ClaudePlanSection(props: { stream: MessageStream; models: Model[]; keyStore: string | null; onChanged(): void; onError(e: unknown): void }) {
  const { stream, onError } = props;
  const [s, setS] = useState<ClaudePlanStatus | null>(null);
  const [available, setAvailable] = useState<ClaudePlanModel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [authCode, setAuthCode] = useState('');
  const [manualToken, setManualToken] = useState('');
  const [showManual, setShowManual] = useState(false);

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

  const exchangeCode = () => {
    if (!authCode.trim()) return;
    act('exchange', async () => {
      await api.claudeExchange(authCode.trim());
      setAuthCode('');
    });
  };

  const submitManualToken = () => {
    if (!manualToken.trim()) return;
    act('token', async () => {
      await api.claudeSetToken(manualToken.trim());
      setManualToken('');
      setShowManual(false);
    });
  };

  const importDetected = () => {
    act('import', async () => {
      await api.claudeImportDetected();
    });
  };

  const added = new Set(props.models.filter((m) => m.provider === 'claude_plan').map((m) => m.name));
  const showSettings = editing || (s && !s.configured && s.configProblems.length > 0);

  return (
    <section>
      <header className="section-head">
        <h2>Claude subscription (Pro / Max)</h2>
        <p>
          Run agents on Claude models using your Claude subscription via direct OAuth (matching Hermes agent).
          Identifies as Claude Code with subscription usage included.
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
                  <span className="model-name">Connect your Claude subscription</span>
                  {s.detectedCredentials && <span className="pill ok-pill">Detected on machine</span>}
                </div>
                <p className="plan-text">
                  Sign in with your Claude Pro or Max subscription to run Claude models in Atlas without API keys.
                </p>

                {s.detectedCredentials && !s.pending && (
                  <div style={{ marginTop: '8px', marginBottom: '8px' }}>
                    <button className="tool" disabled={busy === 'import'} onClick={importDetected}>
                      {busy === 'import' ? 'Importing…' : `Use detected Claude Code login (${s.detectedCredentials.source})`}
                    </button>
                  </div>
                )}

                {s.pending ? (
                  <div style={{ marginTop: '12px' }}>
                    <p className="plan-text" style={{ fontWeight: 500, color: 'var(--text, #111)' }}>
                      Anthropic opened in your browser. After authorizing, copy the authorization code from the page and paste it below:
                    </p>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
                      <input
                        type="text"
                        autoFocus
                        placeholder="Paste code (e.g. ABC123...#XYZ...)"
                        value={authCode}
                        onChange={(e) => setAuthCode(e.target.value)}
                        style={{ flex: 1, padding: '6px 10px', fontFamily: 'monospace' }}
                        onKeyDown={(e) => e.key === 'Enter' && exchangeCode()}
                      />
                      <button className="primary" disabled={!authCode.trim() || busy === 'exchange'} onClick={exchangeCode}>
                        {busy === 'exchange' ? 'Connecting…' : 'Connect'}
                      </button>
                      <button className="ghost" onClick={() => act('cancel', () => api.claudeCancel())}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}

                {showManual && !s.pending ? (
                  <div style={{ marginTop: '12px' }}>
                    <p className="plan-text" style={{ fontSize: '13px' }}>
                      Paste a Claude Code OAuth token (starts with <code>sk-ant-oat01…</code>):
                    </p>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px' }}>
                      <input
                        type="password"
                        placeholder="sk-ant-oat01-…"
                        value={manualToken}
                        onChange={(e) => setManualToken(e.target.value)}
                        style={{ flex: 1, padding: '6px 10px', fontFamily: 'monospace' }}
                        onKeyDown={(e) => e.key === 'Enter' && submitManualToken()}
                      />
                      <button className="primary small" disabled={!manualToken.trim() || busy === 'token'} onClick={submitManualToken}>
                        Save
                      </button>
                      <button className="ghost small" onClick={() => setShowManual(false)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}

                {s.lastError && <div className="model-error" style={{ marginTop: '8px' }}>{s.lastError}</div>}
              </div>
              <div className="model-actions">
                {!s.pending ? (
                  <>
                    <button className="primary" disabled={busy === 'login'} onClick={signIn}>
                      {busy === 'login' ? 'Opening browser…' : 'Sign in with Claude'}
                    </button>
                    {!showManual && (
                      <button className="ghost" onClick={() => setShowManual(true)}>
                        Paste token
                      </button>
                    )}
                    {!editing && (
                      <button className="ghost" onClick={() => setEditing(true)}>
                        Settings
                      </button>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          ) : s.signedIn ? (
            <div className={'model-row plan-card ' + (s.pausedUntil ? 'bad' : 'ok')}>
              <span className="dot-status" />
              <div className="model-main">
                <div className="model-title">
                  <span className="model-name">{s.email ?? 'Claude subscription'}</span>
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
                    Settings
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

/** The connection details: optional overrides saved in keychain or read from env. */
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
          <span className="model-name">OAuth overrides (defaults match Hermes agent)</span>
          {s.configured ? <span className="pill ok-pill">Configured</span> : <span className="badge bad">Problem</span>}
        </div>
        <p className="plan-text">
          By default, Atlas connects to your Claude subscription with the official Claude Code client details (like Hermes agent).
          Override specific endpoints or settings here only if needed.
        </p>
        <div className="claude-fields">
          {CLAUDE_PLAN_SETTINGS.map((f) => (
            <label key={f.name}>
              <span>{f.label}</span>
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
        <button className="ghost" onClick={props.onDone}>
          Close
        </button>
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
        <p>Agents on Claude plan models now use your Claude subscription. When a limit is reached, Atlas pauses them until it resets.</p>
        <button className="primary" autoFocus onClick={props.onDone}>
          Got it
        </button>
      </div>
    </div>
  );
}
