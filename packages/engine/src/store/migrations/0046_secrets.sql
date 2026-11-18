-- Secrets (#206): metadata of the secrets in the secret store (OS keychain). Never a value: values live only in the
-- store. kind model_key = a key Atlas uses to call models (never given to agents); kind agent = a secret agents use in
-- shell commands as $NAME, given to nobody, some agents or all. Model keys already in the store get their rows at
-- engine start (the store is not reachable from SQL).
CREATE TABLE secrets (
  name          TEXT PRIMARY KEY,
  description   TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL CHECK (kind IN ('model_key', 'agent')),
  grant_to      TEXT NOT NULL DEFAULT 'none' CHECK (grant_to IN ('none', 'agents', 'all')),
  agents        TEXT NOT NULL DEFAULT '[]',     -- json array of agent ids, for grant_to = 'agents'
  project       TEXT,                           -- null = global; else the project that owns it (projects: not built yet)
  created_by    TEXT NOT NULL,                  -- 'user' or an agent id
  created_card  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  updated_by    TEXT NOT NULL,
  last_used_at  TEXT,
  last_used_by  TEXT,
  CHECK (kind = 'agent' OR grant_to = 'none')
);

-- How many secret values were replaced by [secret NAME] in a tool call's output.
ALTER TABLE tool_calls ADD COLUMN secrets_hidden INTEGER NOT NULL DEFAULT 0;
