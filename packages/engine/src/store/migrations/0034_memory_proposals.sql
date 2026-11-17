-- Weekly memory cleanup (#83): an agent's proposals, each approved or rejected by the user in the Inbox.
-- memory_ids: JSON array. merge: the first gets text (kind/scope), the others are archived.
CREATE TABLE memory_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('merge', 'update', 'archive')),
  memory_ids TEXT NOT NULL,
  text TEXT,
  kind TEXT CHECK (kind IS NULL OR kind IN ('rule', 'preference', 'fact', 'project')),
  scope TEXT CHECK (scope IS NULL OR scope = 'shared' OR scope LIKE 'agent:%'),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX memory_proposals_card ON memory_proposals (card_id);
CREATE INDEX memory_proposals_status ON memory_proposals (status);

-- A proposal can move a memory to another scope: undo puts it back.
ALTER TABLE memory_changes ADD COLUMN before_scope TEXT;
