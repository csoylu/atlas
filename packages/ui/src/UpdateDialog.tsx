import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { UpdateStatus } from '@atlas/shared';
import { api, ApiError } from './api.ts';
import { aboutLine, badgeLabel, busy, latestOf, noteHeading, percent, workingLine } from './update.ts';
import { Skeleton } from './Kit.tsx';

/**
 * App updates (#123, docs/updater.md): the sidebar badge, the dialog (what changed since your version, who is working,
 * Update with progress) and the Settings → About block. Installing happens only when Master clicks Update.
 */

export function UpdateBadge({ status, onOpen }: { status: UpdateStatus | null; onOpen(): void }) {
  const label = badgeLabel(status);
  if (!status || !label) return null;
  const failed = status.phase === 'failed';
  return (
    <button type="button" className={'update-badge' + (failed ? ' failed' : '')} onClick={onOpen} title={`Atlas ${latestOf(status)?.version ?? status.target ?? ''}: see what's new`}>
      {busy(status) ? <span className="step-sq" aria-hidden="true" /> : <span className="update-dot" aria-hidden="true" />}
      <span className="update-badge-label">{label}</span>
      {!busy(status) && latestOf(status) && <span className="update-badge-v num">{latestOf(status)!.version}</span>}
    </button>
  );
}

export function UpdateDialog({ status, onClose, onError }: { status: UpdateStatus; onClose(): void; onError(e: unknown): void }) {
  const [starting, setStarting] = useState(false);
  const latest = latestOf(status);
  const going = busy(status) || starting;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !going) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [going, onClose]);
  const update = () => {
    setStarting(true);
    // A failed install (download, checksum) arrives as the status (phase 'failed', shown here); anything else in the banner.
    api.installUpdate().catch((e: unknown) => {
      setStarting(false);
      if (!(e instanceof ApiError && e.status === 500)) onError(e);
    });
  };
  const pct = percent(status);
  return (
    <div className="modal-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !going && onClose()}>
      <div className="modal update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <h2 id="update-title">{latest ? `Update to Atlas ${latest.version}` : 'Atlas is up to date'}</h2>
        <p>
          You have Atlas <span className="num">{status.current}</span>.
          {status.releases.length > 1 && ` ${status.releases.length} versions came out since; updating installs the latest.`}
        </p>
        {status.releases.length > 0 && (
          <div className="update-notes" aria-label="What changed">
            {status.releases.map((r) => {
              const h = noteHeading(r.notes);
              return (
                <section key={r.version} className="update-note">
                  <div className="update-note-head">
                    <span className="update-v num">{r.version}</span>
                    {h && <span className={'update-kind ' + h.kind.toLowerCase()}>{h.kind}</span>}
                    {h?.task && <span className="update-task num">{h.task}</span>}
                  </div>
                  {h ? (
                    <>
                      <div className="update-note-title">{h.title}</div>
                      {h.body && <div className="update-note-body"><Markdown remarkPlugins={[remarkGfm]}>{h.body}</Markdown></div>}
                    </>
                  ) : (
                    <div className="update-note-body"><Markdown remarkPlugins={[remarkGfm]}>{r.notes || 'No notes.'}</Markdown></div>
                  )}
                </section>
              );
            })}
          </div>
        )}
        {latest && (
          <div className="update-working">
            <p>Atlas restarts to update. {workingLine(status)}</p>
            {status.working.length > 0 && (
              <ul>
                {status.working.map((w, i) => (
                  <li key={i}>
                    <span className="update-agent">@{w.agent}</span>
                    {w.card != null && <span className="num update-task">#{w.card}</span>}
                    <span className="update-work-title">{w.card == null ? 'chat' : w.title}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {status.phase === 'failed' && status.error && <p className="state-err" role="alert">{status.error}</p>}
        {status.cannotInstall && latest && <p className="update-fine">{status.cannotInstall}</p>}
        {going && (
          <div className="update-progress" role="status">
            <div className="update-bar"><div style={{ width: `${status.phase === 'downloading' ? (pct ?? 5) : 100}%` }} /></div>
            <span>
              {status.phase === 'verifying' ? 'Checking the download…' : status.phase === 'installing' ? 'Restarting Atlas…' : `Downloading${pct == null ? '…' : ` ${pct}%`}`}
            </span>
          </div>
        )}
        <div className="update-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={going}>
            {latest ? 'Later' : 'Close'}
          </button>
          {latest && (
            <button type="button" className="btn primary" autoFocus disabled={going || !!status.cannotInstall} onClick={update}>
              {status.phase === 'failed' ? 'Try again' : 'Update and restart'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Settings → About & data: current version, last check, « Check now ». */
export function UpdateAbout({ status, onOpen, onError }: { status: UpdateStatus | null; onOpen(): void; onError(e: unknown): void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!status) return <Skeleton />;
  return (
    <div className="update-about">
      <span className={status.checkError ? 'update-about-line bad' : 'update-about-line'}>{aboutLine(status)}</span>
      <span className="update-about-acts">
        {latestOf(status) && (
          <button type="button" className="btn primary small" onClick={onOpen}>
            See what's new
          </button>
        )}
        <button type="button" className="btn ghost small" disabled={status.checking} onClick={() => api.checkUpdate().catch(onError)}>
          Check now
        </button>
      </span>
      {status.lastUpdate && (
        <span className="update-fine">
          Updated from <span className="num">{status.lastUpdate.from}</span> to <span className="num">{status.lastUpdate.to}</span> on {new Date(status.lastUpdate.at).toLocaleString()}.
        </span>
      )}
    </div>
  );
}
