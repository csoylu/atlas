import { useState } from 'react';
import { CHATGPT_USAGE_URL, type ChatGptStatus } from '@atlas/shared';
import { api } from './api.ts';
import { PlanAccountList } from './PlanAccounts.tsx';

/**
 * The user's ChatGPT plan (engine chatgpt.ts, OpenAI's « Sign in with ChatGPT » for open-source, locally hosted apps):
 * sign in, choose whether board work may use it, see when it's paused (its models are added on Settings → Model list). Wording and actions follow
 * OpenAI's UI guidelines: « Continue with ChatGPT », « Manage usage » next to usage and on the limit.
 */
export function ChatGptSection(props: { status: ChatGptStatus | null; onChanged(): void; onError(e: unknown): void }) {
  const { status: s, onError } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await f();
      props.onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };

  const signIn = (accountId?: string) =>
    act('login', async () => {
      const { url } = await api.chatgptLogin(accountId);
      // The desktop app opens window.open links in the system browser (OpenAI requires it for sign-in).
      window.open(url, '_blank', 'noopener');
    });
  const siwc = (accountId?: string) =>
    s?.pending && (!accountId || s.pendingAccountId === accountId) ? (
      <>
        <span className="muted">Waiting for the browser…</span>
        <button className="ghost" onClick={() => act('cancel', () => api.chatgptCancel())}>
          Cancel
        </button>
      </>
    ) : (
      <button className="siwc-btn" data-oai-siwc-button="" disabled={busy === 'login' || !!s?.pending} onClick={() => signIn(accountId)}>
        Continue with ChatGPT
      </button>
    );
  const manage = (
    <a className="tool link-btn" href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
      Manage usage
    </a>
  );

  return (
    <section>
      <header className="section-head">
        <h2>ChatGPT plan</h2>
        <p>
          Run agents on OpenAI models with usage included in your ChatGPT plan (Go, Plus, Pro, Business), instead of an
          API key. Atlas signs in as itself through OpenAI's « Sign in with ChatGPT »; it never sees your password or
          your conversations, and your plan's limits apply.
        </p>
      </header>
      {!s ? null : !s.available ? (
        <div className="empty-note">{s.unavailableReason}</div>
      ) : s.accounts.length === 0 ? (
        <div className="model-row plan-card">
          <div className="model-main">
            <div className="model-title">
              <span className="model-name">Use your ChatGPT plan</span>
            </div>
            <p className="plan-text">Complete AI requests in Atlas with usage included in your ChatGPT plan or credits balance. Atlas itself is free.</p>
            {s.lastError && <div className="model-error">{s.lastError}</div>}
          </div>
          <div className="model-actions">{siwc()}</div>
        </div>
      ) : (
        <div className="model-list">
          <PlanAccountList
            provider="chatgpt"
            accounts={s.accounts}
            quotaNone={
              <span className="muted">
                OpenAI sends no plan usage to Atlas: see it in ChatGPT.{' '}
                <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                  Manage usage
                </a>
              </span>
            }
            signIn={(a) => siwc(a.id)}
            signOut={(a) => api.chatgptLogout(a.id)}
            badge={(a) => (a.planUsage ? <span className="pill ok-pill">Using ChatGPT plan</span> : <span className="badge bad">Plan use not allowed</span>)}
            extra={(a) =>
              a.signedIn && !a.planUsage ? (
                <div className="plan-text">
                  You signed in without letting Atlas use this plan, so Atlas sends it no requests. {siwc(a.id)}
                </div>
              ) : a.paused ? (
                <div className="plan-text">The limit may be your plan's or the one you set for Atlas. {manage}</div>
              ) : null
            }
            onChanged={props.onChanged}
            onError={onError}
          />
        </div>
      )}
    </section>
  );
}

/** The one-time notice after the first sign-in with plan use (OpenAI's guidelines: shown once, then Got it). */
export function PlanWelcome(props: { onDone(): void }) {
  return (
    <div className="modal-scrim" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="plan-welcome">
        <h2 id="plan-welcome">You're using your ChatGPT plan</h2>
        <p>
          AI requests from agents on ChatGPT models now use your ChatGPT plan. You can review usage and set a limit for Atlas in{' '}
          <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
            ChatGPT settings
          </a>
          .
        </p>
        <button className="primary" autoFocus onClick={props.onDone}>
          Got it
        </button>
      </div>
    </div>
  );
}
