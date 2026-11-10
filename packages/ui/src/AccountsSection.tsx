import { useCallback, useEffect, useState } from 'react';
import type { Account, RateLimit } from '@atlas/shared';
import { api } from './api.ts';

/**
 * Anthropic accounts (engine accounts.ts): API keys tried top to bottom. If one is rate-limited, out of credit or
 * refused, the call moves to the next and that account waits until Anthropic says it resets. Limits are the
 * rate-limit headers of the account's last call; « today » counts what Atlas sent through it.
 */
export function AccountsSection(props: { keyStore: string | null; onChanged(): void; onError(e: unknown): void }) {
  const { onError } = props;
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const reload = useCallback(() => api.accounts().then(setAccounts, onError), [onError]);
  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), 20_000); // cooldowns end and limits refill on their own
    return () => clearInterval(t);
  }, [reload]);

  const act = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await f();
      await reload();
      props.onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(null);
    }
  };
  const move = (i: number, d: -1 | 1) => {
    if (!accounts) return;
    const ids = accounts.map((a) => a.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    void act('order', () => api.reorderAccounts(ids));
  };
  const next = accounts?.find((a) => a.enabled && a.keyPresent && !a.cooldownUntil)?.id;

  return (
    <section>
      <header className="section-head">
        <h2>Anthropic accounts</h2>
        <p>
          Claude models use these API keys from top to bottom. When one hits its rate limit, runs out of credit or is
          refused, Atlas moves to the next and comes back when Anthropic says it resets. Claude subscriptions (Pro, Max)
          are not API keys. Direct subscription sign-in is not integrated; it requires authorized Anthropic OAuth access.
        </p>
      </header>
      <div className="model-list">
        {accounts?.map((a, i) => {
          const state = !a.enabled ? 'off' : !a.keyPresent ? 'bad' : a.cooldownUntil ? 'wait' : a.lastError ? 'bad' : 'ok';
          return (
            <div key={a.id} className={'model-row account-row ' + state}>
              <div className="order">
                <button className="ghost" aria-label={`Move ${a.label} up`} disabled={i === 0 || busy === 'order'} onClick={() => move(i, -1)}>
                  <Chevron up />
                </button>
                <span className="num rank">{i + 1}</span>
                <button
                  className="ghost"
                  aria-label={`Move ${a.label} down`}
                  disabled={i === accounts.length - 1 || busy === 'order'}
                  onClick={() => move(i, 1)}
                >
                  <Chevron />
                </button>
              </div>
              <div className="model-main">
                <div className="model-title">
                  <span className="model-name">{a.label}</span>
                  {a.id === next && <span className="pill ok-pill">In use</span>}
                  {a.cooldownUntil && <span className="pill">Waiting until {time(a.cooldownUntil)}</span>}
                  {!a.enabled && <span className="badge">Off</span>}
                  {!a.keyPresent && <span className="badge bad">Key missing</span>}
                </div>
                <Limits a={a} />
                {a.lastError && a.enabled && <div className="model-error">{a.lastError}</div>}
                {tests[a.id] && <div className={tests[a.id] === 'Key works' ? 'model-ok' : 'model-error'}>{tests[a.id]}</div>}
              </div>
              <div className="model-actions">
                <label className="switch" title={a.enabled ? 'On: used in its turn' : 'Off: skipped'}>
                  <input type="checkbox" checked={a.enabled} onChange={(e) => act('en:' + a.id, () => api.updateAccount(a.id, { enabled: e.target.checked }))} />
                  <span />
                </label>
                <button
                  className="tool"
                  disabled={busy === 'test:' + a.id}
                  onClick={() =>
                    act('test:' + a.id, () =>
                      api.testAccount(a.id).then((r) => setTests((t) => ({ ...t, [a.id]: r.ok ? 'Key works' : (r.error ?? 'failed') }))),
                    )
                  }
                >
                  {busy === 'test:' + a.id ? 'Testing…' : 'Test'}
                </button>
                {props.keyStore && (
                  <button
                    className="ghost"
                    onClick={() => {
                      const key = prompt(`New API key for ${a.label}`);
                      if (key?.trim()) void act('key:' + a.id, () => api.updateAccount(a.id, { key: key.trim() }));
                    }}
                  >
                    Replace key
                  </button>
                )}
                <button className="ghost danger" onClick={() => confirm(`Remove the account ${a.label}?`) && act('del:' + a.id, () => api.deleteAccount(a.id))}>
                  Remove
                </button>
              </div>
            </div>
          );
        })}
        {accounts?.length === 0 && <div className="empty-note">No account yet. Claude models can't run until you add one.</div>}
        <NewAccount keyStore={props.keyStore} onCreated={() => act('new', async () => {})} onError={onError} />
      </div>
    </section>
  );
}

function Limits({ a }: { a: Account }) {
  const l = a.limits;
  return (
    <div className="limits">
      {l ? (
        <>
          <Bar label="Requests / min" r={l.requests} />
          <Bar label="Input tokens / min" r={l.input ?? l.tokens} />
          <Bar label="Output tokens / min" r={l.output} />
        </>
      ) : (
        <span className="muted">Limits show after the first call.</span>
      )}
      <span className="today num">
        Today {a.today.calls} call{a.today.calls === 1 ? '' : 's'} · {compact(a.today.input)} in · {compact(a.today.output)} out
      </span>
    </div>
  );
}

function Bar({ label, r }: { label: string; r: RateLimit | null }) {
  if (!r) return null;
  const left = r.limit ? r.remaining / r.limit : 0;
  return (
    <div className="limit" title={r.reset ? `Full again at ${time(r.reset)}` : undefined}>
      <div className="limit-head">
        <span>{label}</span>
        <span className="num">
          {compact(r.remaining)} of {compact(r.limit)} left
        </span>
      </div>
      <div className={'progress' + (left < 0.1 ? ' low' : '')} role="meter" aria-valuenow={Math.round(left * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <span style={{ width: Math.max(0, Math.min(100, left * 100)) + '%' }} />
      </div>
    </div>
  );
}

function NewAccount(props: { keyStore: string | null; onCreated(): void; onError(e: unknown): void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  if (!open)
    return (
      <button className="model-row add" onClick={() => setOpen(true)}>
        + Add an Anthropic account
      </button>
    );
  const byKey = !!props.keyStore;
  return (
    <form
      className="model-row new account-new"
      onSubmit={(e) => {
        e.preventDefault();
        api
          .createAccount(byKey ? { label: label.trim(), key: value.trim() } : { label: label.trim(), secret: value.trim() })
          .then(() => {
            setOpen(false);
            setLabel('');
            setValue('');
            props.onCreated();
          }, props.onError);
      }}
    >
      <label className="field">
        Name
        <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Datinel, Personal" />
      </label>
      <label className="field grow">
        {byKey ? 'API key' : 'Env var holding the key'}
        <input
          type={byKey ? 'password' : 'text'}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(byKey ? e.target.value : e.target.value.toUpperCase())}
          placeholder={byKey ? 'sk-ant-…' : 'ANTHROPIC_KEY_WORK'}
          className={byKey ? 'mono' : 'mono'}
        />
      </label>
      <div className="actions">
        <button type="button" className="ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button className="primary small" disabled={!label.trim() || !value.trim()}>
          Add
        </button>
      </div>
      <p className="muted form-note">
        {byKey
          ? `Create a key at console.anthropic.com → API keys. It's encrypted with the ${props.keyStore} and never shown again.`
          : "Set the variable in the engine's environment first; only its name is stored."}
      </p>
    </form>
  );
}

function Chevron({ up }: { up?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={up ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} />
    </svg>
  );
}
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const compact = (n: number) => (n < 100_000 ? n.toLocaleString('en') : Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n));
