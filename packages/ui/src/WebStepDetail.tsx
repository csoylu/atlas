import { useState, type ReactNode } from 'react';
import type { Step } from './chatTurn.ts';
import { domainLetter, domainOf, fetchedPage, searchHits, type SearchHit } from './webRows.ts';

/** Results shown before « Show all N ». */
const FIRST = 5;

/**
 * The expanded view of a web tool (#65, mockup pages/chat-activity.html §6): the search results (domain letter, title,
 * URL, Show all) or the fetched page (title, URL, an excerpt, Open), and their errors in the bad tone.
 * undefined = not a web tool (the caller decides); null = nothing to expand yet.
 */
export function webDetail(step: Step): ReactNode | null | undefined {
  if (step.kind !== 'tool' || (step.name !== 'web_search' && step.name !== 'web_fetch')) return undefined;
  if (!step.result) return null;
  if (step.result.isError) return <pre className="step-out err">{step.result.content}</pre>;
  const out = step.result.content;
  if (step.name === 'web_search') {
    const hits = searchHits(out);
    return hits.length ? <SearchResults hits={hits} /> : <p className="step-empty">No results.</p>;
  }
  const input = (step.input && typeof step.input === 'object' ? step.input : {}) as { url?: unknown };
  const page = fetchedPage(out, typeof input.url === 'string' ? input.url : '');
  return (
    <div className="web-page">
      <Hit hit={{ title: page.title ?? domainOf(page.url), url: page.url, domain: domainOf(page.url) }} />
      {page.excerpt && <p className="web-excerpt">{page.excerpt}</p>}
      <a className="chat-row-open web-open" href={page.url} target="_blank" rel="noreferrer">
        Open ↗
      </a>
    </div>
  );
}

function SearchResults({ hits }: { hits: SearchHit[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? hits : hits.slice(0, FIRST);
  return (
    <>
      <div className="web-results">
        {shown.map((h, i) => (
          <Hit key={i} hit={h} link />
        ))}
      </div>
      {hits.length > FIRST && (
        <button type="button" className="chat-row-open" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${hits.length}`}
        </button>
      )}
    </>
  );
}

/** A result: the domain's letter, the title, the URL; a link to the page in the search list. */
function Hit({ hit, link }: { hit: SearchHit; link?: boolean }) {
  const body = (
    <>
      <span className="web-fav" aria-hidden="true">
        {domainLetter(hit.domain)}
      </span>
      <span className="web-hit-t">{hit.title}</span>
      <span className="web-hit-u">{hit.url.replace(/^https?:\/\//, '')}</span>
    </>
  );
  return link ? (
    <a className="web-hit" href={hit.url} target="_blank" rel="noreferrer" title={hit.url}>
      {body}
    </a>
  ) : (
    <div className="web-hit">{body}</div>
  );
}
