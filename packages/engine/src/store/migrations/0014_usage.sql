-- Every model call's token usage (Chat and Models pages). No foreign keys on purpose: totals outlive a deleted model,
-- chat or agent. input = the whole prompt (cached part included), cached = the part read from the provider's cache.
CREATE TABLE model_usage (
  id              INTEGER PRIMARY KEY,
  at              TEXT NOT NULL,
  model_id        TEXT NOT NULL,
  provider        TEXT NOT NULL,
  agent_id        TEXT,
  card_id         TEXT,
  conversation_id TEXT,
  -- 'turn' (an agent's answer) or 'summary' (context compaction).
  kind            TEXT NOT NULL,
  input           INTEGER NOT NULL DEFAULT 0,
  output          INTEGER NOT NULL DEFAULT 0,
  cached          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX model_usage_at ON model_usage(at);
CREATE INDEX model_usage_conv ON model_usage(conversation_id);
