import type { UpdateStatus } from '@atlas/shared';

/** App updates (#123): the words the sidebar badge, the dialog and Settings → About show. Pure, tested. */

export const latestOf = (s: UpdateStatus | null) => s?.releases[0] ?? null;

/** Busy installing (the dialog shows progress, the badge says so). */
export const busy = (s: UpdateStatus) => s.phase === 'downloading' || s.phase === 'verifying' || s.phase === 'installing';

/** The sidebar badge: null = no badge (up to date and nothing going on). */
export function badgeLabel(s: UpdateStatus | null): string | null {
  if (!s) return null;
  if (s.phase === 'downloading') return `Downloading update… ${percent(s) ?? ''}${percent(s) == null ? '' : '%'}`.trim();
  if (s.phase === 'verifying') return 'Checking the update…';
  if (s.phase === 'installing') return 'Restarting to update…';
  if (s.phase === 'failed' && s.releases.length) return 'Update failed';
  return s.releases.length ? 'Update available' : null;
}

export function percent(s: UpdateStatus): number | null {
  if (!s.total) return null;
  return Math.min(100, Math.floor((s.received / s.total) * 100));
}

/** « 5 min ago » for the last check. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Settings → About: one line on where updates stand. */
export function aboutLine(s: UpdateStatus, now = Date.now()): string {
  if (s.checking) return 'Checking for updates…';
  if (s.checkError) return `The last check failed (${ago(s.checkedAt, now)}): ${s.checkError}`;
  const latest = latestOf(s);
  if (latest) return `Atlas ${latest.version} is available (checked ${ago(s.checkedAt, now)}).`;
  if (!s.checkedAt) return 'Not checked yet.';
  return `Up to date (checked ${ago(s.checkedAt, now)}).`;
}

/** The dialog's line on who the restart interrupts. */
export function workingLine(s: UpdateStatus): string {
  const n = s.working.length;
  if (!n) return 'No agent is working now.';
  return n === 1 ? '1 agent is working now: it stops for the restart and resumes after it.' : `${n} agents are working now: they stop for the restart and resume after it.`;
}

/** The release notes heading « ## Fixed · #12 · Sentence » → kind, task, sentence; null if it isn't one. */
export function noteHeading(notes: string): { kind: string; task: string | null; title: string; body: string } | null {
  const m = /^##\s+(Fixed|Added|Changed|Breaking)\s+·\s+(?:(#\d+)\s+·\s+)?(.+)\n?([\s\S]*)$/.exec(notes.trim());
  return m ? { kind: m[1]!, task: m[2] ?? null, title: m[3]!.trim(), body: m[4]!.trim() } : null;
}
