import { useEffect, useRef, useState, type DragEvent } from 'react';
import { AgentFace } from './AgentFace.tsx';
import { pastedImages, TASK, TaskImages, useAttachments, useFileDrop } from './Images.tsx';
import { cardRef, type Agent, type Card, type CardStatus, type CreateCard } from '@atlas/shared';
import { HeaderActions, Icon } from './ScreenHeader.tsx';
import { StatusIcon, STATUS_LABEL } from './StatusIcon.tsx';
import { Menu, PopRow } from './HeadMenu.tsx';
import {
  columnsFor,
  CREATE_IN,
  filterCount,
  matches,
  parseView,
  showAfterLabel,
  whyLine,
  type BoardFilter,
  type BoardLayout,
  type BoardTab,
} from './boardView.ts';
import { PrLine } from './PrChips.tsx';
import { prUnreadable } from './prView.ts';

const HINT: Partial<Record<CardStatus, string>> = {
  triage: 'Ideas land here. The triage agent shapes them into tasks.',
  todo: 'Waits here until its parent tasks are done.',
  ready: 'Starts as soon as the assignee is free.',
  running: 'An agent is working on it.',
  blocked: 'Needs an answer or access.',
  review: 'Its pull request is with QA. Merged → Done by itself.',
};
const TABS: { id: BoardTab; label: string; long?: string }[] = [
  { id: 'all', label: 'All', long: ' tasks' },
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running' },
];
const PRIORITY_LABEL = ['No priority', 'P1', 'P2', 'P3'];

/**
 * The Board in the Linear direction (design §16): header tabs All cards / Needs you / Running, Filter (agent,
 * priority), Display (board or list), New card (C). Columns: status icon, name, count, « + »; dense cards: number,
 * agent, status icon, title, labels, the « why » line. Drag a card onto another column to move it.
 */
export function Board(props: {
  cards: Card[];
  agents: Agent[];
  openId: string | null;
  onOpen(id: string): void;
  onCreate(card: CreateCard): Promise<unknown>;
  onMove(id: string, status: CardStatus): void;
  onError(e: unknown): void;
  /** C (App, any screen) or the palette asked for « New card »: > 0 opens the composer, then onCreateAsked resets it. */
  createAsk?: number;
  onCreateAsked?(): void;
}) {
  const [view, setView] = useState(() => parseView(localStorage.getItem('atlas.board.view')));
  const save = (next: typeof view) => {
    setView(next);
    localStorage.setItem('atlas.board.view', JSON.stringify(next));
  };
  const [over, setOver] = useState<CardStatus | null>(null);
  const [creating, setCreating] = useState<CardStatus | null>(null);
  const [menu, setMenu] = useState<'filter' | 'display' | null>(null);
  // Columns folded to a slim rail (kept across reloads). Done and Closed start folded: history, the rest is work.
  const [folded, setFolded] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('atlas.board.folded');
    return new Set(saved ? (JSON.parse(saved) as string[]) : ['done', 'closed']);
  });
  const toggle = (s: string) =>
    setFolded((f) => {
      const next = new Set(f);
      if (!next.delete(s)) next.add(s);
      localStorage.setItem('atlas.board.folded', JSON.stringify([...next]));
      return next;
    });

  // C / the palette's « New card » (App handles the key on every screen).
  const { createAsk, onCreateAsked } = props;
  useEffect(() => {
    if (!createAsk) return;
    setCreating((c) => c ?? 'triage');
    onCreateAsked?.();
  }, [createAsk, onCreateAsked]);

  const shown = props.cards.filter((c) => matches(c, view.tab, view.filter));
  const columns = columnsFor(view.tab);
  const nFilters = filterCount(view.filter);
  const counts: Record<BoardTab, number> = {
    all: 0,
    needs: props.cards.filter((c) => matches(c, 'needs', view.filter)).length,
    running: props.cards.filter((c) => matches(c, 'running', view.filter)).length,
  };

  const drop = (status: CardStatus) => ({
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setOver(status);
    },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(null);
      const id = e.dataTransfer.getData('text/card-id');
      const card = props.cards.find((c) => c.id === id);
      if (card && card.status !== status) props.onMove(id, status);
    },
  });

  return (
    <div className={'board-screen ' + view.layout}>
      <HeaderActions>
        <div className="view-tabs" role="tablist" aria-label="Tasks">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={view.tab === t.id}
              className={'tabbtn' + (view.tab === t.id ? ' on' : '')}
              onClick={() => save({ ...view, tab: t.id })}
            >
              {t.label}
              {t.long && <span className="tab-long">{t.long}</span>}
              {t.id !== 'all' && counts[t.id] > 0 && <span className="tab-n">{counts[t.id]}</span>}
            </button>
          ))}
        </div>
        <span className="head-sp" />
        <Menu
          open={menu === 'filter'}
          onOpen={(o) => setMenu(o ? 'filter' : null)}
          label={
            <>
              <Icon.filter />
              <span className="btn-text">Filter</span>
              {nFilters > 0 && <span className="tab-n">{nFilters}</span>}
            </>
          }
          title="Filter by agent or priority"
        >
          <div className="pop-k">Agent</div>
          <PopRow on={view.filter.agent === null} onClick={() => save({ ...view, filter: { ...view.filter, agent: null } })}>Any agent</PopRow>
          {props.agents.map((a) => (
            <PopRow key={a.id} on={view.filter.agent === a.id} onClick={() => save({ ...view, filter: { ...view.filter, agent: a.id } })}>
              <Avatar id={a.id} />@{a.id}
            </PopRow>
          ))}
          <PopRow on={view.filter.agent === ''} onClick={() => save({ ...view, filter: { ...view.filter, agent: '' } })}>Unassigned</PopRow>
          <div className="pop-k">Priority</div>
          <PopRow on={view.filter.priority === null} onClick={() => save({ ...view, filter: { ...view.filter, priority: null } })}>Any priority</PopRow>
          {[3, 2, 1, 0].map((p) => (
            <PopRow key={p} on={view.filter.priority === p} onClick={() => save({ ...view, filter: { ...view.filter, priority: p } })}>
              {PRIORITY_LABEL[p]}
            </PopRow>
          ))}
          {nFilters > 0 && (
            <button type="button" className="pop-clear" onClick={() => save({ ...view, filter: { agent: null, priority: null } })}>
              Clear filters
            </button>
          )}
        </Menu>
        <Menu
          open={menu === 'display'}
          onOpen={(o) => setMenu(o ? 'display' : null)}
          label={
            <>
              {view.layout === 'board' ? <Icon.board /> : <Icon.list />}
              <span className="btn-text">Display</span>
            </>
          }
          title="Board or list"
        >
          <div className="pop-k">Layout</div>
          {(['board', 'list'] as BoardLayout[]).map((l) => (
            <PopRow key={l} on={view.layout === l} onClick={() => (save({ ...view, layout: l }), setMenu(null))}>
              {l === 'board' ? <Icon.board /> : <Icon.list />}
              {l === 'board' ? 'Board' : 'List'}
            </PopRow>
          ))}
          <div className="pop-k">Options</div>
          <button type="button" role="menuitemcheckbox" aria-checked={view.showEmpty} className={'pop-row' + (view.showEmpty ? ' on' : '')} onClick={() => save({ ...view, showEmpty: !view.showEmpty })}>
            Show empty columns
            <span className={'pop-switch' + (view.showEmpty ? ' on' : '')} aria-hidden="true" />
          </button>
        </Menu>
        <button type="button" className="head-btn pri" onClick={() => setCreating('triage')} title="New task (C)" aria-label="New task">
          <Icon.plus />
          <span className="btn-text">New task</span>
          <span className="kbd">C</span>
        </button>
      </HeaderActions>

      {view.layout === 'board' ? (
        <div className="board">
          {columns.map((status) => {
            const cards = shown.filter((c) => c.status === status);
            // An empty column is a slim rail (still a drop target) unless Display → « Show empty columns ».
            const empty = cards.length === 0 && !view.showEmpty;
            const isFolded = empty || folded.has(status);
            return (
              <section key={status} className={'column ' + status + (over === status ? ' over' : '') + (isFolded ? ' folded' : '') + (empty ? ' col-empty' : '')} {...drop(status)}>
                <h2 className="col-head">
                  <button
                    className="fold"
                    onClick={() => (empty ? save({ ...view, showEmpty: true }) : toggle(status))}
                    aria-expanded={!isFolded}
                    title={empty ? `No ${STATUS_LABEL[status]} tasks: click to show empty columns` : isFolded ? `Show ${STATUS_LABEL[status]}` : `Fold ${STATUS_LABEL[status]}`}
                  >
                    <StatusIcon status={status} />
                    <span className="name">{STATUS_LABEL[status]}</span>
                    <span className="count">{cards.length}</span>
                  </button>
                  {!isFolded && CREATE_IN.includes(status) && (
                    <button type="button" className="icon-btn col-add" onClick={() => setCreating(status)} aria-label={`New task in ${STATUS_LABEL[status]}`} title={`New task in ${STATUS_LABEL[status]}`}>
                      <Icon.plus />
                    </button>
                  )}
                </h2>
                {!isFolded && (
                  <div className="cards">
                    {cards.length === 0 && HINT[status] && <p className="hint">{HINT[status]}</p>}
                    {cards.map((c) => (
                      <BoardCard key={c.id} card={c} cards={props.cards} open={props.openId === c.id} onOpen={props.onOpen} />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="board-list">
          {columns.map((status) => {
            const cards = shown.filter((c) => c.status === status);
            if (cards.length === 0 && !view.showEmpty) return null;
            return (
              <section key={status} className={'list-group' + (over === status ? ' over' : '')} {...drop(status)}>
                <h2 className="lg">
                  <StatusIcon status={status} />
                  <span className="name">{STATUS_LABEL[status]}</span>
                  <span className="count">{cards.length}</span>
                  {CREATE_IN.includes(status) && (
                    <button type="button" className="icon-btn col-add" onClick={() => setCreating(status)} aria-label={`New task in ${STATUS_LABEL[status]}`} title={`New task in ${STATUS_LABEL[status]}`}>
                      <Icon.plus />
                    </button>
                  )}
                </h2>
                {cards.map((c) => {
                  const why = whyLine(c);
                  return (
                    <div
                      key={c.id}
                      role="button"
                      tabIndex={0}
                      data-row
                      className={'list-row' + (props.openId === c.id ? ' open' : '')}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/card-id', c.id)}
                      onClick={() => props.onOpen(c.id)}
                      onKeyDown={(e) => e.key === 'Enter' && props.onOpen(c.id)}
                    >
                      <span className="id">{cardRef(c)}</span>
                      <StatusIcon status={c.status} />
                      <span className="card-title">{c.title}</span>
                      <PrLine card={c} />
                      {why && <span className={'why' + (why.blocked ? ' blocked' : '')}>{why.text}</span>}
                      <Labels card={c} cards={props.cards} />
                      {c.assignee ? <Avatar id={c.assignee} /> : <span className="avatar-none" />}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      )}
      {creating && (
        <NewCard
          status={creating}
          agents={props.agents}
          filterAgent={view.filter.agent}
          onClose={() => setCreating(null)}
          onCreate={(c) =>
            props.onCreate(c).then(
              () => (setCreating(null), true),
              (e: unknown) => (props.onError(e), false),
            )
          }
        />
      )}
    </div>
  );
}

function BoardCard({ card: c, cards, open, onOpen }: { card: Card; cards: Card[]; open: boolean; onOpen(id: string): void }) {
  const why = whyLine(c);
  return (
    <article
      className={'card' + (open ? ' open' : '')}
      draggable
      tabIndex={0}
      data-row
      onDragStart={(e) => e.dataTransfer.setData('text/card-id', c.id)}
      onClick={() => onOpen(c.id)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(c.id)}
      data-status={c.status}
    >
      <div className="card-top">
        <span className="id" title={c.id}>{cardRef(c)}</span>
        {c.assignee ? <Avatar id={c.assignee} /> : <span className="unassigned">unassigned</span>}
        {c.status === 'review' && c.reviewer && (
          <span className="rv-face" title={'reviewer @' + c.reviewer}>
            <AgentFace id={c.reviewer} title={'reviewer @' + c.reviewer} />
          </span>
        )}
      </div>
      <div className="card-tt">
        <StatusIcon status={c.status} />
        <span className="card-title">{c.title}</span>
      </div>
      <PrLine card={c} />
      {why && (
        <div className={'why' + (why.blocked ? ' blocked' : '') + (prUnreadable(c) ? ' prc-unreadable' : '')} title={c.block?.reason ?? c.waiting ?? undefined}>
          {why.blocked && <StatusIcon status="blocked" size={12} />}
          <span>{why.text}</span>
        </div>
      )}
      <Labels card={c} cards={cards} />
    </article>
  );
}

/** The card's labels: priority and « after N » (Atlas cards have no free labels yet). */
function Labels({ card: c, cards }: { card: Card; cards: Card[] }) {
  const after = c.parents.map((p) => {
    const x = cards.find((y) => y.id === p);
    return x ? cardRef(x) : p;
  });
  const showAfter = showAfterLabel(c, after);
  if (c.priority === 0 && !showAfter) return null;
  return (
    <div className="labels">
      {c.priority !== 0 && (
        <span className={'lab prio p' + c.priority}>
          <i />P{c.priority}
        </span>
      )}
      {showAfter && (
        <span className="lab" title={'After ' + after.join(', ')}>
          after {after.length === 1 ? after[0] : after.length}
        </span>
      )}
    </div>
  );
}

export function Avatar({ id }: { id: string }) {
  return (
    <AgentFace id={id} title={'@' + id} />
  );
}

/** « New card »: title, description, agent, status, priority. ⌘↵ creates, Esc cancels. */
function NewCard(props: { status: CardStatus; agents: Agent[]; filterAgent: string | null; onClose(): void; onCreate(c: CreateCard): Promise<boolean> }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState<string>(props.filterAgent ?? '');
  const [status, setStatus] = useState<CardStatus>(props.status);
  const [priority, setPriority] = useState(0);
  const [busy, setBusy] = useState(false);
  // Images (#119): staged with no task yet; Create attaches them, Cancel / Esc / × deletes the staged files.
  const att = useAttachments(null, TASK);
  const drop = useFileDrop(att.add);
  const created = useRef(false);
  const discard = useRef(att.discardAll);
  discard.current = att.discardAll;
  useEffect(() => () => void (created.current || discard.current()), []);
  const { onClose } = props;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  const submit = () => {
    if (!title.trim() || busy) return;
    if (att.items.some((a) => a.error)) return void att.setNotice('Remove the images that failed (marked !) first');
    setBusy(true);
    void att
      .take()
      .then((uploads) => {
        created.current = true; // set before the dialog closes: its images belong to the task now
        return props.onCreate({ title: title.trim(), body, assignee: assignee || null, status, priority, uploads });
      })
      .then((ok) => {
        if (ok === false) created.current = false; // not created: the dialog stays, Cancel still deletes them
      })
      .finally(() => setBusy(false));
  };
  return (
    <div className="card-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className={'new-card-modal drop-zone' + (drop.dragging ? ' dropping' : '')}
        {...drop.props}
        role="dialog"
        aria-modal="true"
        aria-label="New task"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && (e.preventDefault(), submit())}
      >
        <div className="nc-head">
          <span className="nc-crumb">New task</span>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.x />
          </button>
        </div>
        <input className="nc-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Task title" aria-label="Title" maxLength={200} />
        <textarea
          className="nc-desc"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPaste={(e) => {
            const files = pastedImages(e.clipboardData);
            if (!files.length) return;
            e.preventDefault(); // an image, not its file name as text
            att.add(files);
          }}
          placeholder="Description, acceptance criteria… (paste or drop images)"
          aria-label="Description"
        />
        <div className="nc-images">
          <TaskImages cardId={null} images={[]} att={att} onAdd={att.add} />
        </div>
        <div className="nc-props">
          <label className="prop-pill" title="Status">
            <StatusIcon status={status} />
            <select value={status} onChange={(e) => setStatus(e.target.value as CardStatus)} aria-label="Status">
              {CREATE_IN.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>
          </label>
          <label className="prop-pill" title="Agent">
            {assignee ? <Avatar id={assignee} /> : <span className="avatar-none" />}
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Agent">
              <option value="">Unassigned</option>
              {props.agents.map((a) => (
                <option key={a.id} value={a.id}>@{a.id}</option>
              ))}
            </select>
          </label>
          <label className="prop-pill" title="Priority">
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} aria-label="Priority">
              {[0, 1, 2, 3].map((p) => (
                <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="nc-foot">
          <span className="nc-note">{status === 'triage' ? 'The triage agent shapes it.' : assignee ? `@${assignee} picks it up when it is ready.` : 'Assign an agent so it runs.'}</span>
          <button type="submit" className="primary small" disabled={!title.trim() || busy}>
            Create task <span className="kbd">⌘↵</span>
          </button>
        </div>
      </form>
    </div>
  );
}
