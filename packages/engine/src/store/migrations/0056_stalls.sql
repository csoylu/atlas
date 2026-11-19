-- Stalls made visible (#237, design §7.2).
-- status_since: since when the card is in its current status. Set by the triggers below in the same statement (so the
-- same transaction) as every status change, whatever code path makes it.
ALTER TABLE cards ADD COLUMN status_since TEXT;

-- Backfill: the last recorded change to the current status, else updated_at.
UPDATE cards SET status_since = COALESCE(
  (SELECT MAX(e.at) FROM card_events e WHERE e.card_id = cards.id
     AND ((e.kind = 'status' AND json_extract(e.payload, '$.to') = cards.status) OR (e.kind = 'blocked' AND cards.status = 'blocked'))),
  updated_at);

CREATE TRIGGER cards_status_since_insert AFTER INSERT ON cards WHEN NEW.status_since IS NULL BEGIN
  UPDATE cards SET status_since = NEW.created_at WHERE id = NEW.id;
END;
CREATE TRIGGER cards_status_since_update AFTER UPDATE OF status ON cards WHEN NEW.status IS NOT OLD.status BEGIN
  UPDATE cards SET status_since = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- A task stuck in its state with nothing moving it (stalls.ts): at most one row per task, for its current reason.
-- rule: which rule matched (review, running, ready, todo); reason: plain words for the card and the Inbox;
-- action: what the Inbox offers (retry_review, restart, ready, open); notification_id: its Inbox item (archived when the
-- row goes); lead_noted_at: when the project lead got its note (once per row).
CREATE TABLE card_stalls (
  card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  reason TEXT NOT NULL,
  action TEXT NOT NULL,
  since TEXT NOT NULL,
  notification_id INTEGER,
  lead_noted_at TEXT
);
