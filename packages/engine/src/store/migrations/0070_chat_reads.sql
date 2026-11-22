-- #338 Unread replies in chats: one row per direct chat. reply_seq: the seq of the agent's last final reply (the
-- message its run ended with); read_seq: the last message Master has seen. The chat is unread while reply_seq > read_seq.
-- Settings → Appearance's two switches are rows of `settings` (notify_replies, count_badge; missing = on).
CREATE TABLE chat_reads (
  card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  reply_seq INTEGER NOT NULL DEFAULT 0,
  read_seq INTEGER NOT NULL DEFAULT 0
);
