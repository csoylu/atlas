import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { AgentFace } from './AgentFace.tsx';
import { pastedImages, TASK, TaskImages, useAttachments, useFileDrop } from './Images.tsx';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CARD_STATUSES, cardRef, type Doc, type Agent, type Card, type Model } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { Activity, CardComposer, CardNotices, RunLine, useCardConversation, type MessageRef } from './CardPanel.tsx';
import { pillStatus, statusChip } from './cardModal.ts';
import { CardDocs, TaskDocReader, type DocToRead } from './DocPanel.tsx';
import { RewindConfirm, RewindNote, useRewind } from './Rewind.tsx';
import { StatusIcon, STATUS_LABEL } from './StatusIcon.tsx';
import { PrRows } from './PrChips.tsx';
import { ProjTag } from './projects.tsx';
import { timeInState } from './boardView.ts';
import { useMinute } from './useMinute.ts';

export interface CardViewProps {
  card: Card;
  cards: Card[];
  /** Direct chats, to name the chat a card came from. */
  chats: Card[];
  agents: Agent[];
  models: Model[];
  plan: boolean;
  stream: MessageStream;
  userName?: string | null;
  onOpen(id: string): void;
  onOpenChat(id: string): void;
  /** « open on the right »: a document attached to this card. */
  onOpenDoc(doc: Doc): void;
  /**
   * A chip in the thread (#192): show that version and section somewhere else (the thread panel: the chat's documents
   * panel). Without it (elsewhere) the document opens over the task, filling the panel.
   */
  onOpenRef?(ref: MessageRef): void;
  /** Leave the view (close the task panel): after Close task and Delete too. */
  onClose(): void;
  onError(e: unknown): void;
}

/**
 * The whole task (#107): ref, live status, assignee, origin, Move to, title, description, relations, documents,
 * activity, notices, composer and footer. Shown in one shell: the task panel on the right of any screen (ThreadPanel, #222). `close` is the shell's own close controls, at the
 * end of the first header row. `clamp` (the panel): a long description shows its first lines and « Show more », so
 * the latest messages and the composer stay in view.
 */
export const CardView = forwardRef<HTMLTextAreaElement, CardViewProps & { close: ReactNode; clamp?: boolean; titleId?: string }>(
  function CardView(props, composer) {
    const { card, stream, onError, onClose } = props;
    const convo = useCardConversation(card, stream, onError);
    const rw = useRewind(card, convo.run, onError, { globalEsc: false });
    const [title, setTitle] = useState(card.title);
    const now = useMinute();
    const [body, setBody] = useState(card.body);
    // The description reads as rendered markdown; a click (or Edit) switches to the raw text.
    const [editing, setEditing] = useState(false);
    const titleRef = useRef<HTMLTextAreaElement>(null);
    const bodyRef = useRef<HTMLTextAreaElement>(null);
    const [reading, setReading] = useState<DocToRead | null>(null);
    const openRef =
      props.onOpenRef ?? ((r: MessageRef) => setReading({ docId: r.docId, version: r.version, section: r.section, key: String(Date.now()) }));
    const showDoc = props.onOpenRef ? props.onOpenDoc : (d: Doc) => setReading({ docId: d.id, version: null, section: null, key: String(Date.now()) });

    // Agents edit cards too: follow server changes unless the user is typing in that field.
    useEffect(() => {
      if (document.activeElement !== titleRef.current) setTitle(card.title);
    }, [card.title]);
    useEffect(() => {
      if (document.activeElement !== bodyRef.current) setBody(card.body);
    }, [card.body]);

    const save = (patch: Partial<Card>) => api.updateCard(card.id, patch).catch(onError);
    // The task's own images (#119): each one is staged, then added to the task at once (no Save step).
    // The answer of an add / remove shows at once; the live card (its event) takes over when it is as new.
    const [answer, setAnswerRaw] = useState<Card | null>(null);
    const setAnswer = (c: Card) => setAnswerRaw((prev) => (prev && prev.id === c.id && prev.updatedAt > c.updatedAt ? prev : c));
    const images = answer && answer.id === card.id && answer.updatedAt >= card.updatedAt ? answer.images : (card.images ?? []); // ?? : an engine older than the UI
    const att = useAttachments(card.id, { ...TASK, taken: images.length });
    const adding = useRef(new Set<string>());
    useEffect(() => {
      for (const a of att.items) {
        if (!a.upload || a.error || adding.current.has(a.key)) continue;
        adding.current.add(a.key);
        api.addCardImages(card.id, [a.upload.id]).then(
          (c) => {
            setAnswer(c);
            att.drop([a.key], true);
          },
          (e: unknown) => {
            att.drop([a.key]);
            att.setNotice(e instanceof Error ? e.message : String(e));
          },
        );
      }
    }, [att, card.id]);
    const drop = useFileDrop(att.add);
    const onPaste = (e: ClipboardEvent) => {
      const files = pastedImages(e.clipboardData);
      if (!files.length) return;
      e.preventDefault(); // an image, not its file name as text
      att.add(files);
    };
    const status = pillStatus(card, convo.run);
    const chip = statusChip(status);
    const running = card.status === 'running' || convo.run?.status === 'running';
    const byId = new Map(props.cards.map((c) => [c.id, c]));
    const children = props.cards.filter((c) => c.parents.includes(card.id));
    const linkable = props.cards.filter((c) => c.id !== card.id && !card.parents.includes(c.id));
    const origin = card.originCard ? props.chats.find((c) => c.id === card.originCard) : undefined;
    const since = timeInState(card, now);
    const finished = card.status === 'closed' || card.status === 'done' || card.status === 'archived';
    const leaveEditing = () => {
      setEditing(false);
      if (body !== card.body) save({ body });
    };

    return (
      <>
        <header className="cm-head">
          <div className="cm-row">
            <span className="id cm-id" title={card.id}>{cardRef(card)}</span>
            <ProjTag id={card.projectId} title="Project (set when the task was made)" />
            {chip ? (
              <span className={'cm-pill st-chip ' + chip.kind} title="Status (live)">
                {chip.label}
              </span>
            ) : (
              <span className={'cm-pill ' + status} title="Status (live)">
                <StatusIcon status={status === 'stopped' ? 'failed' : status} />
                {status === 'stopped' ? 'Stopped by you' : STATUS_LABEL[status]}
              </span>
            )}
            {since && (
              <span className={'st-since' + (card.stall ? ' stuck' : '')} title={`${STATUS_LABEL[card.status]} for ${since}, since ${new Date(card.statusSince!).toLocaleString()}`}>
                {since}
              </span>
            )}
            <label className="prop-pill" title="Assignee">
              {card.assignee ? (
                <AgentFace id={card.assignee} />
              ) : (
                <span className="avatar-none" />
              )}
              <select value={card.assignee ?? ''} onChange={(e) => save({ assignee: e.target.value || null })} aria-label="Assignee">
                <option value="">unassigned</option>
                {props.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.id}
                  </option>
                ))}
              </select>
            </label>
            {card.status === 'review' && card.reviewer && (
              <span className="prop-pill rv-face" title="Reviewer: checks and merges the pull request">
                <AgentFace id={card.reviewer} />
                review @{card.reviewer}
              </span>
            )}
            {card.originCard ? (
              origin ? (
                <button type="button" className="cm-origin" onClick={() => props.onOpenChat(origin.id)} title="Open that chat">
                  from chat with @{origin.assignee}
                </button>
              ) : (
                <span className="cm-faint">from a deleted chat</span>
              )
            ) : (
              <span className="cm-faint">by {card.createdBy === 'user' ? (props.userName ?? 'you') : '@' + card.createdBy}</span>
            )}
            <span className="cm-sp" />
            <label className="prop-pill" title="Move to">
              <StatusIcon status={card.status} />
              <select value={card.status} onChange={(e) => save({ status: e.target.value as Card['status'] })} aria-label="Status">
                {CARD_STATUSES.map((s) =>
                  // Running is set when a run starts; the engine refuses it by hand (#121), so say so here.
                  s === 'running' && card.status !== 'running' ? (
                    <option key={s} value={s} disabled>
                      {STATUS_LABEL[s]} (starts with a run)
                    </option>
                  ) : (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ),
                )}
              </select>
            </label>
            {props.close}
          </div>
          {/* A textarea sized to its text: a long title wraps instead of scrolling out of sight; Enter saves. */}
          <textarea
            id={props.titleId}
            ref={titleRef}
            className="cm-title"
            rows={1}
            value={title}
            aria-label="Title"
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, ' '))}
            onBlur={() => title.trim() && title !== card.title && save({ title })}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              e.currentTarget.blur();
            }}
          />
          <PrRows card={card} />
        </header>
        <div className="cm-body">
          <div className={'cm-desc-area drop-zone' + (drop.dragging ? ' dropping' : '')} {...drop.props} onPaste={onPaste}>
          {editing || !body.trim() ? (
            <textarea
              ref={bodyRef}
              className="cm-desc"
              value={body}
              autoFocus={editing}
              placeholder="Description, acceptance criteria… (paste or drop images)"
              aria-label="Description"
              onChange={(e) => setBody(e.target.value)}
              onBlur={leaveEditing}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                // Esc only leaves editing: the panel stays open, the chat's Esc (stop) doesn't fire.
                e.preventDefault();
                e.stopPropagation();
                leaveEditing();
              }}
            />
          ) : (
            <Description body={body} clamp={!!props.clamp} onEdit={() => setEditing(true)} />
          )}
            <TaskImages
              cardId={card.id}
              images={images}
              att={att}
              onAdd={att.add}
              onRemove={(im) => void api.removeCardImage(card.id, im.path).then(setAnswer, onError)}
            />
          </div>
          <div className="relations">
            <span className="label">after</span>
            {card.parents.map((p) => (
              <span key={p} className="chip">
                <StatusIcon status={byId.get(p)?.status ?? 'done'} size={12} />
                <button className="link" onClick={() => props.onOpen(p)} title={byId.get(p)?.title}>
                  {byId.get(p)?.title ?? p}
                </button>
                <button className="x" onClick={() => save({ parents: card.parents.filter((x) => x !== p) })} aria-label="Unlink">
                  ×
                </button>
              </span>
            ))}
            <select className="add-link" value="" onChange={(e) => e.target.value && save({ parents: [...card.parents, e.target.value] })}>
              <option value="">+ parent</option>
              {linkable.map((c) => (
                <option key={c.id} value={c.id}>
                  {cardRef(c)} {c.title}
                </option>
              ))}
            </select>
            {children.length > 0 && (
              <>
                <span className="label">then</span>
                {children.map((c) => (
                  <span key={c.id} className="chip">
                    <StatusIcon status={c.status} size={12} />
                    <button className="link" onClick={() => props.onOpen(c.id)}>
                      {c.title}
                    </button>
                  </span>
                ))}
              </>
            )}
          </div>
          <CardDocs cardId={card.id} stream={stream} onShow={showDoc} onOpenCard={props.onOpen} onError={onError} />
          <h3 className="cm-h">Activity</h3>
          <div className="chat cm-activity">
            <Activity
              convo={convo}
              card={card}
              stream={stream}
              userName={props.userName}
              onOpenCard={props.onOpen}
              onOpenRef={openRef}
              cards={props.cards}
              onRewind={rw.ask}
              onUndo={rw.undoById}
              onError={onError}
              empty={card.assignee ? `Write to @${card.assignee}: it works here and answers live.` : 'Assign an agent, then write to it here.'}
            />
          </div>
        </div>
        <div className="cm-notices">
          <CardNotices card={card} onError={onError} />
          <RewindNote rw={rw} />
          {!rw.hideRun && <RunLine run={convo.run} stop={false} onStop={() => undefined} />}
        </div>
        <CardComposer ref={composer} card={card} agents={props.agents} models={props.models} plan={props.plan} stream={stream} onError={onError} rewind={rw} />
        <footer className="cm-foot">
          {running && (
            <button type="button" className="cm-stop" onClick={() => void rw.stopTurn()} title="Stop. If it was answering your last message, that turn is rewound (Esc)">
              ■ Stop
            </button>
          )}
          {!finished && (
            <button type="button" className="cm-btn" onClick={() => api.updateCard(card.id, { status: 'closed' }).then(onClose, onError)}>
              Close task
            </button>
          )}
          <span className="cm-sp" />
          <button
            type="button"
            className="ghost danger cm-delete"
            onClick={() => {
              if (confirm(`Delete ${cardRef(card)} and its chat?`)) api.deleteCard(card.id).then(onClose, onError);
            }}
          >
            Delete
          </button>
        </footer>
        <RewindConfirm rw={rw} />
        {reading && <TaskDocReader read={reading} stream={stream} onOpenInPanel={props.onOpenDoc} onBack={() => setReading(null)} onError={onError} />}
      </>
    );
  },
);

/** The rendered description; click to edit. Clamped (the panel): the first lines, then « Show more » if it is longer. */
function Description({ body, clamp, onEdit }: { body: string; clamp: boolean; onEdit(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!clamp || open || !el) return;
    const measure = () => setLong(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [clamp, open, body]);
  const clamped = clamp && !open;
  return (
    <>
      <div
        ref={ref}
        className={'cm-desc md' + (clamped ? ' clamped' : '') + (clamped && long ? ' cut' : '')}
        role="button"
        tabIndex={0}
        title="Click to edit"
        aria-label="Description (click to edit)"
        onClick={(e) => (e.target as HTMLElement).closest('a') || onEdit()}
        onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onEdit())}
      >
        <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
      </div>
      {clamp && (long || open) && (
        <button type="button" className="cm-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}
