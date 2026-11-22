import { useCallback, useEffect, useState } from 'react';
import { GEMINI_PLAN_SETTINGS, type GeminiPlanModel, type GeminiPlanSetting, type GeminiPlanStatus, type Model } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';

/**
 * Can's Google subscription (Gemini) through the Antigravity quota: an OAuth client copied from the Antigravity app
 * into the keychain, Sign in with Google, then agents run on the plan's models without an API key. One account; a
 * usage limit pauses requests until it resets or Can resumes.
 */
export function GeminiPlanSection(props: { stream: MessageStream; models: Model[]; keyStore: string | null; onChanged(): void; onError(e: unknown): void }) {
  const { stream, onError } = props;
  const [s, setS] = useState<GeminiPlanStatus | null>(null);
  const [available, setAvailable] = useState<GeminiPlanModel[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => api.gemini().then(setS, onError), [onError]);
  useEffect(() => {
    void load();
    return stream.listen('gemini', (e) => {
      if (e.type === 'gemini') setS(e.status);
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

  const ready = !!s?.signedIn;
  useEffect(() => {
    if (ready) api.geminiModels().then(setAvailable, onError);
    else setAvailable(null);
  }, [ready, onError]);

  const signIn = () =>
    act('login', async () => {
      const { url } = await api.geminiLogin();
      window.open(url, '_blank', 'noopener');
    });

  const added = new Set(props.models.filter((m) => m.provider === 'gemini_plan').map((m) => m.name));
  const showSettings = editing || (s !== null && !s.configured && s.configProblems.length > 0);

  return (
    <section>
      <header className="section-head">
        <h2>Gemini subscription (Antigravity)</h2>
        <p>
          Run agents on Gemini models with the quota of your Google subscription, through Antigravity. Unofficial: Google
          may restrict accounts that use third-party clients.
        </p>
      </header>
      {!s ? null : !s.available ? (
        <div className="empty-note">{s.unavailableReason}</div>
      ) : (
        <div className="model-list">
          {showSettings && (
            <GeminiSettings status={s} keyStore={props.keyStore} onDone={() => setEditing(false)} onSaved={load} onError={onError} />
          )}

          {s.configured && !s.signedIn ? (
            <div className="model-row plan-card">
              <div className="model-main">
                <div className="model-title">
                  <span className="model-name">Connect your Google subscription</span>
                </div>
                <p className="plan-text">
                  {s.pending
                    ? 'Google sign-in is open in your browser. Finish there; this page updates by itself.'
                    : 'Sign in with the Google account that has your Gemini subscription.'}
                </p>
                {s.lastError && <div className="model-error" style={{ marginTop: '8px' }}>{s.lastError}</div>}
              </div>
              <div className="model-actions">
                {s.pending ? (
                  <button className="ghost" onClick={() => act('cancel', () => api.geminiCancel())}>
                    Cancel
                  </button>
                ) : (
                  <button className="primary" disabled={busy === 'login'} onClick={signIn}>
                    {busy === 'login' ? 'Opening browser…' : 'Sign in with Google'}
                  </button>
                )}
              </div>
            </div>
          ) : s.signedIn ? (
            <div className={'model-row plan-card ' + (s.pausedUntil ? 'bad' : 'ok')}>
              <span className="dot-status" />
              <div className="model-main">
                <div className="model-title">
                  <span className="model-name">{s.email ?? 'Google subscription'}</span>
                  {s.pausedUntil ? <span className="badge bad">Limit reached</span> : <span className="pill ok-pill">Using Gemini plan</span>}
                </div>
                {s.project && (
                  <div className="model-detail">
                    <span className="muted">Cloud Code project</span> <code>{s.project}</code>
                  </div>
                )}
                {s.pausedUntil && <p className="plan-text">Requests are paused until {new Date(s.pausedUntil).toLocaleString()}.</p>}
                {s.lastError && <div className="model-error">{s.lastError}</div>}
              </div>
              <div className="model-actions">
                {s.pausedUntil && (
                  <button className="ghost" onClick={() => act('resume', () => api.updateGemini({ resume: true }))}>
                    Resume
                  </button>
                )}
                {!editing && (
                  <button className="ghost" onClick={() => setEditing(true)}>
                    Settings
                  </button>
                )}
                <button
                  className="ghost danger"
                  onClick={() => confirm('Sign out of Gemini? Agents on Gemini plan models stop until you sign in again.') && act('out', () => api.geminiLogout())}
                >
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
                <span className="muted">This account has no Gemini models for Atlas.</span>
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
                        onClick={() =>
                          act('add:' + m.id, () => api.createModel({ id: planModelId(m.id), provider: 'gemini_plan', name: m.id, contextWindow: m.contextWindow }))
                        }
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

/** An Atlas model id for a plan model ('gemini-4-neon' → 'plan-gemini-4-neon'), distinct from API-key models. */
const planModelId = (id: string) => ('plan-' + id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')).slice(0, 31);

/** The Antigravity OAuth client: two values copied from Google's app, kept in the keychain, never in the repo. */
function GeminiSettings(props: { status: GeminiPlanStatus; keyStore: string | null; onDone(): void; onSaved(): Promise<unknown>; onError(e: unknown): void }) {
  const { status: s } = props;
  const [draft, setDraft] = useState<Partial<Record<GeminiPlanSetting, string>>>({});
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      for (const [name, value] of Object.entries(draft)) if (value.trim()) await api.setSecret(name, value.trim());
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
          <span className="model-name">Antigravity OAuth client</span>
          {s.configured ? <span className="pill ok-pill">Configured</span> : <span className="badge bad">Needs setup</span>}
        </div>
        <p className="plan-text">
          Atlas reaches Google's Cloud Code with the OAuth client that ships inside the Antigravity app. It is a
          credential, so it is not in Atlas's source: copy both values from the app into your keychain here, once.
        </p>
        <div className="claude-fields">
          {GEMINI_PLAN_SETTINGS.map((f) => (
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
        {s.configured && (
          <button className="ghost" onClick={props.onDone}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}
