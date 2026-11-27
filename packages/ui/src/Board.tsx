import { useEffect, useRef, useState, type DragEvent } from 'react';
import { AgentFace } from './AgentFace.tsx';
import { FAILED, pastedFiles, TASK, TaskImages, useAttachments, useFileDrop, WAITING } from './Images.tsx';
import { cardRef, type Agent, type Card, type CardStatus, type CreateCard } from '@atlas/shared';
import { HeaderActions, Icon } from './ScreenHeader.tsx';
import { api } from './api.ts';
import { effectiveFilter, inFilter, ProjDot, ProjectFilterButton, ProjTag, projectForNew, useProjectFilter, useProjects } from './projects.tsx';
import { StatusIcon, STATUS_LABEL } from './StatusIcon.tsx';
import { PriorityMark } from './Kit.tsx';
import { PRIORITIES, priorityName } from './priority.ts';
import { Menu, PopRow } from './HeadMenu.tsx';
import { cardNote, columnsFor, CREATE_IN, filterCount, matches, parseView, phoneColumn, stripColumns, timeInState, type BoardTab } from './boardView.ts';
import { PrPills } from './PrChips.tsx';
import { prUnreadable, tilePrs } from './prView.ts';
import { useMinute } from './useMinute.ts';
import { useMedia } from './Inbox.tsx';

const HINT: Partial<Record<CardStatus, string>> = {
  triage: 'Ideas land here. The triage agent shapes them into tasks.',
  todo: 'Waits here until its parent tasks are done.',
  ready: 'Starts as soon as the assignee is free.',
  running: 'An agent is working on it.',
  blocked: 'Needs an answer or access.',
  review: 'Its pull request is with QA. Merged → Done by itself.',
};
const TABS: { id: BoardTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running' },
];
/** The phone strip's short names (« Review », not « In review »). */
const STRIP_LABEL: Partial<Record<CardStatus, string>> = { review: 'Review' };

/**
 * Tasks (redesign screen « Tasks », #266). One header row: the project filter, All / Needs you / Running, Filter (agent,
 * priority), the board/list toggle, New task (C). Columns of 228 px; an empty column, or a folded one (Done and Closed
 * start folded), is a 40 px rail. Cards: title, then avatar, number, project, priority and time in the column, then one
 * note (« waits for #N », « Needs your answer », why it is stuck) and the PR pill. Phone: one status at a time, picked
 * from the status strip. Drag a card onto another column to move it.
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
  const [saved, setView] = useState(() => parseView(localStorage.getItem('atlas.board.view')));
  const save = (next: typeof saved) => {
    setView(next);
    localStorage.setItem('atlas.board.view', JSON.stringify(next));
  };
  // Phone (#229, #266): the board only, every status, one column at a time picked from the strip.
  const phone = useMedia('(max-width: 640px)');
  const view = phone ? { ...saved, tab: 'all' as const, layout: 'board' as const } : saved;
  const [over, setOver] = useState<CardStatus | null>(null);
  const now = useMinute();
  const [creating, setCreating] = useState<CardStatus | null>(null);
  const [menu, setMenu] = useState(false);
  // Columns folded to a rail (kept across reloads). Done and Closed start folded: history, the rest is work.
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

  const pinfo = useProjects();
  const [pfRaw, setPf] = useProjectFilter();
  const pf = effectiveFilter(pfRaw, pinfo);
  // « Archived »: the cards of archived projects, read-only, fetched on demand (the app's list has active projects only).
  const [archivedCards, setArchivedCards] = useState<Card[]>([]);
  const hasArchived = pinfo.all.some((p) => p.status === 'archived');
  const { onError } = props;
  useEffect(() => {
    if (hasArchived) api.cards(true).then((cs) => setArchivedCards(cs.filter((c) => pinfo.byId(c.projectId)?.status === 'archived')), onError);
  }, [hasArchived, pinfo, onError]);
  const pool = pf === 'archived' ? archivedCards : props.cards;
  const inProject = pool.filter((c) => inFilter(pf, c.projectId, pinfo));
  // Two projects or more: every card carries its project tag (ProjTag draws nothing with one project).
  const shown = inProject.filter((c) => matches(c, view.tab, view.filter));
  const columns = columnsFor(view.tab);
  const nFilters = filterCount(view.filter);
  const counts: Record<BoardTab, number> = {
    all: inProject.filter((c) => matches(c, 'all', view.filter)).length,
    needs: inProject.filter((c) => matches(c, 'needs', view.filter)).length,
    running: inProject.filter((c) => matches(c, 'running', view.filter)).length,
  };

  const [savedCol, setSavedCol] = useState(() => localStorage.getItem('atlas.board.col'));
  const countIn = (s: CardStatus) => shown.filter((c) => c.status === s).length;
  const strip = stripColumns(columns, countIn);
  const phoneCol = phoneColumn(strip, savedCol, countIn);
  const pickCol = (s: CardStatus) => {
    setSavedCol(s);
    localStorage.setItem('atlas.board.col', s);
  };

  // Keep the chosen chip in sight when it changes (a reload on Done, a tab switch).
  const chipsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chipsRef.current?.querySelector('.board-chip.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [phoneCol, phone]);

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
  const addBtn = (status: CardStatus) =>
    CREATE_IN.includes(status) && (
      <button type="button" className="icon-btn col-add" onClick={() => setCreating(status)} aria-label={`New task in ${STATUS_LABEL[status]}`} title={`New task in ${STATUS_LABEL[status]}`}>
        <Icon.plus />
      </button>
    );

  return (
    <div className={'board-screen ' + view.layout}>
      <HeaderActions>
        <ProjectFilterButton value={pf} onChange={setPf} count={(f) => (f === 'archived' ? archivedCards.length : props.cards.filter((c) => inFilter(f, c.projectId, pinfo)).length)} />
        {!phone && (
          <div className="view-tabs board-tabs" role="tablist" aria-label="Tasks">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={view.tab === t.id}
                className={'tabbtn' + (view.tab === t.id ? ' on' : '') + (t.id === 'needs' && counts.needs > 0 ? ' hot' : '')}
                onClick={() => save({ ...saved, tab: t.id })}
              >
                {t.label}
                {counts[t.id] > 0 && <span className="tab-n">{counts[t.id]}</span>}
              </button>
            ))}
          </div>
        )}
        <span className="head-sp" />
        <Menu
          open={menu}
          onOpen={setMenu}
          btnClass="ghost icon-only"
          label={
            <>
              <Icon.filter />
              {nFilters > 0 && <span className="tab-n">{nFilters}</span>}
            </>
          }
          title="Filter by agent or priority"
        >
          <div className="pop-k">Agent</div>
          <PopRow on={view.filter.agent === null} onClick={() => save({ ...saved, filter: { ...view.filter, agent: null } })}>Any agent</PopRow>
          {props.agents.map((a) => (
            <PopRow key={a.id} on={view.filter.agent === a.id} onClick={() => save({ ...saved, filter: { ...view.filter, agent: a.id } })}>
              <Avatar id={a.id} />@{a.id}
            </PopRow>
          ))}
          <PopRow on={view.filter.agent === ''} onClick={() => save({ ...saved, filter: { ...view.filter, agent: '' } })}>Unassigned</PopRow>
          <div className="pop-k">Priority</div>
          <PopRow on={view.filter.priority === null} onClick={() => save({ ...saved, filter: { ...view.filter, priority: null } })}>Any priority</PopRow>
          {PRIORITIES.map((p) => (
            <PopRow key={p} on={view.filter.priority === p} onClick={() => save({ ...saved, filter: { ...view.filter, priority: p } })}>
              <PriorityMark p={p} />
            </PopRow>
          ))}
          {nFilters > 0 && (
            <button type="button" className="pop-clear" onClick={() => save({ ...saved, filter: { agent: null, priority: null } })}>
              Clear filters
            </button>
          )}
        </Menu>
        {!phone && (
          <button
            type="button"
            className="btn ghost icon-only"
            aria-pressed={view.layout === 'list'}
            aria-label={view.layout === 'board' ? 'List view' : 'Board view'}
            title={view.layout === 'board' ? 'Show as a list' : 'Show as a board'}
            onClick={() => save({ ...saved, layout: view.layout === 'board' ? 'list' : 'board' })}
          >
            {view.layout === 'board' ? <Icon.list /> : <Icon.board />}
          </button>
        )}
        <button type="button" className="btn primary" onClick={() => setCreating('triage')} title="New task (C)" aria-label="New task">
          <Icon.plus />
          <span className="btn-text">New task</span>
          <span className="kbd">C</span>
        </button>
      </HeaderActions>

      {phone && (
        <div className="board-chips" role="tablist" aria-label="Status" ref={chipsRef}>
          {strip.map((status) => (
            <button
              key={status}
              type="button"
              role="tab"
              aria-selected={phoneCol === status}
              className={'board-chip' + (phoneCol === status ? ' on' : '')}
              onClick={() => pickCol(status)}
            >
              <StatusIcon status={status} />
              {STRIP_LABEL[status] ?? STATUS_LABEL[status]}
              {countIn(status) > 0 && <span className="tab-n">{countIn(status)}</span>}
            </button>
          ))}
        </div>
      )}
      {view.layout === 'board' ? (
        <div className={'board' + (phone ? ' one' : '')}>
          {(phone ? [phoneCol] : columns).map((status) => {
            const cards = shown.filter((c) => c.status === status);
            // An empty column is a rail (still a drop target); a full one folds to a rail from its header. On a phone
            // the one column shown is always open.
            const empty = cards.length === 0 && !phone;
            const isFolded = empty || (!phone && folded.has(status));
            return (
              <section key={status} className={'column ' + status + (over === status ? ' over' : '') + (isFolded ? ' folded' : '') + (empty ? ' col-empty' : '')} {...drop(status)}>
                <h2 className="col-head">
                  <button
                    className="fold"
                    onClick={() => (phone || empty ? undefined : toggle(status))}
                    aria-expanded={!isFolded}
                    aria-disabled={empty || undefined}
                    title={empty ? `No ${STATUS_LABEL[status]} tasks` : phone ? undefined : isFolded ? `Show ${STATUS_LABEL[status]}` : `Fold ${STATUS_LABEL[status]}`}
                  >
                    <StatusIcon status={status} />
                    <span className="name">{STATUS_LABEL[status]}</span>
                    <span className="count">{cards.length}</span>
                  </button>
                  {!isFolded && addBtn(status)}
                </h2>
                {!isFolded && (
                  <div className="cards">
                    {cards.length === 0 && HINT[status] && <p className="hint">{HINT[status]}</p>}
                    {cards.map((c) => (
                      <BoardCard key={c.id} card={c} open={props.openId === c.id} onOpen={props.onOpen} now={now} />
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
            if (cards.length === 0) return null;
            return (
              <section key={status} className={'list-group ' + status + (over === status ? ' over' : '')} {...drop(status)}>
                <h2 className="lg">
                  <StatusIcon status={status} />
                  <span className="name">{STATUS_LABEL[status]}</span>
                  <span className="count">{cards.length}</span>
                  {addBtn(status)}
                </h2>
                {cards.map((c) => (
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
                    <StatusIcon status={c.status} />
                    <span className="card-title">{c.title}</span>
                    <Note card={c} now={now} />
                    <PrPills card={c} />
                    <Marks card={c} now={now} />
                  </div>
                ))}
              </section>
            );
          })}
          {shown.length === 0 && <p className="hint board-list-empty">No tasks here.</p>}
        </div>
      )}
      {creating && (
        <NewCard
          status={creating}
          agents={props.agents}
          filterAgent={view.filter.agent}
          project={projectForNew(pf, pinfo)?.id ?? null}
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

function BoardCard({ card: c, open, onOpen, now }: { card: Card; open: boolean; onOpen(id: string): void; now: number }) {
  const since = timeInState(c, now);
  const running = c.status === 'running';
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
      {/* Working (#371): an accent edge with a glint running down it, and the live time in the accent. */}
      {running && <span className="card-sweep" aria-hidden="true" />}
      <div className="card-top">
        <span className="id" title={c.id}>{cardRef(c)}</span>
        <span className="card-sp" />
        {since && (
          <span className={'st-since' + (c.stall ? ' stuck' : running ? ' live' : '')} title={`${STATUS_LABEL[c.status]} for ${since}`}>
            {running && !c.stall && <i className="live-sq" aria-hidden="true" />}
            {since}
          </span>
        )}
      </div>
      <span className="card-title">{c.title}</span>
      <div className="card-m">
        {c.assignee ? <Avatar id={c.assignee} /> : <span className="avatar-none" title="unassigned" />}
        <ProjTag id={c.projectId} />
        <span className="card-sp" />
        <PriorityMark p={c.priority} bare />
      </div>
      {tilePrs(c).length > 0 && (
        <div className="card-x">
          <PrPills card={c} />
        </div>
      )}
      <Note card={c} now={now} foot />
    </article>
  );
}

/** The card's marks, the same on the board and in the list: avatar, number, project, priority, time in the column. */
function Marks({ card: c, now }: { card: Card; now: number }) {
  const since = timeInState(c, now);
  return (
    <>
      {c.assignee ? <Avatar id={c.assignee} /> : <span className="avatar-none" title="unassigned" />}
      <span className="id" title={c.id}>{cardRef(c)}</span>
      <ProjTag id={c.projectId} />
      <PriorityMark p={c.priority} />
      <span className="card-sp" />
      {since && <span className={'st-since' + (c.stall ? ' stuck' : '')} title={`${STATUS_LABEL[c.status]} for ${since}`}>{since}</span>}
    </>
  );
}

/**
 * The card's one note: « waits for #N », « Needs your answer », why it is stuck (cardNote). GitHub unreadable: orange.
 * On the board it is the card's footer (#371): a blocked task's kind and its reason, on red.
 */
function Note({ card: c, now, foot }: { card: Card; now: number; foot?: boolean }) {
  const n = cardNote(c, now);
  if (!n) return null;
  const tone = n.tone === 'muted' && prUnreadable(c) ? 'stuck' : n.tone;
  if (foot)
    return (
      <div className={'card-note card-foot ' + tone} title={n.title}>
        {tone === 'needs' ? (
          <>
            <b>{n.text}</b>
            {n.title && <span className="card-foot-why">{n.title}</span>}
          </>
        ) : (
          n.text
        )}
      </div>
    );
  return (
    <span className={'card-note ' + tone} title={n.title}>
      {n.text}
    </span>
  );
}

export function Avatar({ id }: { id: string }) {
  return (
    <AgentFace id={id} title={'@' + id} />
  );
}

/** « New card »: title, description, agent, status, priority. ⌘↵ creates, Esc cancels. */
function NewCard(props: { status: CardStatus; agents: Agent[]; filterAgent: string | null; project: string | null; onClose(): void; onCreate(c: CreateCard): Promise<boolean> }) {
  const pinfo = useProjects();
  const [projectId, setProjectId] = useState(props.project);
  const project = pinfo.byId(projectId);
  // With two projects, only the project's members can take the task.
  const agents = pinfo.multi && project ? props.agents.filter((a) => project.members.some((m) => m.agentId === a.id)) : props.agents;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assigneeRaw, setAssignee] = useState<string>(props.filterAgent ?? '');
  const assignee = agents.some((a) => a.id === assigneeRaw) ? assigneeRaw : '';
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
    if (!title.trim() || busy || att.uploading) return; // Create task waits for the uploads
    if (att.failed) return void att.setNotice(FAILED.replace('before sending', 'first'));
    setBusy(true);
    void att
      .take()
      .then((uploads) => {
        created.current = true; // set before the dialog closes: its images belong to the task now
        return props.onCreate({ title: title.trim(), body, assignee: assignee || null, status, priority, uploads, ...(pinfo.multi && projectId ? { projectId } : {}) });
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
            const files = pastedFiles(e.clipboardData);
            if (!files.length) return;
            e.preventDefault(); // a file, not its name as text
            att.add(files);
          }}
          placeholder="Description, acceptance criteria… (paste or drop files)"
          aria-label="Description"
        />
        <div className="nc-images">
          <TaskImages cardId={null} images={[]} att={att} onAdd={att.add} />
        </div>
        <div className="nc-props">
          {pinfo.multi && project && (
            <label className="prop-pill" title="Project">
              <ProjDot hue={project.colour} />
              <select value={project.id} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
                {pinfo.active.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          )}
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
              {agents.map((a) => (
                <option key={a.id} value={a.id}>@{a.id}</option>
              ))}
            </select>
          </label>
          <label className="prop-pill" title="Priority">
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} aria-label="Priority">
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>{p ? 'Priority ' + priorityName(p) : 'No priority'}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="nc-foot">
          <span className="nc-note">{status === 'triage' ? (pinfo.multi && project ? (project.lead ? `${project.name}'s lead (${project.lead}) shapes it.` : `${project.name} has no lead: assign an agent so it runs.`) : 'The triage agent shapes it.') : assignee ? `@${assignee} picks it up when it is ready.` : 'Assign an agent so it runs.'}</span>
          <button type="submit" className="btn primary small" disabled={!title.trim() || busy || att.uploading} title={att.uploading ? WAITING : undefined}>
            Create task <span className="kbd">⌘↵</span>
          </button>
        </div>
      </form>
    </div>
  );
}
