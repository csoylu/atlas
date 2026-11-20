import { forwardRef, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Card, Run } from '@atlas/shared';
import { api } from './api.ts';
import { StatusIcon } from './StatusIcon.tsx';
import { PrPills } from './PrChips.tsx';
import { blockLabel } from './CardPanel.tsx';
import { stallAction } from './stallView.ts';
import { useMinute } from './useMinute.ts';
import { taskNow } from './taskNow.ts';
import { SecretBox, secretBoxOf } from './SecretBox.tsx';

/**
 * The task sheet's « Now » box (#269, redesign screen « Task »): status and time in it, the PR as one pill with its
 * worst state, one sentence saying why the task is where it is and what it waits for, the branch at its head, the
 * action that moves it on (Stop, Retry, the stall's own), the workflows acting on it (`children`, #259) and, when it
 * is blocked, the question for Master with its options as numbered buttons (the answer can also be typed in the
 * composer below).
 */
export const TaskNow = forwardRef<HTMLElement, { card: Card; run: Run | null; onStop(): void; onError(e: unknown): void; children?: ReactNode }>(function TaskNow(
  { card, run, onStop, onError, children },
  ref,
) {
  const now = useMinute();
  const v = taskNow(card, run, now);
  const [busy, setBusy] = useState(false);
  const act = card.stall && !card.block ? stallAction(card.stall) : null;
  const retry = !card.block && !card.stall && !!card.waiting?.includes('Retry');
  const running = card.status === 'running' || run?.status === 'running';
  // « No Review workflow is on in <project> » (#263): nothing reviews it; Master turns it on or validates by hand.
  const off = card.status === 'review' && card.reviewOff ? card.reviewOff : null;
  const openPr = card.prs.find((p) => p.state === 'open');
  const turnOn = () => {
    setBusy(true);
    api.turnOnReview(off!.projectId).then(
      () => setBusy(false),
      (e: unknown) => (setBusy(false), onError(e)),
    );
  };
  const byHand = () => {
    if (!openPr?.headSha) return;
    const head = openPr.headSha.slice(0, 7);
    if (!window.confirm(`Validate and merge PR #${openPr.number} at ${head}? Same gate as scripts/pr/validate.mjs --as master --merge: CI green on ${head}, no conflict, base ${openPr.base ?? 'main'}.`)) return;
    setBusy(true);
    api.validateByHand(card.id, openPr.headSha).then(
      () => setBusy(false),
      (e: unknown) => (setBusy(false), onError(e)),
    );
  };
  const b = card.block;
  const send = (text: string) => {
    setBusy(true);
    api.postMessage(card.id, text).then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false);
        onError(e);
      },
    );
  };
  return (
    <section ref={ref} className={'cm-now' + (b ? ' asks' : '')} aria-label="Now">
      <div className="now-l1">
        <StatusIcon status={v.icon} title="" />
        <b>
          {v.label}
          {v.since && (
            <span title={`Since ${new Date(card.statusSince!).toLocaleString()}`}> · {v.since}</span>
          )}
        </b>
        {b && <span className="ask-kind">{blockLabel[b.kind]}</span>}
        <span className="cm-sp" />
        <PrPills card={card} />
        {running && (
          <button type="button" className="btn small danger" onClick={onStop} title="Stop. If it was answering your last message, that turn is rewound (Esc in the composer)">
            Stop
          </button>
        )}
      </div>
      {(v.line || v.branch || v.prNote || act || retry || off) && (
        <div className={'now-l2' + (v.tone !== 'muted' ? ' ' + v.tone : '')}>
          {v.line && <span>{/[.!?:]$/.test(v.line) ? v.line : v.line + '.'} </span>}
          {v.prNote &&
            (v.prNote.url ? (
              <a href={v.prNote.url} target="_blank" rel="noreferrer">
                {v.prNote.text}
              </a>
            ) : (
              <span>{v.prNote.text}.</span>
            ))}
          {v.prNote && ' '}
          {v.branch && (
            <span>
              Branch <span className="mono">{v.branch.name}</span>
              {v.branch.sha && (
                <>
                  {' '}
                  at <span className="mono">{v.branch.sha}</span>
                </>
              )}
              .
            </span>
          )}
          {act && (
            <button type="button" className="btn small now-act" onClick={() => act.run(card.id).catch(onError)}>
              {act.label}
            </button>
          )}
          {retry && !off && (
            <button type="button" className="btn small now-act" onClick={() => api.retry(card.id).catch(onError)}>
              Retry
            </button>
          )}
          {off && (
            <span className="now-acts">
              <button type="button" className="btn small primary" disabled={busy} onClick={turnOn}>
                Turn it on
              </button>
              <button type="button" className="btn small" disabled={busy || !openPr?.headSha} title={openPr?.headSha ? undefined : 'Atlas has not read the PR head from GitHub yet'} onClick={byHand}>
                Validate by hand
              </button>
            </span>
          )}
        </div>
      )}
      {b && (
        <div className="now-ask" role="group" aria-label={blockLabel[b.kind]}>
          <div className="md now-q">
            <Markdown remarkPlugins={[remarkGfm]}>{b.reason || 'Blocked, with no reason given.'}</Markdown>
          </div>
          <SecretBox card={card} />
          {(b.options.length > 0 || b.kind !== 'needs_input') && (
            <div className="now-opts">
              {b.options.map((o, i) => (
                <button key={o} type="button" className={'btn now-opt' + (i === 0 ? ' primary' : '')} title={i === 0 ? 'Recommended' : undefined} disabled={busy} onClick={() => send(o)}>
                  <span className="now-optn">{i + 1} ·</span>
                  <span className="now-optt">{o}</span>
                </button>
              ))}
              {b.kind !== 'needs_input' && (
                <button type="button" className="btn now-opt" onClick={() => api.retry(card.id).catch(onError)}>
                  Retry now
                </button>
              )}
            </div>
          )}
          <p className="now-hint">
            {b.options.length ? 'Or reply in your own words below' : `Reply to @${card.assignee ?? 'the agent'} below`}
.
          </p>
        </div>
      )}
      {!b && secretBoxOf(card)?.kind === 'saved' && <SecretBox card={card} />}
      {children}
    </section>
  );
});
