import { useState, type ReactNode } from 'react';
import { ChatRow, RowIconSvg } from './ChatRow.tsx';
import { CardRefLink, type TurnCards } from './CardStepDetail.tsx';
import type { SysRow } from './sysRows.ts';
import { RewindGroups } from './RewindGroups.tsx';

/**
 * A system event between turns (#66): start prompt, message from a card, scheduled run, stopped / failed / interrupted
 * run, rewind, summary point. Same row as a tool call, on its own. Retry and Undo act from the expanded row.
 */
export function SystemRow(props: {
  row: SysRow;
  cards?: TurnCards;
  renderText(text: string): ReactNode;
  onRetry?(): Promise<unknown>;
  onUndo?(rewindId: string): Promise<unknown>;
  /** A /clear row (#99): show or hide the messages before it, and undo it. */
  onToggleEarlier?(): void;
  onUndoClear?(clearId: string): Promise<unknown>;
}) {
  const { row: r, cards } = props;
  // A message from a card: its title when it's on the board, else who sent it.
  const title = r.ref ? cards?.card?.(r.ref)?.title : undefined;
  return (
    <ChatRow
      className={'sys-row sys-' + r.icon}
      icon={<RowIconSvg name={r.icon} />}
      verb={
        r.ref ? (
          <>
            {r.verb} <CardRefLink ref_={r.ref} cards={cards} />
          </>
        ) : (
          r.verb
        )
      }
      object={title ?? r.object}
      mono={r.mono}
      rest={r.rest}
      meta={r.meta}
      at={r.at}
      tone={r.tone}
      defaultOpen={r.open}
    >
      {r.body && <SysBodyView {...props} />}
    </ChatRow>
  );
}

function SysBodyView({ row, renderText, onRetry, onUndo, onToggleEarlier, onUndoClear }: Parameters<typeof SystemRow>[0]) {
  const b = row.body!;
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    // Failures reach the caller's onError (a toast); the button comes back for another try.
    void fn().finally(() => setBusy(false));
  };
  if (b.kind === 'markdown') return <>{renderText(b.text)}</>;
  if (b.kind === 'clear')
    return (
      <>
        <p className="sys-clear-note">Nothing was deleted: the messages stay here and history_search still finds them. The agent doesn't see them any more.</p>
        <div className="sys-foot">
          {onToggleEarlier && b.hidden > 0 && (
            <button type="button" className="chat-row-open" onClick={onToggleEarlier}>
              {b.expanded ? 'Hide earlier messages' : `Show ${b.hidden} earlier message${b.hidden === 1 ? '' : 's'}`}
            </button>
          )}
          {b.undoId && onUndoClear && (
            <button type="button" className="chat-row-open" disabled={busy} onClick={() => act(() => onUndoClear(b.undoId!))}>
              Undo clear
            </button>
          )}
        </div>
      </>
    );
  if (b.kind === 'error')
    return (
      <>
        <pre className="step-out err">{b.text}</pre>
        <div className="sys-foot">
          {b.retry && onRetry && (
            <button type="button" className="chat-row-open" disabled={busy} onClick={() => act(onRetry)}>
              Retry
            </button>
          )}
          <span>@{b.agent}</span>
        </div>
      </>
    );
  return (
    <>
      {b.error && <pre className="step-out err">{b.error}</pre>}
      {(b.files.length > 0 || b.effects.length > 0) && (
        <div className="rw-groups">
          <RewindGroups files={b.files} effects={b.effects} keptHead="Kept" />
        </div>
      )}
      {b.undoId && onUndo && (
        <div className="sys-foot">
          <button type="button" className="chat-row-open" disabled={busy} onClick={() => act(() => onUndo(b.undoId!))}>
            Undo rewind
          </button>
          <span>Brings back the messages{b.files.length || b.effects.some((e) => e.outcome === 'undone') ? ' and everything undone above' : ''}.</span>
        </div>
      )}
    </>
  );
}

