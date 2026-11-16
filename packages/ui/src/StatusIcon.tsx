import type { ReactNode } from 'react';
import type { CardStatus } from '@atlas/shared';

/** What a status icon can show: every card status, plus a failed/stopped run. */
export type IconStatus = CardStatus | 'failed';

export const STATUS_LABEL: Record<IconStatus, string> = {
  triage: 'Triage',
  todo: 'Todo',
  ready: 'Ready',
  running: 'Running',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  closed: 'Closed',
  archived: 'Archived',
  failed: 'Failed',
};

/**
 * Linear-style status circles, one per card status (design §16): triage dashed, todo/ready empty (todo grey, ready
 * bright), running half-filled yellow, blocked orange with « ! », review half-filled green, done teal with a check,
 * failed red with a cross, closed/archived grey with a cross. Colours come from the --st-* tokens (both themes).
 */
export function StatusIcon({ status, size = 14, title }: { status: IconStatus; size?: number; title?: string }) {
  return (
    <svg className={'status-icon ' + status} width={size} height={size} viewBox="0 0 14 14" role="img" aria-label={title ?? STATUS_LABEL[status]}>
      {title !== undefined && <title>{title}</title>}
      {SHAPES[status]}
    </svg>
  );
}

const ring = (color: string, extra?: { dash?: string }) => (
  <circle cx="7" cy="7" r="5.6" fill="none" stroke={color} strokeWidth="1.5" strokeDasharray={extra?.dash} />
);
const cross = (color: string) => <path d="M4.8 4.8l4.4 4.4M9.2 4.8 4.8 9.2" stroke={color} strokeWidth="1.5" strokeLinecap="round" />;

const SHAPES: Record<IconStatus, ReactNode> = {
  triage: ring('var(--st-triage)', { dash: '1.6 1.9' }),
  todo: ring('var(--st-todo)'),
  ready: ring('var(--st-ready)'),
  running: (
    <>
      {ring('var(--st-running)')}
      <path d="M7 3.5A3.5 3.5 0 0 1 7 10.5z" fill="var(--st-running)" />
    </>
  ),
  blocked: (
    <>
      <circle cx="7" cy="7" r="6.3" fill="var(--st-blocked)" />
      <path d="M7 4v3.6" stroke="var(--panel)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="7" cy="9.9" r=".9" fill="var(--panel)" />
    </>
  ),
  review: (
    <>
      {ring('var(--st-review)')}
      <path d="M7 3.5A3.5 3.5 0 1 1 3.5 7H7z" fill="var(--st-review)" />
    </>
  ),
  done: (
    <>
      <circle cx="7" cy="7" r="6.3" fill="var(--st-done)" />
      <path d="m4.4 7.1 1.8 1.8 3.4-3.6" fill="none" stroke="var(--on-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  failed: (
    <>
      <circle cx="7" cy="7" r="6.3" fill="var(--st-failed)" />
      {cross('#fff')}
    </>
  ),
  closed: (
    <>
      <circle cx="7" cy="7" r="6.3" fill="var(--faint)" />
      {cross('var(--panel)')}
    </>
  ),
  archived: (
    <>
      <circle cx="7" cy="7" r="6.3" fill="var(--faint)" />
      {cross('var(--panel)')}
    </>
  ),
};
