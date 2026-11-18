import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** A header button with a drop-down; a click outside or Esc closes it. */
export function Menu(props: { open: boolean; onOpen(open: boolean): void; label: ReactNode; title: string; children: ReactNode; className?: string; btnClass?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const { open, onOpen } = props;
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => (e.target instanceof Node && box.current?.contains(e.target)) || onOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onOpen(false);
    };
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [open, onOpen]);
  return (
    <div className={'head-menu' + (props.className ? ' ' + props.className : '')} ref={box}>
      <button type="button" className={'head-btn' + (props.btnClass ? ' ' + props.btnClass : '') + (open ? ' open' : '')} aria-expanded={open} aria-haspopup="menu" title={props.title} onClick={() => onOpen(!open)}>
        {props.label}
      </button>
      {open && (
        <div className="head-pop" role="menu">
          {props.children}
        </div>
      )}
    </div>
  );
}

export function PopRow({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={on} className={'pop-row' + (on ? ' on' : '')} onClick={onClick}>
      {children}
      {on && (
        <svg className="pop-check" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m3.5 8.5 3 3 6-7" />
        </svg>
      )}
    </button>
  );
}


/**
 * A button with a menu drawn over everything (portalled, fixed under the button, flipped up when there is no room):
 * the viewer's version picker and ⋯, the Library's row and folder ⋯ (#120). A click outside, Esc or a scroll closes
 * it; `children` gets close().
 */
export function PopButton(props: {
  className: string;
  label: ReactNode;
  title: string;
  ariaLabel?: string;
  width?: number;
  children(close: () => void): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const close = () => setOpen(false);
  useLayoutEffect(() => {
    if (!open || !btn.current || !pop.current) return setPos(null);
    const r = btn.current.getBoundingClientRect();
    const w = pop.current.offsetWidth;
    const h = pop.current.offsetHeight;
    setPos({
      left: Math.max(8, Math.min(r.right - w, innerWidth - w - 8)),
      top: r.bottom + 6 + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : r.bottom + 6,
    });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => t instanceof Node && (pop.current?.contains(t) || btn.current?.contains(t));
    const down = (e: MouseEvent) => inside(e.target) || setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      btn.current?.focus();
    };
    const scroll = (e: Event) => inside(e.target) || setOpen(false);
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={props.className + (open ? ' open' : '')}
        aria-haspopup="menu"
        aria-expanded={open}
        title={props.title}
        aria-label={props.ariaLabel}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {props.label}
      </button>
      {open &&
        createPortal(
          <div
            ref={pop}
            className="head-pop fixed-pop"
            role="menu"
            style={{ width: props.width ?? 260, left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            {props.children(close)}
          </div>,
          document.body,
        )}
    </>
  );
}

/** A plain menu item (icon, text, optional right-hand note). */
export function PopItem({ icon, children, sub, danger, onClick }: { icon?: ReactNode; children: ReactNode; sub?: ReactNode; danger?: boolean; onClick(): void }) {
  return (
    <button type="button" role="menuitem" className={'pop-row' + (danger ? ' danger' : '')} onClick={onClick}>
      {icon}
      <span className="pop-t">{children}</span>
      {sub !== undefined && <span className="pop-sub">{sub}</span>}
    </button>
  );
}
