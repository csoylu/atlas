-- /clear in a chat composer (card #99, 17 Nov 2026). The agent forgets every message with seq <= upto_seq: the model's
-- view starts after it (runner.transcript), with no summary and no todo list. Nothing is deleted: the chat folds those
-- messages behind a « Context cleared » row, history_search still finds them.
--
-- before: the conversation's summary, summary_upto_seq, prune_upto_seq and todos right before the clear, as JSON (Undo,
-- until the next message, puts them back). state: 'done' (in effect) or 'undone'. rewind_id: a rewind to a message
-- before the clear took it away too (its undo brings it back), like the messages it hid.
CREATE TABLE context_clears (
  id        TEXT PRIMARY KEY,
  card_id   TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  upto_seq  INTEGER NOT NULL,
  before    TEXT NOT NULL,
  state     TEXT NOT NULL CHECK (state IN ('done', 'undone')),
  rewind_id TEXT,
  at        TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX context_clears_card ON context_clears(card_id);
