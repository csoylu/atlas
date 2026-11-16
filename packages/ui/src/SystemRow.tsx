import { useState, type ReactNode } from 'react';
import { ChatRow, RowIconSvg } from './ChatRow.tsx';
import { CardRefLink, type TurnCards } from './CardStepDetail.tsx';
import type { SysRow } from './sysRows.ts';

const changeLabel = { restored: 'restored', recreated: 'brought back', deleted: 'removed' } as const;

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

function SysBodyView({ row, renderText, onRetry, onUndo }: Parameters<typeof SystemRow>[0]) {
  const b = row.body!;
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    // Failures reach the caller's onError (a toast); the button comes back for another try.
    void fn().finally(() => setBusy(false));
  };
  if (b.kind === 'markdown') return <>{renderText(b.text)}</>;
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
  const more = b.files.length - SHOWN;
  return (
    <>
      {b.error && <pre className="step-out err">{b.error}</pre>}
      {b.files.length > 0 && (
        <ul className="sys-files">
          {b.files.slice(0, SHOWN).map((f) => (
            <li key={f.path}>
              <span className={'rewind-change ' + f.change}>{changeLabel[f.change]}</span>
              <span className="sys-file" title={f.path}>
                {f.path}
              </span>
            </li>
          ))}
          {more > 0 && <li className="sys-more">… {more} more</li>}
        </ul>
      )}
      {b.undoId && onUndo && (
        <div className="sys-foot">
          <button type="button" className="chat-row-open" disabled={busy} onClick={() => act(() => onUndo(b.undoId!))}>
            Undo rewind
          </button>
        </div>
      )}
    </>
  );
}

const SHOWN = 12;
