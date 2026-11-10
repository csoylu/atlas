-- Schedules: user-defined recurring or one-shot tasks (design §5, §19).
CREATE TABLE IF NOT EXISTS schedules (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT    NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK(kind IN ('cron', 'at')),
  cron            TEXT,          -- only for 'cron'
  at              TEXT,          -- ISO timestamp, only for 'at'
  prompt          TEXT NOT NULL, -- sent to the agent as a card or direct message
  create_card     INTEGER NOT NULL DEFAULT 0, -- if 1, create a card; if 0, send prompt to agent
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  next_run_at     TEXT NOT NULL,
  last_run_id     TEXT,          -- id of the last run this schedule triggered
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT NOT NULL DEFAULT 'system',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_schedules_next ON schedules(next_run_at, enabled);
