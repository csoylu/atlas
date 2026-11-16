-- atlas: foreign_keys off
-- Card lifecycle from a chat (12 Nov 2026, design §16). A new status 'closed' (cancelled: nothing more is done) and
-- the direct chat a card was created from (origin_card), told when the card finishes, closes, stops or needs the user.
-- SQLite can't change a CHECK: the table is rebuilt. Effort keeps 'none' in its check (an installed build wrote it).
CREATE TABLE cards_new (
  id              TEXT PRIMARY KEY,
  board           TEXT NOT NULL DEFAULT 'main',
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL CHECK (status IN ('triage','todo','ready','running','blocked','review','done','closed','archived')),
  assignee        TEXT,
  priority        INTEGER NOT NULL DEFAULT 0,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  block_kind      TEXT CHECK (block_kind IN ('needs_input', 'dependency', 'capability', 'transient')),
  block_reason    TEXT,
  block_options   TEXT,
  block_until     TEXT,
  model_id        TEXT,
  effort          TEXT CHECK (effort IN ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
  origin_card     TEXT REFERENCES cards(id) ON DELETE SET NULL
);
INSERT INTO cards_new (id, board, title, body, status, assignee, priority, conversation_id, created_by, created_at, updated_at,
                       block_kind, block_reason, block_options, block_until, model_id, effort)
  SELECT id, board, title, body, status, assignee, priority, conversation_id, created_by, created_at, updated_at,
         block_kind, block_reason, block_options, block_until, model_id, effort FROM cards;
DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;
CREATE INDEX cards_status ON cards(status);
CREATE INDEX cards_origin ON cards(origin_card);

-- Report-back outbox: a row is written in the same transaction as the status change and the system message in the
-- origin chat; the dispatcher starts the chat run and marks it delivered once the chat's agent has answered.
CREATE TABLE card_reports (
  id           INTEGER PRIMARY KEY,
  chat_id      TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  card_id      TEXT NOT NULL,
  transition   TEXT NOT NULL CHECK (transition IN ('done', 'review', 'closed', 'stopped', 'needs_input', 'capability')),
  message_id   TEXT NOT NULL,
  at           TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX card_reports_pending ON card_reports(delivered_at);
