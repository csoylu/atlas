CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'card', 'schedule')),
  summary TEXT,
  summary_upto_seq INTEGER
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  board TEXT NOT NULL DEFAULT 'main',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('triage','todo','ready','running','blocked','review','done','archived')),
  assignee TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX cards_status ON cards(status);

CREATE TABLE card_events (
  id INTEGER PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX card_events_card ON card_events(card_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
