import type { Card, CardPr } from '@atlas/shared';

/**
 * Pull requests on tasks (#189): what the board tile and the task view say about each one. Pure, so it is tested.
 * tone: ok (green), bad (red: back to the builder), warn (orange: GitHub can't be read), info (purple: QA), muted.
 */
export type PrTone = 'ok' | 'bad' | 'warn' | 'info' | 'muted';
export interface PrBit {
  text: string;
  tone: PrTone;
}

const short = (sha: string | null) => (sha ?? '').slice(0, 7);

/** The bits after « PR #N »: state, CI, QA. */
export function prBits(pr: CardPr, reviewer: string | null, checking: boolean): PrBit[] {
  if (pr.state === 'merged') return [{ text: `merged · ${short(pr.mergeSha)}`, tone: 'info' }];
  if (pr.state === 'closed') return [{ text: 'closed unmerged', tone: 'bad' }];
  const bits: PrBit[] = [];
  if (pr.ci === 'success') bits.push({ text: '✓ CI', tone: 'ok' });
  else if (pr.ci === 'failure') bits.push({ text: '✗ CI', tone: 'bad' });
  else bits.push({ text: '○ CI running', tone: 'muted' });
  if (pr.mergeable === false) bits.push({ text: '✗ conflicts', tone: 'bad' });
  if (pr.qa === 'success') bits.push({ text: '✓ QA', tone: 'ok' });
  else if (pr.qa === 'failure') bits.push({ text: '✗ QA', tone: 'bad' });
  else if (checking && reviewer) bits.push({ text: `QA: @${reviewer} checking`, tone: 'info' });
  return bits;
}

/** Which PRs a tile shows: all of them while in review or back in ready; the merged ones when done. */
export function tilePrs(c: Pick<Card, 'status' | 'prs'>): CardPr[] {
  if (!c.prs.length) return [];
  if (c.status === 'done') return c.prs.filter((p) => p.state === 'merged');
  if (c.status === 'review' || c.status === 'ready' || c.status === 'running' || c.status === 'blocked') {
    const open = c.prs.filter((p) => p.state === 'open');
    return open.length ? open : c.prs.slice(-1);
  }
  return [];
}

/** GitHub can't be read: the card's why-line turns orange. */
export const prUnreadable = (c: Pick<Card, 'status' | 'prs'>) => c.status === 'review' && c.prs.some((p) => p.error);

/** « read 40 s ago », « last read 10:41 » when reads fail. */
export function readAgo(pr: CardPr, now = Date.now()): string {
  if (!pr.checkedAt) return pr.error ? 'never read' : 'reading…';
  const at = new Date(pr.checkedAt);
  if (pr.error) return `last read ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
  const s = Math.max(0, Math.round((now - at.getTime()) / 1000));
  return s < 60 ? `read ${s} s ago` : s < 3600 ? `read ${Math.round(s / 60)} min ago` : `read ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
}
