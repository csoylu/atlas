import { useCallback, useEffect } from 'react';
import { AgentFace } from './AgentFace.tsx';
import type { Card } from '@atlas/shared';
import { CheckIcon, RowMenu, useRowMenu } from './RowMenu.tsx';

export function ChatHistory({ chats, selected, onSelect, onArchive, onDelete, onRead, onReadAll }: {
  chats: Card[];
  selected?: string;
  onSelect(id: string): void;
  onArchive(chat: Card): void;
  onDelete(chat: Card): void;
  /** « Mark as read », « Mark all as read » (#338). */
  onRead(chat: Card): void;
  onReadAll(): void;
}) {
  const menu = useRowMenu();
  const close = useCallback(() => menu.setAt(null), [menu.setAt]);
  const chat = menu.at && chats.find((c) => c.id === menu.at!.key);
  useEffect(() => {
    if (menu.at && !chat) close();
  }, [menu.at, chat, close]);

  return <div className="chat-history">
    {chats.map(c => <button key={c.id}
      className={'chat-hist-item' + (selected === c.id ? ' active' : '') + (c.working ? ' running' : '') + (c.unread ? ' unread' : '')}
      aria-current={selected === c.id ? 'page' : undefined}
      aria-busy={c.working || undefined}
      aria-controls={menu.at?.key === c.id ? 'chat-history-menu' : undefined}
      title={`${c.title} · @${c.assignee}${c.working ? ' · working…' : ''}${c.unread ? ' · unread reply' : ''} · Right-click or Shift+F10 for actions`}
      {...menu.bind(c.id)}
      onClick={() => { if (!menu.clicked()) return; close(); onSelect(c.id); }}>
      <AgentFace id={c.assignee} />
      <span className="chat-hist-title">{c.naming ? <span className="chat-naming">Generating chat name…</span> : c.title}</span>
      {c.unread && !c.working && <span className="unread-dot" aria-label="unread reply" />}
      <span className="chat-hist-when">{ago(c.updatedAt)}</span>
    </button>)}
    {menu.at && chat && <RowMenu at={menu.at} label={`Actions for ${chat.title}`} onClose={close} items={[
      { label: 'Mark as read', icon: <CheckIcon />, onClick: () => onRead(chat) },
      { label: 'Mark all as read', onClick: onReadAll },
      { label: 'Archive', danger: true, onClick: () => onArchive(chat), icon: <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 4.5h14v3H3zM4.5 7.5v8h11v-8M8 10.5h4" />
        </svg> },
      { label: 'Delete', danger: true, onClick: () => onDelete(chat), icon: <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3.5 5.5h13M8 3h4l1 2.5H7L8 3ZM5.5 5.5l.7 11h7.6l.7-11M8.5 8.5v5M11.5 8.5v5" />
        </svg> },
    ]} />}
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
