import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Card } from '@atlas/shared';
import { tint } from './agentTint.ts';
import { menuPosition } from './chatHistoryMenu.ts';

export function ChatHistory({ chats, selected, onSelect, onDelete }: {
  chats: Card[];
  selected?: string;
  onSelect(id: string): void;
  onDelete(chat: Card): void;
}) {
  const [menu, setMenu] = useState<{ chat: Card; x: number; y: number; trigger: HTMLButtonElement } | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const close = (restoreFocus = false) => {
    if (restoreFocus) menu?.trigger.focus();
    setMenu(null);
  };
  useLayoutEffect(() => {
    if (!menu || !popup.current) return;
    const bounds = popup.current.getBoundingClientRect();
    const pos = menuPosition(menu.x, menu.y, bounds.width, bounds.height, window.innerWidth, window.innerHeight);
    popup.current.style.left = `${pos.left}px`;
    popup.current.style.top = `${pos.top}px`;
    action.current?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      if (!popup.current?.contains(e.target as Node)) setMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault(); menu.trigger.focus(); setMenu(null);
      } else if (e.key === 'Tab') {
        // Resume ordinary sidebar tab order instead of trapping focus in the portal.
        menu.trigger.focus(); setMenu(null);
      }
    };
    const dismiss = () => setMenu(null);
    const scroll = (e: Event) => { if (!popup.current?.contains(e.target as Node)) dismiss(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('hashchange', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('hashchange', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [menu]);
  useEffect(() => {
    if (menu && !chats.some(c => c.id === menu.chat.id)) setMenu(null);
  }, [chats, menu]);

  return <div className="chat-history">
    {chats.map(c => <button key={c.id}
      className={'chat-hist-item' + (selected === c.id ? ' active' : '')}
      aria-current={selected === c.id ? 'page' : undefined}
      aria-haspopup="menu" aria-expanded={menu?.chat.id === c.id}
      aria-controls={menu?.chat.id === c.id ? 'chat-history-menu' : undefined}
      title={`${c.title} · @${c.assignee} · Right-click or Shift+F10 for actions`}
      onClick={() => { close(); onSelect(c.id); }}
      onContextMenu={e => {
        e.preventDefault();
        setMenu({ chat: c, x: e.clientX, y: e.clientY, trigger: e.currentTarget });
      }}
      onKeyDown={e => {
        if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        setMenu({ chat: c, x: rect.left + 12, y: rect.bottom, trigger: e.currentTarget });
      }}>
      <span className="dot-avatar" style={tint(c.assignee ?? '')}>{(c.assignee ?? '?').slice(0, 1).toUpperCase()}</span>
      <span className="chat-hist-title">{c.title}</span>
      <span className="chat-hist-when">{ago(c.updatedAt)}</span>
    </button>)}
    {menu && createPortal(<div ref={popup} id="chat-history-menu" className="chat-history-menu" role="menu"
      aria-label={`Actions for ${menu.chat.title}`} style={{ left: menu.x, top: menu.y }}
      onContextMenu={e => e.preventDefault()} onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget)) setMenu(null);
      }}>
      <button ref={action} role="menuitem" onClick={() => { close(true); onDelete(menu.chat); }}
        onKeyDown={e => {
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); action.current?.focus(); }
        }}>
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 5.5h13M8 3h4l1 2.5H7L8 3ZM5.5 5.5l.7 11h7.6l.7-11M8.5 8.5v5M11.5 8.5v5" />
        </svg>
        Delete
      </button>
    </div>, document.body)}
  </div>;
}

/** Short age for the chat history. */
function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
