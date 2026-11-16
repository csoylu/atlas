import { useEffect, useRef, type ReactNode } from 'react';

/** A header button with a drop-down; a click outside or Esc closes it. */
export function Menu(props: { open: boolean; onOpen(open: boolean): void; label: ReactNode; title: string; children: ReactNode }) {
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
    <div className="head-menu" ref={box}>
      <button type="button" className={'head-btn' + (open ? ' open' : '')} aria-expanded={open} aria-haspopup="menu" title={props.title} onClick={() => onOpen(!open)}>
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

