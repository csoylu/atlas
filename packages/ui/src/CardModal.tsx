import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CARD_STATUSES, cardRef, type Doc, type Agent, type Card, type Model } from '@atlas/shared';
import { api } from './api.ts';
import type { MessageStream } from './useMessages.ts';
import { Activity, CardComposer, CardNotices, RunLine, useCardConversation } from './CardPanel.tsx';
import { pillStatus, trapFocus } from './cardModal.ts';
import { CardDocs } from './DocPanel.tsx';
import { RewindConfirm, RewindNote, useRewind } from './Rewind.tsx';
import { Icon } from './ScreenHeader.tsx';
import { StatusIcon, STATUS_LABEL } from './StatusIcon.tsx';
import { tint } from './agentTint.ts';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The ticket: one centred modal, taller than wide, opened from the Board, chat pins, links in system lines, schedules
 * and canvases (mockup `mockups/workflow.html`, scenario 3). Esc or a scrim click closes it; focus stays inside.
 */
export function CardModal(props: {
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
  onClose(): void;
  onError(e: unknown): void;
}) {
  const { card, stream, onError, onClose } = props;
  const convo = useCardConversation(card, stream, onError);
  const rw = useRewind(card, convo.run, onError, { globalEsc: false });
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  // The description reads as rendered markdown; a click (or Edit) switches to the raw text.
  const [editing, setEditing] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  // Agents edit cards too: follow server changes unless the user is typing in that field.
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(card.title);
  }, [card.title]);
  useEffect(() => {
    if (document.activeElement !== bodyRef.current) setBody(card.body);
  }, [card.body]);

  // Focus the composer on open, give focus back to whatever opened the modal on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    composer.current?.focus({ preventScroll: true });
    return () => before?.focus?.({ preventScroll: true });
  }, []);

  // Esc closes (unless something inside handled it first: a menu, an expanded canvas); Tab stays inside.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab' && dialog.current) {
        const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
        const next = trapFocus(items, document.activeElement as HTMLElement | null, e.shiftKey);
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const save = (patch: Partial<Card>) => api.updateCard(card.id, patch).catch(onError);
  const status = pillStatus(card, convo.run);
  const running = card.status === 'running' || convo.run?.status === 'running';
  const byId = new Map(props.cards.map((c) => [c.id, c]));
  const children = props.cards.filter((c) => c.parents.includes(card.id));
  const linkable = props.cards.filter((c) => c.id !== card.id && !card.parents.includes(c.id));
  const origin = card.originCard ? props.chats.find((c) => c.id === card.originCard) : undefined;
  const finished = card.status === 'closed' || card.status === 'done' || card.status === 'archived';

  return (
    <div className="card-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="card-modal" role="dialog" aria-modal="true" aria-labelledby="card-modal-title">
        <header className="cm-head">
          <div className="cm-row">
            <span className="id cm-id" title={card.id}>{cardRef(card)}</span>
            <span className={'cm-pill ' + status} title="Status (live)">
              <StatusIcon status={status === 'stopped' ? 'failed' : status} />
              {status === 'stopped' ? 'Stopped by you' : STATUS_LABEL[status]}
            </span>
            <label className="prop-pill" title="Assignee">
              {card.assignee ? (
                <span className="dot-avatar" style={tint(card.assignee)} aria-hidden="true">{card.assignee.slice(0, 1).toUpperCase()}</span>
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
                {CARD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="icon-btn cm-x" onClick={onClose} aria-label="Close">
              <Icon.x />
            </button>
          </div>
          <input
            id="card-modal-title"
            ref={titleRef}
            className="cm-title"
            value={title}
            aria-label="Title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== card.title && save({ title })}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </header>
        <div className="cm-body">
          {editing || !body.trim() ? (
            <textarea
              ref={bodyRef}
              className="cm-desc"
              value={body}
              autoFocus={editing}
              placeholder="Description, acceptance criteria…"
              aria-label="Description"
              onChange={(e) => setBody(e.target.value)}
              onBlur={() => {
                setEditing(false);
                if (body !== card.body) save({ body });
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.preventDefault(); // keep the modal open: Esc only leaves editing
                setEditing(false);
                if (body !== card.body) save({ body });
              }}
            />
          ) : (
            <div
              className="cm-desc md"
              role="button"
              tabIndex={0}
              title="Click to edit"
              aria-label="Description (click to edit)"
              onClick={(e) => (e.target as HTMLElement).closest('a') || setEditing(true)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), setEditing(true))}
            >
              <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
            </div>
          )}
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
          <CardDocs cardId={card.id} stream={stream} onOpenInPanel={props.onOpenDoc} onOpenCard={props.onOpen} onError={onError} />
          <h3 className="cm-h">Activity</h3>
          <div className="chat cm-activity">
            <Activity
              convo={convo}
              card={card}
              stream={stream}
              userName={props.userName}
              onOpenCard={props.onOpen}
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
              Close card
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
      </div>
      <RewindConfirm rw={rw} />
    </div>
  );
}
