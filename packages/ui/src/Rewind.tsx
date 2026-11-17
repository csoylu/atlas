import { useCallback, useEffect, useRef, useState } from 'react';
import type { Card, FileChange, RewindPreview, RewindResult, Run } from '@atlas/shared';
import { api } from './api.ts';
import { rewindKey } from './composerKeys.ts';
import { filesLine, REWOUND } from './rewindText.ts';

/** How long the « Rewound · Undo » note stays (⌘Z keeps working while the composer is unchanged). */
const NOTE_MS = 10_000;

type Note = { kind: 'rewound'; result: RewindResult } | { kind: 'undone'; files: number; error: string | null } | { kind: 'busy'; text: string };

/** Text for the composer: `n` changes on every fill; `ifText` = only if the composer still holds exactly that. */
export type ComposerFill = { text: string; n: number; ifText?: string };

/**
 * Rewind for one chat (card #34): Stop/Esc rewinds the turn being answered, « Rewind to here » asks first, Undo (the
 * note's button, or ⌘Z while the composer holds the text put back) brings it all back. Mounted once per open chat.
 */
export function useRewind(card: Card, run: Run | null, onError: (e: unknown) => void, o: { globalEsc: boolean }) {
  const running = run?.status === 'running';
  const [note, setNote] = useState<Note | null>(null);
  const [confirm, setConfirm] = useState<RewindPreview | null>(null);
  const [fill, setFill] = useState<ComposerFill | null>(null);
  /** The rewind ⌘Z undoes, and the text it put back (null once the user sent something). */
  const [last, setLast] = useState<{ id: string; text: string } | null>(null);
  const busy = useRef(false);
  const fills = useRef(0);

  // Another chat: nothing carries over.
  useEffect(() => {
    setNote(null);
    setConfirm(null);
    setLast(null);
  }, [card.id]);

  useEffect(() => {
    if (!note || note.kind === 'busy') return;
    const t = setTimeout(() => setNote(null), note.kind === 'rewound' ? NOTE_MS : 4000);
    return () => clearTimeout(t);
  }, [note]);

  const done = useCallback((r: RewindResult) => {
    setNote({ kind: 'rewound', result: r });
    setLast({ id: r.id, text: r.text });
    setFill({ text: r.text, n: ++fills.current });
  }, []);

  const guard = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      if (busy.current) return;
      busy.current = true;
      setNote({ kind: 'busy', text: label });
      try {
        await fn();
      } catch (e) {
        setNote(null);
        onError(e);
      } finally {
        busy.current = false;
        setNote((n) => (n?.kind === 'busy' ? null : n));
      }
    },
    [onError],
  );

  /** Stop, or Esc during a run: rewinds the turn it answers (or just stops a run nobody asked for). */
  const stopTurn = useCallback(
    () =>
      guard('Stopping…', async () => {
        const r = await api.rewind(card.id);
        if (r) done(r);
      }),
    [card.id, done, guard],
  );

  const ask = useCallback((seq: number) => void api.rewindPreview(card.id, seq).then(setConfirm, onError), [card.id, onError]);

  const accept = useCallback(() => {
    const p = confirm;
    setConfirm(null);
    if (p) void guard('Rewinding…', async () => done((await api.rewind(card.id, p.seq))!));
  }, [card.id, confirm, done, guard]);

  const undo = useCallback(() => {
    const l = last;
    if (!l) return;
    void guard('Undoing…', async () => {
      const r = await api.undoRewind(l.id);
      setLast(null);
      // The message is back in the chat: empty the composer, unless it was edited since.
      setFill({ text: '', n: ++fills.current, ifText: l.text });
      setNote({ kind: 'undone', files: r.files.length, error: r.filesError });
    });
  }, [last, guard]);

  /** Undo from a rewind's row in the chat (#66): the same as the note's Undo when it is that rewind. */
  const undoById = useCallback(
    async (id: string) => {
      if (last?.id === id) return undo();
      await guard('Undoing…', async () => {
        const r = await api.undoRewind(id);
        setNote({ kind: 'undone', files: r.files.length, error: r.filesError });
      });
    },
    [last, undo, guard],
  );

  // Direct chats: Esc anywhere in the pane (not in a dialog, not already handled) rewinds a running turn.
  useEffect(() => {
    if (!o.globalEsc) return;
    const key = (e: KeyboardEvent) => {
      if (rewindKey(e, { running, undoable: false, text: '', filled: null, mac: isMac(), inModal: inModal() }) !== 'rewind') return;
      e.preventDefault();
      void stopTurn();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [o.globalEsc, running, stopTurn]);

  return {
    running,
    note,
    confirm,
    fill,
    stopTurn,
    ask,
    accept,
    cancel: () => setConfirm(null),
    undo,
    undoById,
    dismiss: () => setNote(null),
    /** The composer's keys: Esc (during a run) and ⌘Z (unchanged composer). True when handled. */
    composerKey(e: KeyboardEvent, text: string): boolean {
      const k = rewindKey(e, { running, undoable: !!last, text, filled: last?.text ?? null, mac: isMac(), inModal: inModal() });
      if (!k) return false;
      e.preventDefault();
      if (k === 'rewind') void stopTurn();
      else undo();
      return true;
    },
    /** A message was sent: the rewind can no longer be undone. */
    sent() {
      setLast(null);
      setNote((n) => (n?.kind === 'busy' ? n : null));
    },
    /** A run that ended because of a rewind says nothing more than the note did. */
    hideRun: run?.status === 'stopped' && run.error === REWOUND,
  };
}

export type Rewind = ReturnType<typeof useRewind>;

/** A modal is open (card modal, palette, a confirm…): Esc there only closes it (card #78). */
const inModal = () => !!document.querySelector('[aria-modal="true"]');

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The quiet line above the composer after a rewind: what happened, and Undo. */
export function RewindNote({ rw }: { rw: Rewind }) {
  const n = rw.note;
  if (!n) return null;
  if (n.kind === 'busy')
    return (
      <div className="rewind-note" role="status">
        <span className="pulse" /> {n.text}
      </div>
    );
  if (n.kind === 'undone')
    return (
      <div className="rewind-note" role="status">
        <span>
          Rewind undone{n.files ? ` · ${n.files} ${n.files === 1 ? 'file' : 'files'} put back` : ''}
          {n.error && <span className="rewind-warn"> · {n.error}</span>}
        </span>
      </div>
    );
  const r = n.result;
  return (
    <div className="rewind-note" role="status">
      <RewindIcon />
      <span className="rewind-text">
        Rewound · {r.filesError && !r.files.length ? <span className="rewind-warn" title={r.filesError}>files not restored</span> : filesLine(r.files)}
        {r.filesError && r.files.length > 0 && (
          <span className="rewind-warn" title={r.filesError}>
            {' '}
            · some changes stay
          </span>
        )}
      </span>
      <button type="button" className="ghost small" onClick={rw.undo} title={isMac() ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)'}>
        Undo
      </button>
      <button type="button" className="ghost small rewind-x" onClick={rw.dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

/** « Rewind to here? »: what gets hidden and which files come back, before anything changes. */
export function RewindConfirm({ rw }: { rw: Rewind }) {
  const p = rw.confirm;
  const { cancel } = rw;
  useEffect(() => {
    if (!p) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [p, cancel]);
  if (!p) return null;
  const later = p.hidden - 1;
  return (
    <div className="modal-scrim rewind-scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="modal rewind-confirm" role="dialog" aria-modal="true" aria-labelledby="rewind-title">
        <h2 id="rewind-title">Rewind to this message?</h2>
        <p>
          {later > 0
            ? `It and the ${later} ${later === 1 ? 'message' : 'messages'} after it leave the chat, and the agent forgets them.`
            : 'It leaves the chat, and the agent forgets it.'}{' '}
          Your text goes back in the message box to edit and resend.
        </p>
        {p.filesError && <p className="rewind-warn">{cap(p.filesError)}.</p>}
        {p.files.length ? (
          <div className="rewind-files">
            <div className="rewind-files-head">{cap(filesLine(p.files))} in the agent's folder</div>
            <ul>
              {p.files.map((f) => (
                <li key={f.path}>
                  <span className="rewind-path" title={f.path}>
                    {f.path}
                  </span>
                  <span className={'rewind-change ' + f.change}>{changeLabel[f.change]}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : p.filesError ? null : (
          <p>No files changed since then.</p>
        )}
        <p className="rewind-fine">
          Only files this chat changed come back; other chats' and tasks' work is left alone. What it did elsewhere (commands, messages, other services) stays
          done.
        </p>
        <div className="rewind-actions">
          <button type="button" className="ghost" onClick={cancel}>
            Cancel
          </button>
          <button type="button" className="primary" autoFocus onClick={rw.accept}>
            Rewind
          </button>
        </div>
      </div>
    </div>
  );
}

const changeLabel: Record<FileChange['change'], string> = { restored: 'restored', recreated: 'brought back', deleted: 'removed' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The small counter-clockwise arrow of « Rewind to here » and the note. */
export function RewindIcon() {
  return (
    <svg className="rewind-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3.5v3h3" />
      <path d="M3.4 6.5A5 5 0 1 1 3.8 10" />
    </svg>
  );
}
