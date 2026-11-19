import { useEffect, useState, type ReactNode } from 'react';
import type { PlanAccount, PlanProvider, PlanQuota, PlanWindow } from '@atlas/shared';
import { api } from './api.ts';

/** Past this share of a window, bars and the composer gauge turn amber (11 Nov 2026). */
export const QUOTA_WARN = 80;

/** « 16:40 » today, « Mon 09:00 » on another day. */
export function resetLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
export function ago(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

/** Re-render every minute (« updated N min ago », reset times). */
function useMinute() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
}

function Bar(props: { label: string; w: PlanWindow }) {
  const pct = Math.round(props.w.usedPct);
  const reset = resetLabel(props.w.resetsAt);
  return (
    <div className={'quota' + (pct >= QUOTA_WARN ? ' warm' : '')}>
      <div className="quota-head">
        <span>{props.label}</span>
        <span className="num">
          {pct}%{reset ? ` · resets ${reset}` : ''}
        </span>
      </div>
      <div className="quota-bar" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={props.label}>
        <i style={{ width: `${Math.min(100, Math.max(pct, 1))}%` }} />
      </div>
    </div>
  );
}

/** The 5-hour and weekly windows of one subscription, from its latest response. */
export function QuotaBars(props: { quota: PlanQuota | null; none: ReactNode }) {
  useMinute();
  const q = props.quota;
  if (!q || (!q.fiveHour && !q.week)) return <div className="quota-none">{props.none}</div>;
  return (
    <div className="quotas">
      {q.fiveHour && <Bar label="5-hour window" w={q.fiveHour} />}
      {q.week && <Bar label="Weekly" w={q.week} />}
      <div className="quota-at">updated {ago(q.at)}</div>
    </div>
  );
}

/**
 * The subscriptions of one plan provider, in failover order: each with its name, sign-in state, quota and actions.
 * `signIn` renders the provider's own sign-in controls for an account that isn't signed in.
 */
export function PlanAccountList(props: {
  provider: PlanProvider;
  accounts: PlanAccount[];
  signIn(a: PlanAccount): ReactNode;
  signOut(a: PlanAccount): Promise<unknown>;
  badge?(a: PlanAccount): ReactNode;
  extra?(a: PlanAccount): ReactNode;
  quotaNone: ReactNode;
  onChanged(): void;
  onError(e: unknown): void;
}) {
  const { accounts, provider } = props;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const word = provider === 'claude_plan' ? 'Claude' : 'ChatGPT';
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      props.onChanged();
    } catch (e) {
      props.onError(e);
    }
  };
  // Drag a row by its grip to change the failover order (arrow keys on the grip do the same).
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const reorder = (ids: string[]) => {
    if (ids.join() !== accounts.map((a) => a.id).join()) void act(() => api.reorderPlanAccounts(provider, ids));
  };
  const move = (i: number, d: -1 | 1) => {
    if (i + d < 0 || i + d >= accounts.length) return;
    const ids = accounts.map((a) => a.id);
    [ids[i], ids[i + d]] = [ids[i + d]!, ids[i]!];
    reorder(ids);
  };
  const drop = () => {
    if (dragging && over && dragging !== over.id) {
      const ids = accounts.map((a) => a.id).filter((id) => id !== dragging);
      const at = ids.indexOf(over.id) + (over.after ? 1 : 0);
      ids.splice(at, 0, dragging);
      reorder(ids);
    }
    setDragging(null);
    setOver(null);
  };
  const saveName = (id: string | null) => {
    const label = name.trim();
    if (!label) return;
    void act(async () => {
      if (id) await api.updatePlanAccount(id, { label });
      else await api.createPlanAccount({ provider, label });
      setRenaming(null);
      setAdding(false);
      setName('');
    });
  };
  const nameInput = (id: string | null) => (
    <span className="plan-rename">
      <input
        autoFocus
        value={name}
        maxLength={40}
        placeholder={id ? 'Name' : 'Name, e.g. Work'}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') saveName(id);
          if (e.key === 'Escape') (setRenaming(null), setAdding(false));
        }}
      />
      <button className="btn primary small" disabled={!name.trim()} onClick={() => saveName(id)}>
        {id ? 'Save' : 'Add'}
      </button>
      <button className="btn ghost small" onClick={() => (setRenaming(null), setAdding(false))}>
        Cancel
      </button>
    </span>
  );

  return (
    <>
      {accounts.length > 1 && <p className="plan-order-note">Atlas uses them in this order: when one reaches its usage limit, work moves to the next and you get a notification. Drag ⠿ to reorder.</p>}
      {accounts.map((a, i) => (
        <div
          key={a.id}
          className={
            'model-row plan-card ' +
            (!a.signedIn ? '' : a.paused || !a.planUsage ? 'bad' : 'ok') +
            (dragging === a.id ? ' dragging' : '') +
            (over?.id === a.id && dragging !== a.id ? (over.after ? ' drop-after' : ' drop-before') : '')
          }
          onDragOver={(e) => {
            if (!dragging) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setOver({ id: a.id, after: e.clientY > r.top + r.height / 2 });
          }}
          onDrop={(e) => {
            e.preventDefault();
            drop();
          }}
        >
          {accounts.length > 1 && (
            <button
              className="grip"
              draggable
              title="Drag to change the order (or use the arrow keys)"
              aria-label={`Move ${a.label}: position ${i + 1} of ${accounts.length}`}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', a.id);
                const row = e.currentTarget.parentElement;
                if (row) e.dataTransfer.setDragImage(row, 16, 16);
                setDragging(a.id);
              }}
              onDragEnd={() => (setDragging(null), setOver(null))}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                  e.preventDefault();
                  move(i, e.key === 'ArrowUp' ? -1 : 1);
                }
              }}
            >
              ⠿
            </button>
          )}
          {a.signedIn && <span className="dot-status" />}
          <div className="model-main">
            <div className="model-title">
              {renaming === a.id ? (
                nameInput(a.id)
              ) : (
                <>
                  <span className="model-name">{a.label}</span>
                  {a.email && <span className="muted">{a.email}</span>}
                  {!a.signedIn ? (
                    <span className="badge">Not signed in</span>
                  ) : a.paused ? (
                    <span className="badge bad">Limit reached{a.pausedUntil ? ` · back ${resetLabel(a.pausedUntil)}` : ''}</span>
                  ) : (
                    (props.badge?.(a) ?? <span className="badge ok">Signed in</span>)
                  )}
                </>
              )}
            </div>
            {a.signedIn && <QuotaBars quota={a.quota} none={props.quotaNone} />}
            {a.paused && !a.pausedUntil && <p className="plan-text">Paused until you resume it ({word} gave no reset time).</p>}
            {a.lastError && <div className="state-err">{a.lastError}</div>}
            {props.extra?.(a)}
          </div>
          <div className="model-actions">
            {!a.signedIn && props.signIn(a)}
            {a.paused && (
              <button className="btn ghost" onClick={() => void act(() => api.updatePlanAccount(a.id, { resume: true }))}>
                Resume
              </button>
            )}
            {renaming !== a.id && (
              <button className="btn ghost" onClick={() => (setRenaming(a.id), setName(a.label))}>
                Rename
              </button>
            )}
            {a.signedIn && (
              <button className="btn ghost danger" onClick={() => confirm(`Sign out of ${word} « ${a.label} »?`) && void act(() => props.signOut(a))}>
                Sign out
              </button>
            )}
            {(!a.signedIn || accounts.length > 1) && (
              <button
                className="btn ghost danger"
                onClick={() => confirm(`Remove the ${word} subscription « ${a.label} »${a.signedIn ? ' (signs it out)' : ''}?`) && void act(() => api.deletePlanAccount(a.id))}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      ))}
      <div className="plan-add">{adding ? nameInput(null) : <button className="btn" onClick={() => (setAdding(true), setName(''))}>+ Add {word} subscription</button>}</div>
    </>
  );
}
