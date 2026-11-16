-- Inbox (design §16, Linear direction): an update the user archived leaves the list (the row stays, for history).
ALTER TABLE notifications ADD COLUMN archived_at TEXT;
CREATE INDEX notifications_card ON notifications(card_id);
