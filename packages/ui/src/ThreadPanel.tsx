import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cardRef } from '@atlas/shared';
import { CardView, type CardViewProps } from './CardView.tsx';
import { Icon } from './ScreenHeader.tsx';
import { usePanelMode } from './DocPanel.tsx';
import { usePanelResize, type PanelResize } from './PanelResizer.tsx';
import { CHAT_MIN, taskPanelMode, type PanelMode } from './docPanel.ts';

/**
 * The task view (#107, #222): the whole task (CardView) in the side panel, wherever it is opened (chat, board in
 * kanban or list mode, inbox, sidebar, search, a #N link). Side by side above 960px, over the screen from the right
 * down to 760px, full screen with « ‹ Back » on phones. × and Esc close it (a menu, an editor or a dialog takes Esc
 * first); Delete and Close task close it too. A long description is clamped so the conversation and composer stay in view.
 */
export function ThreadPanel(
  props: CardViewProps & {
    mode: PanelMode;
    resize?: PanelResize;
    /** The screen underneath, for « ‹ Chat », « ‹ Board »… (overlay and phone). */
    back: string;
    /** Focus the task's composer on open (not beside a chat: its own composer keeps the focus). */
    autoFocus?: boolean;
  },
) {
  const { mode, resize, back, autoFocus, ...view } = props;
  const { onClose } = props;
  const composer = useRef<HTMLTextAreaElement>(null);
  // Focus goes back to whatever opened the task (a board card, a row) on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    if (autoFocus) composer.current?.focus({ preventScroll: true });
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [autoFocus]);
  // Esc closes, unless something handled it first (a menu, the description editor, the document reader) or a dialog
  // (New task, a confirmation, the palette) is open above.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <aside
      className={'side-doc card-view thread-panel ' + mode}
      aria-label={`Task ${cardRef(props.card)}`}
      style={resize && mode !== 'full' ? { width: resize.width } : undefined}
    >
      {mode !== 'full' && resize?.handle}
      <CardView
        {...view}
        ref={composer}
        clamp
        close={
          <>
            {mode !== 'side' && (
              <button type="button" className="sd-btn" title={'Back to the ' + back.toLowerCase()} onClick={onClose}>
                ‹ {back}
              </button>
            )}
            <button type="button" className="sd-btn icon-only" title="Close the task (Esc)" aria-label="Close the task" onClick={onClose}>
              <Icon.x />
            </button>
          </>
        }
      />
    </aside>
  );
}

/**
 * A screen with the task panel on its right (#222): the board, the inbox, the Library, workflows, settings. The screen
 * stays usable on the left (`screenMin` wide at least: CHAT_MIN for the board, which scrolls sideways, SCREEN_MIN for
 * two-pane screens); the panel has the chat's width, separator and stored width (#211). Without room for both, the
 * panel goes over the screen from the right. Always rendered, open or not, so the screen underneath keeps its state
 * (scroll, selection) when a task opens.
 */
export function TaskSplit(props: { open: boolean; screenMin?: number; panel(mode: PanelMode, resize: PanelResize | undefined): ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const screenMin = props.screenMin ?? CHAT_MIN;
  const [view, setView] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setView(el.clientWidth);
    const ro = new ResizeObserver(() => setView(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const mode = taskPanelMode(usePanelMode(), view, screenMin);
  const resize = usePanelResize(ref, mode, screenMin);
  return (
    <div ref={ref} className={'task-split' + (props.open ? ' with-doc ' + mode : '')}>
      {props.children}
      {props.open && props.panel(mode, resize)}
    </div>
  );
}
