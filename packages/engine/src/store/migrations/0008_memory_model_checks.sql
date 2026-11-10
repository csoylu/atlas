-- Agent memory (design §8): small notes always in the system prompt. agent_id 'shared' = every agent.
CREATE TABLE memory (
  agent_id TEXT PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Model checks (design §5): result of the last test call, shown in Settings and on blocked cards.
ALTER TABLE models ADD COLUMN verified_at TEXT;
ALTER TABLE models ADD COLUMN last_error TEXT;
