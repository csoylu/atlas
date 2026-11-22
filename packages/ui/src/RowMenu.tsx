import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { menuPosition } from './chatHistoryMenu.ts';

export interface RowMenuItem {
  label: string;
  icon?: ReactNode;
  /** Archive, Delete: in the negative colour. */
  danger?: boolean;
  onClick(): void;
}

export interface RowMenuAt {
  /** What the menu is for (a chat id); one menu open at a time. */
  key: string;
  x: number;
  y: number;
  trigger: HTMLElement;
}

/** How long a finger stays on a row before its menu opens (phone, #338). */
const LONG_PRESS_MS = 500;

/**
 * The menu of a sidebar row (History chats #232, agent rows #338): right-click, Shift+F10 or the context key, and a
 * long-press on a phone. `bind(key)` goes on the row; the row's click is skipped after a long-press opened the menu.
 */
export function useRowMenu() {
  const [at, setAt] = useState<RowMenuAt | null>(null);
  const pressed = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const opened = useRef(false);
  const cancel = () => {
    if (pressed.current) clearTimeout(pressed.current.timer);
    pressed.current = null;
  };
  useEffect(() => cancel, []);
  const bind = (key: string) => ({
    'aria-haspopup': 'menu' as const,
    'aria-expanded': at?.key === key,
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault();
      setAt({ key, x: e.clientX, y: e.clientY, trigger: e.currentTarget });
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      setAt({ key, x: rect.left + 12, y: rect.bottom, trigger: e.currentTarget });
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      opened.current = false;
      if (e.pointerType !== 'touch') return;
      cancel();
      const trigger = e.currentTarget;
      const { clientX: x, clientY: y } = e;
      pressed.current = {
        x,
        y,
        timer: setTimeout(() => {
          pressed.current = null;
          opened.current = true;
          setAt({ key, x, y, trigger });
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      // A scroll, not a press.
      if (pressed.current && Math.hypot(e.clientX - pressed.current.x, e.clientY - pressed.current.y) > 8) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  });
  /** The row's click: false right after a long-press opened the menu (the finger lifting is not a click). */
  const clicked = () => {
    if (!opened.current) return true;
    opened.current = false;
    return false;
  };
  return { at, setAt, bind, clicked };
}

/** The open menu, in a portal, kept inside the viewport; arrows, Home and End move between its items. */
export function RowMenu({ at, label, items, onClose }: { at: RowMenuAt; label: string; items: RowMenuItem[]; onClose(): void }) {
  const popup = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  useLayoutEffect(() => {
    if (!popup.current) return;
    const bounds = popup.current.getBoundingClientRect();
    const pos = menuPosition(at.x, at.y, bounds.width, bounds.height, window.innerWidth, window.innerHeight);
    popup.current.style.left = `${pos.left}px`;
    popup.current.style.top = `${pos.top}px`;
    refs.current[0]?.focus();
  }, [at]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (!popup.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        at.trigger.focus();
        onClose();
      } else if (e.key === 'Tab') {
        // Resume ordinary sidebar tab order instead of trapping focus in the portal.
        at.trigger.focus();
        onClose();
      }
    };
    const scroll = (e: Event) => {
      if (!popup.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('hashchange', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('hashchange', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [at, onClose]);
  const move = (e: ReactKeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = items.length;
    const to = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    refs.current[to]?.focus();
  };
  return createPortal(
    <div
      ref={popup}
      id="chat-history-menu"
      className="chat-history-menu"
      role="menu"
      aria-label={label}
      style={{ left: at.x, top: at.y }}
      onContextMenu={(e) => e.preventDefault()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onClose();
      }}
    >
      {items.map((it, i) => (
        <button
          key={it.label}
          ref={(el) => void (refs.current[i] = el)}
          role="menuitem"
          className={it.danger ? undefined : 'plain'}
          onClick={() => {
            at.trigger.focus();
            onClose();
            it.onClick();
          }}
          onKeyDown={(e) => move(e, i)}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** « Mark as read »'s check. */
export const CheckIcon = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4.5 10.5l3.5 3.5 7.5-8" />
  </svg>
);

