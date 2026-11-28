import { useEffect, type ReactNode } from 'react';
import { StatusIcon, STATUS_LABEL, type IconStatus } from './StatusIcon.tsx';
import { priorityHint, priorityName } from './priority.ts';
import type { ToastMsg } from './toast.ts';

/**
 * The shared states and marks (#265, redesign screen « Components & states »): one set for every screen. Styles in
 * styles.css, block « Shared components ». Buttons are plain classes: `btn` (secondary), `btn primary`, `btn ghost`,
 * `btn danger` (always « … » and a confirm), `small`; `icon-btn` for an icon alone.
 */

/** A priority: three bars (as many filled as the level) and its name. `bare`: the bars alone, the name as tooltip. */
export function PriorityMark({ p, bare }: { p: number; bare?: boolean }) {
  return (
    <span className={'prio-mark p' + p} title={priorityHint(p)} aria-label={bare ? 'Priority ' + priorityName(p) : undefined}>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <rect key={i} x={2 + i * 4} y={9 - i * 3} width="2.6" height={3 + i * 3} rx=".6" className={i < p ? 'on' : undefined} />
        ))}
      </svg>
      {!bare && priorityName(p)}
    </span>
  );
}

/** A status as a chip: its icon and its name (`label` for a run state such as « Stopped by you »). */
export function StatusChip({ status, label, title }: { status: IconStatus; label?: string; title?: string }) {
  return (
    <span className={'status-chip ' + status} title={title}>
      <StatusIcon status={status} title="" />
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}

/**
 * An empty state (#403): one shape everywhere, a dashed frame with a title and at most one action, no description line
 * (Master: « fewer text is better »). `inline`: the same frame, compact, inside a tool's output or a menu.
 */
export function EmptyState(props: { title: ReactNode; action?: ReactNode; inline?: boolean; className?: string }) {
  return (
    <div className={'state-empty' + (props.inline ? ' inline' : '') + (props.className ? ' ' + props.className : '')}>
      <b>{props.title}</b>
      {props.action}
    </div>
  );
}

/** Loading: skeleton rows, never a spinner over the page. */
export function Skeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={'state-loading' + (className ? ' ' + className : '')} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className={'sk w' + (i % 3)} />
      ))}
    </div>
  );
}

/**
 * An error says what failed, what is safe and what happens next (rule « fail loudly »). It stays until it is dealt
 * with: an error is never a toast.
 */
export function ErrorState(props: { title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string; as?: 'div' | 'p' }) {
  const Tag = props.as ?? 'div';
  return (
    <Tag className={'state-err' + (props.className ? ' ' + props.className : '')} role="alert">
      {props.title && <b>{props.title}</b>}
      {props.children}
      {props.action}
    </Tag>
  );
}

const TOAST_MS = 6000;

/** A toast: something that just happened, with « Open ». It goes away by itself after 6 s; one at a time. */
export function Toast({ toast, onOpen, onDone }: { toast: ToastMsg | null; onOpen: (cardId: string) => void; onDone: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDone, TOAST_MS);
    return () => clearTimeout(t);
  }, [toast, onDone]);
  if (!toast) return null;
  return (
    <div className="toast" role="status" key={toast.key}>
      <StatusIcon status="done" title="" />
      <span className="toast-text">{toast.text}</span>
      <button
        type="button"
        className="btn ghost small"
        onClick={() => {
          onOpen(toast.cardId);
          onDone();
        }}
      >
        Open
      </button>
    </div>
  );
}
