CREATE TABLE models (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai_compat')),
  name TEXT NOT NULL,
  base_url TEXT,
  credential_env TEXT,
  max_tokens INTEGER NOT NULL DEFAULT 16000
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  role_prompt TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL REFERENCES models(id),
  workdir TEXT,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'stopped', 'interrupted')),
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX runs_card ON runs(card_id);
CREATE INDEX runs_status ON runs(status);

CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_use_id TEXT NOT NULL,
  name TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
  output TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);

-- For assistant messages: highest message seq the model saw when producing it.
-- A user message posted while the model was answering is placed after that answer in the next context.
ALTER TABLE messages ADD COLUMN context_upto INTEGER;

INSERT INTO models (id, provider, name, base_url, credential_env) VALUES
  ('sonnet', 'anthropic', 'claude-sonnet-5-5', NULL, 'ANTHROPIC_API_KEY'),
  ('local', 'openai_compat', 'local', 'http://127.0.0.1:18434/v1', 'HARNESS_LOCAL_API_KEY');

INSERT INTO agents (id, role_prompt, model_id) VALUES
  ('atlas', 'You are atlas, the lead agent. You shape ideas into clear, small cards and get work done.', 'sonnet');
