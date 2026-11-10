import { useState } from 'react';
import { tint } from './agentTint.ts';
import { CARD_STATUSES, type Card, type CardStatus } from '@atlas/shared';

const COLUMNS = CARD_STATUSES.filter((s) => s !== 'archived');
const HINT: Record<string, string> = {
  triage: 'Drop ideas here. The triage agent shapes them into cards.',
  todo: 'Waits here until its parent cards are done.',
  ready: 'Starts as soon as the assignee is free.',
  running: 'An agent is working on it.',
  blocked: 'Needs an answer or access.',
  review: 'Waiting for a reviewer.',
  done: '',
};

export function Board(props: {
  cards: Card[];
  openId: string | null;
  onOpen(id: string): void;
  onCreate(title: string): void;
  onMove(id: string, status: CardStatus): void;
}) {
  const [draft, setDraft] = useState('');
  const [over, setOver] = useState<CardStatus | null>(null);
  // Columns folded to a slim rail (kept across reloads). Done starts folded: it is history, the rest is work.
  const [folded, setFolded] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('atlas.board.folded');
    return new Set(saved ? (JSON.parse(saved) as string[]) : ['done']);
  });
  const toggle = (s: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (!next.delete(s)) next.add(s);
      localStorage.setItem('atlas.board.folded', JSON.stringify([...next]));
      return next;
    });

  return (
    <div className="board">
      {COLUMNS.map((status) => {
        const cards = props.cards.filter((c) => c.status === status);
        const isFolded = folded.has(status);
        return (
          <section
            key={status}
            className={'column ' + status + (over === status ? ' over' : '') + (isFolded ? ' folded' : '')}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(status);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData('text/card-id');
              const card = props.cards.find((c) => c.id === id);
              if (card && card.status !== status) props.onMove(id, status);
            }}
          >
            <h2>
              <button
                className="fold"
                onClick={() => toggle(status)}
                aria-expanded={!isFolded}
                title={isFolded ? `Show ${status}` : `Fold ${status}`}
              >
                <span className={'dot ' + status} />
                <span className="name">{status}</span>
                <span className="count">{cards.length}</span>
              </button>
            </h2>
            {isFolded ? null : (
              <>
            {HINT[status] && <p className="hint">{HINT[status]}</p>}
            {status === 'triage' && (
              <form
                className="new-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!draft.trim()) return;
                  props.onCreate(draft.trim());
                  setDraft('');
                }}
              >
                <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="New idea…  ⏎" />
              </form>
            )}
            <div className="cards">
              {cards.map((c) => (
                <article
                  key={c.id}
                  className={'card' + (props.openId === c.id ? ' open' : '')}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/card-id', c.id)}
                  onClick={() => props.onOpen(c.id)}
                  data-status={c.status}
                >
                  <div className="card-title">{c.title}</div>
                  {c.block && (
                    <div className={'card-block ' + c.block.kind}>
                      <span className="kind">{c.block.kind.replace('_', ' ')}</span> {c.block.reason}
                    </div>
                  )}
                  {c.waiting && <div className="card-waiting" title={c.waiting}>{c.waiting}</div>}
                  <div className="card-meta">
                    <span className="id">{c.id}</span>
                    {c.assignee && <span className="assignee" style={tint(c.assignee)}>@{c.assignee}</span>}
                    {c.priority !== 0 && <span className="prio">P{c.priority}</span>}
                    {c.parents.length > 0 && (
                      <span className="links" title={'After ' + c.parents.join(', ')}>
                        after {c.parents.length}
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </div>
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
