import { useState, type FormEvent } from 'react';
import type { Card } from '@atlas/shared';
import { api } from './api.ts';
import { StatusIcon } from './StatusIcon.tsx';

/**
 * Tasks whose secret was saved from a box in this window (#297): card id → the secret's name, never a value. The task
 * leaves « blocked » right after, so every place that showed the box shows « Saved NAME » instead of nothing.
 */
const saved = new Map<string, string>();

/** What a task's secret box shows: the box (it waits for a value), « Saved » (typed here), or nothing. */
export function secretBoxOf(card: Card): { kind: 'ask'; name: string; description: string } | { kind: 'saved'; name: string } | null {
  const s = card.status === 'blocked' ? card.block?.secret : null;
  if (s) return { kind: 'ask', name: s.name, description: s.description };
  const name = saved.get(card.id);
  return name ? { kind: 'saved', name } : null;
}

/**
 * « Needs secret X » in the chat (#297): the secret's name and the agent's description, a masked field (Show / Hide)
 * and Save. The value goes to POST /api/cards/:id/secret and nowhere else: not a message, not kept here (the field is
 * emptied at once). Errors (empty, a store that is locked…) stay in the box; nothing is stored then.
 */
export function SecretBox({ card }: { card: Card }) {
  const box = secretBoxOf(card);
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!box) return null;
  const agent = card.assignee ? '@' + card.assignee : 'the agent';
  if (box.kind === 'saved')
    return (
      <div className="secbox saved" role="status">
        <StatusIcon status="done" title="" />
        <span>
          Saved <code>{box.name}</code> · {agent} carries on
        </span>
      </div>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!value.trim()) return setError('Type or paste the value first: nothing was stored.');
    setBusy(true);
    setError(null);
    api.saveCardSecret(card.id, value).then(
      () => {
        saved.set(card.id, box.name);
        setValue('');
        setBusy(false);
      },
      (err: unknown) => {
        setValue('');
        setBusy(false);
        setError(err instanceof Error ? err.message : String(err));
      },
    );
  };
  return (
    <form className={'secbox' + (error ? ' has-error' : '')} onSubmit={submit} aria-label={`Value of the secret ${box.name}`}>
      <div className="secbox-head">
        <code className="secbox-name">{box.name}</code>
        {box.description && <span className="secbox-desc">{box.description}</span>}
      </div>
      <div className="secbox-row">
        <span className="secbox-field">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => (setValue(e.target.value), error && setError(null))}
            placeholder="Paste the value"
            aria-label={`Value of ${box.name}`}
            aria-invalid={!!error}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            data-1p-ignore
            data-lpignore="true"
            disabled={busy}
          />
          <button type="button" className="secbox-eye" onClick={() => setShow((x) => !x)} aria-pressed={show} aria-label={show ? 'Hide the value' : 'Show the value'}>
            {show ? 'Hide' : 'Show'}
          </button>
        </span>
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {error && <p className="state-err inline secbox-err">{error}</p>}
      <p className="secbox-note">
        Kept in the secret store for {agent} only, never shown again; the task restarts. <a href="#/settings/secrets">Settings → Secrets</a>
      </p>
    </form>
  );
}
