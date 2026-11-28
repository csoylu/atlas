import { useCallback, useEffect, useState } from 'react';
import { CLAUDE_PLAN_SETTINGS, type ClaudePlanSetting, type ClaudePlanStatus } from '@atlas/shared';
import { api } from './api.ts';
import { PlanAccountList } from './PlanAccounts.tsx';
import type { MessageStream } from './useMessages.ts';
import { EmptyState } from './Kit.tsx';

/** Claude subscription sign-in, accounts and limit status. Its models are added on Settings → Model list (#101). */
export function ClaudePlanSection(props: { stream: MessageStream; keyStore: string | null; onChanged(): void; onError(e: unknown): void }) {
  const { stream, onError } = props;
  const [s, setS] = useState<ClaudePlanStatus | null>(null);
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

  const signIn = (accountId?: string) =>
    act('login', async () => {
      const { url } = await api.claudeLogin(accountId);
      window.open(url, '_blank', 'noopener');
    });
  const showSettings = editing || (s && !s.configured);
  const pasteCode = (
    <>
      <label>Paste the authorization code shown by Claude
        <input type="password" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} placeholder="code#state" />
      </label>
      <button className="btn primary" disabled={!code.trim() || busy === 'complete'} onClick={() => act('complete', async () => { await api.claudeComplete(code); setCode(''); })}>Finish sign-in</button>
      <button className="btn ghost" onClick={() => act('cancel', () => api.claudeCancel())}>
        Cancel
      </button>
    </>
  );

  return (
    <section className="set-sec first">
      <header className="section-head">
        <h2>Claude plan</h2>
        <p>
          Sign in with one or more Claude subscriptions using OAuth. No client setup is required. For normal API-key billing, use Anthropic accounts instead.
        </p>
      </header>
      {!s ? null : !s.available ? (
        <EmptyState title={s.unavailableReason} />
      ) : (
        <div className="model-list">
          {showSettings ? (
            <ClaudeSettings status={s} keyStore={props.keyStore} onDone={() => setEditing(false)} onSaved={load} onError={onError} />
          ) : null}
          {s.configured && s.accounts.length === 0 ? (
            <div className="model-row plan-card">
              <div className="model-main">
                <div className="model-title">
                  <span className="model-name">Use your Claude plan</span>
                </div>
                <p className="plan-text">Complete AI requests in Atlas with usage included in your Claude plan.</p>
                {s.lastError && <div className="state-err">{s.lastError}</div>}
              </div>
              <div className="model-actions">
                {s.pending ? pasteCode : (
                  <button className="btn primary" disabled={busy === 'login'} onClick={() => signIn()}>
                    Sign in with Claude
                  </button>
                )}
              </div>
            </div>
          ) : s.configured ? (
            <PlanAccountList
              provider="claude_plan"
              accounts={s.accounts}
              quotaNone={<span className="muted">No usage reported yet: it shows after the next answer.</span>}
              signIn={(a) =>
                s.pending && s.pendingAccountId === a.id ? pasteCode : (
                  <button className="btn primary" disabled={busy === 'login' || s.pending} onClick={() => signIn(a.id)}>
                    Sign in with Claude
                  </button>
                )
              }
              signOut={(a) => api.claudeLogout(a.id)}
              badge={() => <span className="badge ok">Using Claude plan</span>}
              onChanged={() => void load().then(props.onChanged)}
              onError={onError}
            />
          ) : null}
          {s.configured && !editing && (
            <div className="plan-add">
              <button className="btn ghost small" onClick={() => setEditing(true)}>
                Advanced settings
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

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
          {s.configured ? <span className="badge ok">Complete</span> : <span className="badge bad">Not set up</span>}
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
          <ul className="state-err claude-problems">
            {s.configProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="model-actions">
        {props.keyStore && (
          <button className="btn primary" disabled={saving || Object.keys(draft).length === 0} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
        {s.configured && (
          <button className="btn ghost" onClick={props.onDone}>
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
        <p>Agents on Claude plan models now use your Claude plan's usage. When a subscription reaches its limit, work moves to your next one; when all are out, Atlas waits until the first resets.</p>
        <button className="btn primary" autoFocus onClick={props.onDone}>
          Got it
        </button>
      </div>
    </div>
  );
}
