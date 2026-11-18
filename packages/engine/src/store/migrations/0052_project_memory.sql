-- atlas: foreign_keys off
-- Memory and secrets per project (#215, design §17). 0048 put every memory in project « Atlas »: agent memories are
-- that agent in Atlas, shared ones are Atlas's. A new scope `global` (the user's own rules and preferences, every
-- project) has project_id NULL; none is made here: the lead moves the user's general preferences there by hand
-- (PATCH /api/memories/:id {"scope": "global"}). Secrets keep their project (NULL = global, as before).
--
-- memories is rebuilt (SQLite can't alter a CHECK): scope may be 'global', and a memory has a project unless it is
-- global. Same ids, so memory_changes, memory_proposals and the external-content FTS index stay valid.

-- A memory without a project could only be global; there are none yet: put any stray one in the first project.
UPDATE memories SET project_id = (SELECT id FROM projects ORDER BY created_at, rowid LIMIT 1) WHERE project_id IS NULL;

CREATE TABLE memories_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('rule', 'preference', 'fact', 'project')),
  scope TEXT NOT NULL CHECK (scope = 'global' OR scope = 'shared' OR scope LIKE 'agent:%'),
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  source_conversation_id TEXT,
  source_seq INTEGER,
  card_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'archived')),
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  CHECK ((scope = 'global') = (project_id IS NULL))
);
INSERT INTO memories_new (id, kind, scope, text, source_conversation_id, source_seq, card_id, status, pinned, created_at, confirmed_at, updated_at, updated_by, project_id)
SELECT id, kind, scope, text, source_conversation_id, source_seq, card_id, status, pinned, created_at, confirmed_at, updated_at, updated_by, project_id FROM memories;
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;
CREATE INDEX memories_scope ON memories (scope, status);
CREATE INDEX memories_card ON memories (card_id) WHERE card_id IS NOT NULL;
CREATE INDEX memories_project ON memories (project_id, scope, status);
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

-- The project before a change, for undo of a move between projects or to global.
ALTER TABLE memory_changes ADD COLUMN before_project_id TEXT;
UPDATE memory_changes SET before_project_id = (SELECT m.project_id FROM memories m WHERE m.id = memory_changes.memory_id)
WHERE before_scope IS NOT NULL;
