-- Memory v2 (design §8, card #81): one row per memory instead of one text blob per agent.
-- scope: 'shared' or 'agent:<id>'. Text length (≤ 500) and the always-on budget are enforced by the engine on write;
-- rows migrated from v1 keep their text whole, even when longer.
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('rule', 'preference', 'fact', 'project')),
  scope TEXT NOT NULL CHECK (scope = 'shared' OR scope LIKE 'agent:%'),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  source_conversation_id TEXT,
  source_seq INTEGER,
  card_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'archived')),
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX memories_scope ON memories (scope, status);
CREATE INDEX memories_card ON memories (card_id) WHERE card_id IS NOT NULL;

-- Keyword index (external content: the text lives once, in memories), kept in sync by triggers.
CREATE VIRTUAL TABLE memories_fts USING fts5(text, content = 'memories', content_rowid = 'id', tokenize = 'porter unicode61');
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER memories_au AFTER UPDATE OF text ON memories BEGIN
  INSERT INTO memories_fts (memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memories_fts (rowid, text) VALUES (new.id, new.text);
END;

-- Every change, for the daily digest and undo. before_*: the row before the change (NULL for an add).
CREATE TABLE memory_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL REFERENCES memories (id),
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  action TEXT NOT NULL,
  before_text TEXT,
  before_kind TEXT,
  before_status TEXT,
  before_pinned INTEGER,
  undone_by INTEGER
);
CREATE INDEX memory_changes_at ON memory_changes (at);

-- v1 → v2: one rule per non-empty line, same scope, in order.
WITH RECURSIVE split (agent_id, updated_by, updated_at, line, rest, n) AS (
  SELECT agent_id, updated_by, updated_at, NULL, replace(text, char(13), '') || char(10), 0 FROM memory
  UNION ALL
  SELECT agent_id, updated_by, updated_at, substr(rest, 1, instr(rest, char(10)) - 1), substr(rest, instr(rest, char(10)) + 1), n + 1
  FROM split WHERE rest != ''
)
INSERT INTO memories (kind, scope, text, created_at, confirmed_at, updated_at, updated_by)
SELECT 'rule', CASE agent_id WHEN 'shared' THEN 'shared' ELSE 'agent:' || agent_id END,
  CASE WHEN trim(line) LIKE '- %' OR trim(line) LIKE '* %' THEN trim(substr(trim(line), 3)) ELSE trim(line) END,
  updated_at, updated_at, updated_at, updated_by
FROM split WHERE line IS NOT NULL AND trim(line) NOT IN ('', '-', '*') ORDER BY agent_id, n;

DROP TABLE memory;
