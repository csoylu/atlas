import type { ReactNode } from 'react';
import { currentToolName, type Card, type CardStatus } from '@atlas/shared';
import { boardGroups, cardLine, cardSub, historyHits, historyMessage, markHits } from './cardRows.ts';
import type { Step } from './chatTurn.ts';
import { STATUS_LABEL, StatusIcon } from './StatusIcon.tsx';
import { cardChanges, cardRef } from './toolRows.ts';

/** The board around a turn: opens a card by reference ("#58"), finds it for its live status and title. */
export interface TurnCards {
  open(ref: string): void;
  card?(ref: string): Card | undefined;
}

export interface DetailContext {
  renderText(text: string, key: string): ReactNode;
  cards?: TurnCards;
}

const known = (ref: string, cards?: TurnCards): cards is TurnCards => !!cards && (!cards.card || !!cards.card(ref));

/** "#58" in a row or a chip: opens the ticket without toggling the row. A card that's gone stays plain text. */
export function CardRefLink({ ref_, cards }: { ref_: string; cards?: TurnCards }) {
  if (!known(ref_, cards)) return <span className="chat-row-ref">{ref_}</span>;
  return (
    <button
      type="button"
      className="chat-row-ref"
      title="Open the ticket"
      onClick={(e) => {
        e.stopPropagation();
        cards.open(ref_);
      }}
    >
      {ref_}
    </button>
  );
}

/** A card as a chip: status icon (live when the card is on the board), #N, title, a faint line, Open. */
function CardChip({ ref_, status, title, sub, cards }: { ref_: string; status: CardStatus; title: string; sub: string; cards?: TurnCards }) {
  const live = cards?.card?.(ref_);
  const st = live?.status ?? status;
  return (
    <div className="step-chip">
      <StatusIcon status={st} />
      <div className="step-chip-t">
        <span className="step-chip-title" title={live?.title ?? title}>
          <CardRefLink ref_={ref_} cards={cards} /> {live?.title ?? title}
        </span>
        <small>{sub}</small>
      </div>
      {known(ref_, cards) && <OpenButton ref_={ref_} cards={cards} />}
    </div>
  );
}

function OpenButton({ ref_, cards, label = 'Open ↗' }: { ref_: string; cards: TurnCards; label?: string }) {
  return (
    <button type="button" className="chat-row-open" onClick={() => cards.open(ref_)}>
      {label}
    </button>
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * The expanded view of a card & team tool (#62, mockup pages/chat-activity.html §3): a card chip, the quoted message,
 * board counts, history hits. null = not one of them, or nothing to show yet (the caller shows the generic view).
 */
export function cardDetail(step: Step, ctx: DetailContext): ReactNode | null {
  const o = (step.input && typeof step.input === 'object' ? step.input : {}) as Record<string, unknown>;
  const out = step.result && !step.result.isError ? step.result.content : null;
  const { cards } = ctx;
  const name = currentToolName(step.name);
  switch (name) {
    case 'task_create':
    case 'task_show':
    case 'task_update': {
      const c = out === null ? null : cardLine(out);
      if (!c) return null;
      const sub = name === 'task_update' ? cardChanges(o) || cardSub(c) : cardSub(c);
      return <CardChip ref_={c.ref} status={c.status} title={c.title} sub={sub} cards={cards} />;
    }
    case 'task_message': {
      const ref = cardRef(o.id);
      return (
        <>
          <blockquote className="step-quote">{ctx.renderText(str(o.text), 'q')}</blockquote>
          {ref && known(ref, cards) && <OpenButton ref_={ref} cards={cards} label={`Open ${ref} ↗`} />}
        </>
      );
    }
    case 'task_block': {
      const options = Array.isArray(o.options) ? o.options.filter((x): x is string => typeof x === 'string') : [];
      return (
        <>
          <blockquote className="step-quote">{ctx.renderText(str(o.question), 'q')}</blockquote>
          {options.length > 0 && (
            <ul className="step-options">
              {options.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          )}
        </>
      );
    }
    case 'task_request_review':
    case 'task_complete':
      return <div className="step-md">{ctx.renderText(str(o.summary), 's')}</div>;
    case 'task_list': {
      if (out === null) return null;
      const groups = boardGroups(out);
      if (!groups.length) return <p className="step-empty">No cards{str(o.status) ? ` in ${str(o.status)}` : ''}.</p>;
      return (
        <div className="step-board">
          {groups.map((g) => (
            <div key={g.status} className="step-board-row">
              <span className="step-board-st">
                <StatusIcon status={g.status} />
                {STATUS_LABEL[g.status]}
                <span className="step-board-n">{g.cards.length}</span>
              </span>
              <span className="step-board-cards">
                {g.cards.length <= 3
                  ? g.cards.map((c, i) => (
                      <span key={c.ref} className="step-board-card">
                        {i > 0 && ' · '}
                        <CardRefLink ref_={c.ref} cards={cards} /> {c.title}
                      </span>
                    ))
                  : `${g.cards.length} cards`}
              </span>
            </div>
          ))}
        </div>
      );
    }
    case 'history_search': {
      if (out === null) return null;
      const q = str(o.query);
      if (!q) {
        const m = historyMessage(out);
        if (!m) return null;
        return (
          <>
            <div className="step-hit-head">
              <span className="step-hit-n">#{m.seq}</span> {m.author}
            </div>
            <pre className="step-out">{m.text}</pre>
          </>
        );
      }
      const { hits, more } = historyHits(out);
      if (!hits.length) return <p className="step-empty">No message contains “{q}”.</p>;
      return (
        <div className="step-hits">
          {hits.map((h) => (
            <div key={h.seq} className="step-hit">
              <span className="step-hit-n">#{h.seq}</span>
              <span className="step-hit-t">
                <span className="step-hit-who">{h.author} · </span>
                {markHits(h.text, q).map((p, i) => (typeof p === 'string' ? p : <mark key={i}>{p.hit}</mark>))}
              </span>
            </div>
          ))}
          {more > 0 && <p className="step-empty">{more} older matches not shown.</p>}
        </div>
      );
    }
  }
  return null;
}
