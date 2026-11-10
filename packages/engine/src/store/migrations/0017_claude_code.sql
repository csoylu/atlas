-- atlas: foreign_keys off
-- Official Claude Code subscription adapter. Credentials remain owned by the CLI.
CREATE TABLE models_new (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai_compat', 'chatgpt', 'claude_code')),
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

