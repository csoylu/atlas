import { useEffect, useRef } from 'react';
import { trapFocus } from './cardModal.ts';
import { CardView, type CardViewProps } from './CardView.tsx';
import { Icon } from './ScreenHeader.tsx';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The ticket: one centred modal, taller than wide, opened from the Board, chat pins, links in system lines, schedules
 * and canvases (mockup `mockups/workflow.html`, scenario 3). Esc or a scrim click closes it; focus stays inside.
 * The content is CardView, shared with the thread panel (#107).
 */
export function CardModal(props: CardViewProps) {
  const { onClose } = props;
  const composer = useRef<HTMLTextAreaElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

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

  return (
    <div className="card-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="card-view card-modal" role="dialog" aria-modal="true" aria-labelledby="card-modal-title">
        <CardView
          {...props}
          ref={composer}
          titleId="card-modal-title"
          close={
            <button type="button" className="icon-btn cm-x" onClick={onClose} aria-label="Close">
              <Icon.x />
            </button>
          }
        />
      </div>
    </div>
  );
}
