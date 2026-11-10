-- atlas: foreign_keys off
-- Claude plan (design §5): Claude models on Can's plan through Atlas's own Anthropic-approved OAuth client. A new
-- provider value, so the models table is rebuilt (SQLite can't change a CHECK); agents keep their model_id.
CREATE TABLE models_new (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai_compat', 'chatgpt', 'claude_plan', 'claude_code')),
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

-- The one Claude account signed in on this machine. Tokens live in the keychain (CLAUDE_TOKENS), never here; the
-- client id and endpoints come from the engine env (ATLAS_CLAUDE_*), so they aren't stored here either.
CREATE TABLE claude_account (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  -- The client id the stored tokens belong to: a changed client id means signing in again.
  client_id    TEXT,
  email        TEXT,
  scopes       TEXT,
  expires_at   TEXT,
  signed_in_at TEXT,
  -- The one-time « You're using your Claude plan » notice was dismissed.
  welcomed     INTEGER NOT NULL DEFAULT 0,
  -- Rate or usage limit: no new requests before this time (Resume clears it).
  paused_until TEXT,
  last_error   TEXT
);
