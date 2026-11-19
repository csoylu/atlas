import type { Card } from '@atlas/shared';
import { prPill, tilePrs } from './prView.ts';

const checking = (c: Card) => c.status === 'review' && !!c.waiting?.includes('is checking');

/** The PR pills of a board card (#266) and of the task's « Now » box (#269): one link per PR shown, « PR #N · its worst state ». */
export function PrPills({ card }: { card: Card }) {
  const prs = tilePrs(card);
  if (!prs.length) return null;
  return (
    <>
      {prs.map((p) => {
        const pill = prPill(p, card.reviewer, checking(card));
        return (
          <a key={p.repo + p.number} className={'pr-pill ' + pill.tone} href={p.url} target="_blank" rel="noreferrer" title={`${p.url}\nCI, conflicts and QA in one pill: it shows the worst state`} onClick={(e) => e.stopPropagation()}>
            {pill.text}
          </a>
        );
      })}
    </>
  );
}
