import { useCallback, useEffect, useState } from 'react';
import { CHATGPT_USAGE_URL, type ChatGptModel, type ChatGptStatus, type Model } from '@atlas/shared';
import { api } from './api.ts';

/**
 * Can's ChatGPT plan (engine chatgpt.ts, OpenAI's « Sign in with ChatGPT » for open-source, locally hosted apps):
 * sign in, choose whether board work may use it, add its models, see when it's paused. Wording and actions follow
 * OpenAI's UI guidelines: « Continue with ChatGPT », « Manage usage » next to usage and on the limit.
 */
export function ChatGptSection(props: { status: ChatGptStatus | null; models: Model[]; onChanged(): void; onError(e: unknown): void }) {
  const { status: s, onError } = props;
  const [available, setAvailable] = useState<ChatGptModel[] | null>(null);
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
  const ready = !!s?.signedIn && s.planUsage;
  const loadModels = useCallback(() => api.chatgptModels().then(setAvailable, onError), [onError]);
  useEffect(() => {
    if (ready) void loadModels();
    else setAvailable(null);
  }, [ready, loadModels]);

  const signIn = () =>
    act('login', async () => {
      const { url } = await api.chatgptLogin();
      // The desktop app opens window.open links in the system browser (OpenAI requires it for sign-in).
      window.open(url, '_blank', 'noopener');
    });
  const added = new Set(props.models.filter((m) => m.provider === 'chatgpt').map((m) => m.name));

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
      ) : !s.signedIn ? (
        <div className="model-row plan-card">
          <div className="model-main">
            <div className="model-title">
              <span className="model-name">Use your ChatGPT plan</span>
            </div>
            <p className="plan-text">Complete AI requests in Atlas with usage included in your ChatGPT plan or credits balance. Atlas itself is free.</p>
            {s.lastError && <div className="model-error">{s.lastError}</div>}
          </div>
          <div className="model-actions">
            {s.pending ? (
              <>
                <span className="muted">Waiting for the browser…</span>
                <button className="ghost" onClick={() => act('cancel', () => api.chatgptCancel())}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="siwc-btn" data-oai-siwc-button="" disabled={busy === 'login'} onClick={signIn}>
                Continue with ChatGPT
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="model-list">
          <div className={'model-row plan-card ' + (s.pausedAt || !s.planUsage ? 'bad' : 'ok')}>
            <span className="dot-status" />
            <div className="model-main">
              <div className="model-title">
                <span className="model-name">{s.email ?? 'ChatGPT account'}</span>
                {s.planUsage && !s.pausedAt && <span className="pill ok-pill">Using ChatGPT plan</span>}
                {s.pausedAt && <span className="badge bad">Usage limit reached</span>}
                {!s.planUsage && <span className="badge bad">Plan use not allowed</span>}
              </div>
              {s.pausedAt ? (
                <p className="plan-text">
                  Requests are paused since {new Date(s.pausedAt).toLocaleString()}. The limit may be your plan's or the one you set for Atlas: review it in
                  ChatGPT settings, then resume.
                </p>
              ) : !s.planUsage ? (
                <p className="plan-text">You signed in without letting Atlas use your plan, so Atlas sends no requests. Allow it to use your ChatGPT models here.</p>
              ) : null}
              {s.lastError && !s.pausedAt && <div className="model-error">{s.lastError}</div>}

            </div>
            <div className="model-actions">
              {s.pausedAt ? (
                <>
                  <a className="primary small link-btn" href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                    Manage usage
                  </a>
                  <button className="ghost" onClick={() => act('resume', () => api.updateChatgpt({ resume: true }))}>
                    Resume
                  </button>
                </>
              ) : !s.planUsage ? (
                <button className="siwc-btn" data-oai-siwc-button="" disabled={busy === 'login' || s.pending} onClick={signIn}>
                  {s.pending ? 'Waiting for the browser…' : 'Continue with ChatGPT'}
                </button>
              ) : (
                <a className="tool link-btn" href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                  Manage usage
                </a>
              )}
              <button className="ghost danger" onClick={() => confirm('Sign out of ChatGPT? Agents on ChatGPT models stop until you sign in again.') && act('out', () => api.chatgptLogout())}>
                Sign out
              </button>
            </div>
          </div>
          {ready && (
            <div className="plan-models">
              <div className="plan-models-head">Models on your plan</div>
              {available === null ? (
                <span className="muted">Loading…</span>
              ) : available.length === 0 ? (
                <span className="muted">This account has no models for Atlas.</span>
              ) : (
                available.map((m) => (
                  <div key={m.slug} className="plan-model">
                    <span>{m.displayName}</span>
                    <code>{m.slug}</code>
                    {added.has(m.slug) ? (
                      <span className="muted">Added: pick it on an agent</span>
                    ) : (
                      <button
                        className="tool"
                        disabled={busy === 'add:' + m.slug}
                        onClick={() => act('add:' + m.slug, () => api.createModel({ id: modelId(m.slug), provider: 'chatgpt', name: m.slug }))}
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

/** An Atlas model id from an OpenAI slug ('gpt-6.1-sol' → 'gpt-6-1-sol'). */
export const modelId = (slug: string) => {
  const id = slug.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  return (/^[a-z]/.test(id) ? id : 'm-' + id).slice(0, 31);
};

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

/** « Using ChatGPT plan · Manage usage », near the composer of a chat whose agent runs on the plan. */
export function PlanNote() {
  return (
    <div className="plan-note">
      <span>Using ChatGPT plan</span>
      <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
        Manage usage
      </a>
    </div>
  );
}
