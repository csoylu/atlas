import { cardRef, type Agent, type Card, type Model } from '@atlas/shared';
import type { MessageStream } from './useMessages.ts';
import { Activity, CardComposer, CardNotices, RunLine, useCardConversation } from './CardPanel.tsx';
import { pillStatus } from './cardModal.ts';
import { RewindConfirm, RewindNote, useRewind } from './Rewind.tsx';
import { Icon } from './ScreenHeader.tsx';
import { StatusIcon, STATUS_LABEL } from './StatusIcon.tsx';
import type { PanelMode } from './docPanel.ts';

/**
 * A task's thread beside the main chat it came from (v3): its live conversation and composer, in the side panel's
 * place. « Details » opens the ticket modal (title, description, links, delete); × goes back to the documents.
 */
export function ThreadPanel(props: {
  card: Card;
  cards: Card[];
  agents: Agent[];
  models: Model[];
  plan: boolean;
  mode: PanelMode;
  stream: MessageStream;
  userName: string | null;
  onOpenCard(id: string): void;
  onDetails(): void;
  onClose(): void;
  onError(e: unknown): void;
}) {
  const { card, stream, onError } = props;
  const convo = useCardConversation(card, stream, onError);
  const rw = useRewind(card, convo.run, onError, { globalEsc: false });
  const status = pillStatus(card, convo.run);
  return (
    <aside className={'side-doc thread-panel ' + props.mode} aria-label={`Task ${cardRef(card)}`}>
      <header className="tp-head">
        <span className="id">{cardRef(card)}</span>
        <span className={'cm-pill ' + status} title="Status (live)">
          <StatusIcon status={status === 'stopped' ? 'failed' : status} />
          {status === 'stopped' ? 'Stopped' : STATUS_LABEL[status]}
        </span>
        <span className="tp-title" title={card.title}>{card.title}</span>
        <button type="button" className="sd-btn" onClick={props.onDetails} title="Title, description, links">
          Details
        </button>
        {props.mode !== 'side' && (
          <button type="button" className="sd-btn" title="Back to the chat" onClick={props.onClose}>
            ‹ Chat
          </button>
        )}
        <button type="button" className="sd-btn icon-only" title="Close the thread" aria-label="Close the thread" onClick={props.onClose}>
          <Icon.x />
        </button>
      </header>
      <div className="chat tp-activity">
        <Activity
          convo={convo}
          card={card}
          stream={stream}
          userName={props.userName}
          onOpenCard={props.onOpenCard}
          cards={props.cards}
          onRewind={rw.ask}
          onUndo={rw.undoById}
          onError={onError}
          empty={card.assignee ? `Write to @${card.assignee}: it works here and answers live.` : 'Assign an agent, then write to it here.'}
        />
      </div>
      <div className="cm-notices">
        <CardNotices card={card} onError={onError} />
        <RewindNote rw={rw} />
        {!rw.hideRun && <RunLine run={convo.run} stop={false} onStop={() => undefined} />}
      </div>
      <CardComposer card={card} agents={props.agents} models={props.models} plan={props.plan} stream={stream} onError={onError} rewind={rw} />
      <RewindConfirm rw={rw} />
    </aside>
  );
}
