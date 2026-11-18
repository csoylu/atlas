import type { Card } from '@atlas/shared';
import { prBits, readAgo, tilePrs } from './prView.ts';

/** « PR #N » linking to GitHub (opens outside the app). */
function PrLink({ url, number }: { url: string; number: number }) {
  return (
    <a className="prc-link" href={url} target="_blank" rel="noreferrer" title={url} onClick={(e) => e.stopPropagation()}>
      PR #{number}
    </a>
  );
}

const checking = (c: Card) => c.status === 'review' && !!c.waiting?.includes('is checking');

/** The board tile's line: one « PR #N ✓ CI » per PR shown (#189). */
export function PrLine({ card }: { card: Card }) {
  const prs = tilePrs(card);
  if (!prs.length) return null;
  return (
    <div className="prc-line">
      {prs.map((p) => (
        <span key={p.repo + p.number} className="prc-one">
          <PrLink url={p.url} number={p.number} />
          {prBits(p, card.reviewer, checking(card)).map((b) => (
            <span key={b.text} className={'prc-bit prc-' + b.tone}>
              {b.text}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

/** The task view's PR rows under the title: link, state, CI, QA, branch, head, when it was read. */
export function PrRows({ card }: { card: Card }) {
  if (!card.prs.length) return null;
  const bad = card.status === 'review' ? card.prs.find((p) => p.error) : undefined;
  return (
    <div className="prc-rows">
      {bad && <div className="prc-banner">{card.waiting ?? `Can't read PR #${bad.number} from GitHub: ${bad.error}`}. The task waits; nothing moves on old data.</div>}
      {card.prs.map((p) => (
        <div key={p.repo + p.number} className="prc-row">
          <PrLink url={p.url} number={p.number} />
          <div className="prc-main">
            <div className="prc-bits">
              <span className={'prc-state prc-st-' + p.state}>{p.state}</span>
              {p.state === 'open' &&
                prBits(p, card.reviewer, checking(card)).map((b) => (
                  <span key={b.text} className={'prc-bit prc-' + b.tone}>
                    {b.text}
                  </span>
                ))}
              {p.state === 'open' && p.qa === 'failure' && p.qaDescription && <span className="prc-bit prc-bad">{p.qaDescription}</span>}
            </div>
            <div className="prc-meta">
              {[p.state === 'merged' ? `into ${p.base ?? '?'} · ${(p.mergeSha ?? '').slice(0, 7)}` : null, p.branch, p.state === 'open' ? (p.headSha ?? '').slice(0, 7) : null, p.repo]
                .filter(Boolean)
                .join('  ')}
            </div>
          </div>
          <span className="prc-when">{readAgo(p)}</span>
        </div>
      ))}
    </div>
  );
}
