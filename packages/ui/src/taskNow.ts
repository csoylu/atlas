import { stallText, type Card, type Run } from '@atlas/shared';
import { STATUS_LABEL, type IconStatus } from './StatusIcon.tsx';
import { pillStatus } from './cardModal.ts';
import { timeInState } from './boardView.ts';
import { prUnreadable } from './prView.ts';

/**
 * The task sheet's « Now » box (#269, redesign screen « Task »): what is happening on the task, in one place. Its
 * status and time in it, then one sentence saying why it is there and what it waits for (the engine's « why isn't it
 * moving », a stall, the run), the open PR's branch and head, and a red check or QA's reason. The question of a
 * blocked task and the workflows acting on it are drawn by TaskNow under this. Pure, so it is tested.
 */
export interface NowView {
  icon: IconStatus;
  /** « In review », « Stopped by you ». */
  label: string;
  /** « 3 min »: time in this status, null when not shown (done, closed…). */
  since: string | null;
  /** Why it is where it is, or null when there is nothing to add to the status (and when the question says it). */
  line: string | null;
  tone: 'muted' | 'stuck' | 'warn';
  /** The open pull request's branch and short head (« Branch feat/x at 0433c17 »). */
  branch: { name: string; sha: string | null } | null;
  /** The red check (linked) or the reason QA gave. */
  prNote: { text: string; url: string | null } | null;
}

export function taskNow(
  card: Pick<Card, 'status' | 'block' | 'waiting' | 'stall' | 'statusSince' | 'prs' | 'assignee'>,
  run: Pick<Run, 'status' | 'agentId'> | null,
  now = Date.now(),
): NowView {
  const pill = pillStatus(card, run);
  const stopped = pill === 'stopped';
  const view: NowView = {
    icon: stopped ? 'failed' : card.status,
    label: stopped ? 'Stopped by you' : STATUS_LABEL[card.status],
    since: timeInState(card, now),
    line: null,
    tone: 'muted',
    branch: null,
    prNote: null,
  };
  if (card.stall && !card.block) {
    view.line = stallText(card.stall, card.statusSince, now);
    view.tone = 'stuck';
  } else if (!card.block) {
    if (card.waiting) {
      view.line = card.waiting;
      if (prUnreadable(card)) view.tone = 'warn';
    } else if (run?.status === 'running') view.line = `@${run.agentId || card.assignee} is working.`;
  }
  const open = card.prs.find((p) => p.state === 'open');
  if (open && (card.status === 'review' || card.status === 'ready' || card.status === 'running' || card.status === 'blocked')) {
    if (open.branch) view.branch = { name: open.branch, sha: open.headSha ? open.headSha.slice(0, 7) : null };
    if (open.ci === 'failure' && open.ciFailed) view.prNote = { text: `Red check: ${open.ciFailed.name}`, url: open.ciFailed.url };
    else if (open.qa === 'failure' && open.qaDescription) view.prNote = { text: `QA: ${open.qaDescription}`, url: null };
  }
  return view;
}
