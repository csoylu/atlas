import { cardRef } from '@atlas/shared';
import { CardView, type CardViewProps } from './CardView.tsx';
import { Icon } from './ScreenHeader.tsx';
import type { PanelMode } from './docPanel.ts';
import type { PanelResize } from './PanelResizer.tsx';

/**
 * A task beside the main chat it came from (v3, #107): the whole task, as in the ticket modal (CardView), in the side
 * panel's place. A long description is clamped so the conversation and composer stay in view. × (and « ‹ Chat » over
 * the chat or on a phone) closes the panel; Delete and Close task close it too.
 */
export function ThreadPanel(props: CardViewProps & { mode: PanelMode; resize?: PanelResize }) {
  const { mode, resize, ...view } = props;
  return (
    <aside
      className={'side-doc card-view thread-panel ' + mode}
      aria-label={`Task ${cardRef(props.card)}`}
      style={resize && mode !== 'full' ? { width: resize.width } : undefined}
    >
      {mode !== 'full' && resize?.handle}
      <CardView
        {...view}
        clamp
        close={
          <>
            {mode !== 'side' && (
              <button type="button" className="sd-btn" title="Back to the chat" onClick={props.onClose}>
                ‹ Chat
              </button>
            )}
            <button type="button" className="sd-btn icon-only" title="Close the thread" aria-label="Close the thread" onClick={props.onClose}>
              <Icon.x />
            </button>
          </>
        }
      />
    </aside>
  );
}
