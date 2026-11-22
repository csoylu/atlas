-- atlas: foreign_keys off
-- #341: the legacy Claude Code subscription provider (0017, removed in 0018) leaves the code. Its rows become Claude
-- plan rows: the same Claude subscription, through the supported OAuth client. Same id, so every agent pointing at one
-- keeps its model; base URL and key variable are cleared (Claude plan uses neither) and the model counts as untested.
-- Its usage history is kept and counted under Claude plan. The models table is rebuilt to drop the value from the CHECK.
UPDATE models SET provider = 'claude_plan', base_url = NULL, credential_env = NULL, verified_at = NULL, last_error = NULL
WHERE provider = 'claude_code';
UPDATE model_usage SET provider = 'claude_plan' WHERE provider = 'claude_code';

CREATE TABLE models_new (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai_compat', 'chatgpt', 'claude_plan')),
  name           TEXT NOT NULL,
  base_url       TEXT,
  credential_env TEXT,
  max_tokens     INTEGER NOT NULL DEFAULT 16000,
  verified_at    TEXT,
  last_error     TEXT,
  context_window INTEGER NOT NULL DEFAULT 200000
);
INSERT INTO models_new (id, provider, name, base_url, credential_env, max_tokens, verified_at, last_error, context_window)
  SELECT id, provider, name, base_url, credential_env, max_tokens, verified_at, last_error, context_window FROM models;
DROP TABLE models;
ALTER TABLE models_new RENAME TO models;
