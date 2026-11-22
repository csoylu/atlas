-- atlas: foreign_keys off
-- Gemini plan (design §5): Gemini models on Can's Google subscription through the Antigravity quota. A new provider
-- value, so the models table is rebuilt (SQLite can't change a CHECK); agents keep their model_id.
CREATE TABLE models_new (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai_compat', 'chatgpt', 'claude_plan', 'gemini_plan', 'claude_code')),
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

-- The one Google account signed in on this machine. Tokens live in the keychain (GEMINI_TOKENS), never here.
CREATE TABLE gemini_account (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  -- The OAuth client the stored tokens belong to: a changed client means signing in again.
  client_id    TEXT,
  email        TEXT,
  -- Cloud Code project the quota is billed to (loadCodeAssist / onboardUser).
  project      TEXT,
  expires_at   TEXT,
  signed_in_at TEXT,
  -- Rate or usage limit: no new requests before this time (Resume clears it).
  paused_until TEXT,
  last_error   TEXT
);
