-- Schedules, rebuilt for design §9 (0007 never advanced next_run_at and had no place for the schedule's card).
-- A firing either creates a new card (create_card = 1) or posts the prompt on the schedule's own card, reopened each
-- time, so the agent keeps the history between runs (chat_card_id). Rows are copied; none existed when this shipped.
CREATE TABLE schedules_v2 (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('cron', 'at')),
  cron          TEXT,
  at            TEXT,
  prompt        TEXT NOT NULL,
  create_card   INTEGER NOT NULL DEFAULT 0,
  timezone      TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  -- Next firing; NULL once a one-shot has fired.
  next_run_at   TEXT,
  last_fired_at TEXT,
  -- The card the last firing created or posted on.
  last_card_id  TEXT,
  -- create_card = 0: the card whose chat receives every prompt.
  chat_card_id  TEXT,
  -- Why the last firing failed (e.g. its agent was deleted); cleared by the next success.
  last_error    TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
INSERT INTO schedules_v2 (id, agent_id, title, kind, cron, at, prompt, create_card, timezone, enabled, next_run_at, created_by, created_at, updated_at)
  SELECT id, agent_id, substr(prompt, 1, 80), kind, cron, at, prompt, create_card, timezone, enabled, next_run_at, created_by, created_at, updated_at
  FROM schedules;
DROP TABLE schedules;
ALTER TABLE schedules_v2 RENAME TO schedules;
CREATE INDEX schedules_due ON schedules(enabled, next_run_at);
