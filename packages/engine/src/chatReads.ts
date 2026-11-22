import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { NotFoundError, type Kanban } from './kanban.ts';

/** The first lines of a reply, for its desktop notification. */
const PREVIEW_MAX = 200;

/**
 * Unread replies in direct chats (#338). One row per chat in `chat_reads`: `reply_seq` is the agent's last final
 * reply (the message its run ended with: tool steps, streaming text and task notes never count), `read_seq` the last
 * message Master has seen. Unread while reply_seq > read_seq. A window tells the engine which chat it has on screen
 * while focused (`view`, over its WebSocket): that chat is read on arrival and on leaving, and a reply in it is read at
 * once, so it never turns unread. Who is viewing lives in memory (it is the open sockets'); the read state in SQLite.
 */
export class ChatReads {
  /** Open windows (their socket) → the chat each has on screen and focused. */
  private viewers = new Map<object, string>();

  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
  ) {}

  /** A window's chat on screen and focused changed (null: none, or Atlas in the background; also when it closes). */
  view(who: object, chatId: string | null): void {
    const prev = this.viewers.get(who) ?? null;
    if (prev === chatId) return;
    if (chatId) this.viewers.set(who, chatId);
    else this.viewers.delete(who);
    // What was on screen until now has been seen; the chat now on screen is read as it arrives.
    for (const id of [prev, chatId]) if (id && this.exists(id)) this.read(id);
  }

  viewed(chatId: string): boolean {
    for (const id of this.viewers.values()) if (id === chatId) return true;
    return false;
  }

  /** « Mark as read » (and a chat seen on screen): read up to its last message. */
  read(chatId: string): void {
    const card = this.kanban.get(chatId);
    if (card.board !== 'direct') throw new NotFoundError(`${chatId} is not a chat`);
    if (this.db.transaction(() => this.readTx(card.id, card.conversationId))()) this.kanban.emit(card.id);
  }

  /** « Mark all as read »: every chat (not archived) with an unread reply. */
  readAll(): void {
    const rows = this.db
      .prepare("SELECT c.id, c.conversation_id FROM cards c JOIN chat_reads r ON r.card_id = c.id WHERE c.board = 'direct' AND c.status != 'archived' AND r.reply_seq > r.read_seq")
      .all() as { id: string; conversation_id: string }[];
    const changed = this.db.transaction(() => rows.filter((r) => this.readTx(r.id, r.conversation_id)))();
    for (const r of changed) this.kanban.emit(r.id);
  }

  /**
   * A run ended (inside its transaction): if it was a direct chat's run and its last message is the agent's reply,
   * that is a final reply. Read at once when a window has the chat on screen; else unread. Returns the event to send
   * after the commit (the desktop notification), or null.
   */
  replied(cardId: string, agentId: string): { type: 'chat.replied'; chatId: string; agentId: string; projectId: string; seq: number; text: string } | null {
    const card = this.db.prepare("SELECT id, conversation_id, project_id FROM cards WHERE id = ? AND board = 'direct' AND status != 'archived'").get(cardId) as
      | { id: string; conversation_id: string; project_id: string }
      | undefined;
    if (!card) return null;
    const last = this.db
      .prepare('SELECT seq, role, author, content FROM messages WHERE conversation_id = ? AND rewind_id IS NULL ORDER BY seq DESC LIMIT 1')
      .get(card.conversation_id) as { seq: number; role: string; author: string; content: string } | undefined;
    if (!last || last.role !== 'assistant' || last.author !== agentId) return null;
    const text = (JSON.parse(last.content) as { type: string; text?: string }[])
      .flatMap((b) => (b.type === 'text' && b.text?.trim() ? [b.text.trim()] : []))
      .join('\n');
    if (!text) return null;
    const viewed = this.viewed(card.id);
    this.db
      .prepare(
        `INSERT INTO chat_reads (card_id, reply_seq, read_seq) VALUES (?, ?, ?)
         ON CONFLICT(card_id) DO UPDATE SET reply_seq = MAX(reply_seq, excluded.reply_seq), read_seq = MAX(read_seq, excluded.read_seq)`,
      )
      .run(card.id, last.seq, viewed ? last.seq : 0);
    if (viewed) return null;
    return { type: 'chat.replied', chatId: card.id, agentId, projectId: card.project_id, seq: last.seq, text: preview(text) };
  }

  /** Chats with an unread reply, in active projects (the sidebar's chats): the Dock count. */
  unreadCount(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM chat_reads r JOIN cards c ON c.id = r.card_id
            WHERE r.reply_seq > r.read_seq AND c.board = 'direct' AND c.status != 'archived'
              AND c.project_id IN (SELECT id FROM projects WHERE status = 'active')`,
        )
        .get() as { n: number }
    ).n;
  }

  emit(event: ReturnType<ChatReads['replied']>): void {
    if (event) this.bus.emit(event);
  }

  private exists(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM cards WHERE id = ? AND board = 'direct'").get(id);
  }

  /** read_seq up to the chat's last message; true if the chat was unread or moved on (an event is due). */
  private readTx(cardId: string, conversationId: string): boolean {
    const { last } = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS last FROM messages WHERE conversation_id = ?').get(conversationId) as { last: number };
    const r = this.db
      .prepare(
        `INSERT INTO chat_reads (card_id, reply_seq, read_seq) VALUES (?, 0, ?)
         ON CONFLICT(card_id) DO UPDATE SET read_seq = excluded.read_seq WHERE read_seq < excluded.read_seq`,
      )
      .run(cardId, last);
    return r.changes > 0;
  }
}

/** The first lines of a reply, up to PREVIEW_MAX characters. */
export function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_MAX ? flat.slice(0, PREVIEW_MAX - 1).trimEnd() + '…' : flat;
}
