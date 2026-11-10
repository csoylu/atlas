-- atlas: foreign_keys off
-- ChatGPT plan (OpenAI's « Sign in with ChatGPT » for open-source, locally hosted apps, design §5): a third model
-- provider. SQLite can't change a CHECK constraint, so the models table is rebuilt; agents keep their model_id
-- (migrate() runs this with foreign keys off and checks every reference before committing).
CREATE TABLE models_new (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai_compat', 'chatgpt')),
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

-- The one ChatGPT account signed in on this machine (the terms forbid rotating accounts around limits). Tokens live
-- in the keychain (CHATGPT_TOKENS), never here. host_id is this machine's opaque ext_agent_host_id: made once, kept
-- across sign-outs. client_id is the registration OpenAI issued (oaiapp_…), reused for every later sign-in.
CREATE TABLE chatgpt_account (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  host_id      TEXT NOT NULL,
  client_id    TEXT,
  subject      TEXT,
  email        TEXT,
  -- Space-separated scopes granted; plan usage needs chatgpt.tokens.use.direct.
  scopes       TEXT,
  expires_at   TEXT,
  signed_in_at TEXT,
  -- Can's express consent for background use (board cards, schedules). Direct chats are his own activity.
  background   INTEGER NOT NULL DEFAULT 0,
  -- The one-time « You're using your ChatGPT plan » notice was dismissed.
  welcomed     INTEGER NOT NULL DEFAULT 0,
  -- Usage limit reached: no new requests until Can resumes (OpenAI gives no reset time).
  paused_at    TEXT,
  last_error   TEXT
);
