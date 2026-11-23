/**
 * The Atlas mark's state (#310, Living Orb). The sidebar no longer shows it (#349); kept for Mark's live mode:
 *   need  something waits for Master (the Inbox's « Needs you »): the swirl stops and dims, an orange badge knocks twice
 *   work  at least one run is active (a running task, or a chat answering): the swirl turns, the glow beats faster
 *   idle  otherwise: the glow breathes once every 4 s
 * « Needs you » wins over « working »: it is the one that asks Master to act.
 */
export type MarkState = 'idle' | 'work' | 'need';

/** What the mark says to a screen reader and in its tooltip. */
export function markLabel(s: MarkState): string {
  return s === 'need' ? 'Atlas · needs you' : s === 'work' ? 'Atlas · working' : 'Atlas · idle';
}
