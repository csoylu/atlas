-- Several Anthropic accounts (API keys) tried in priority order (design §5). Keys stay in the keychain / env:
-- `secret` is only the name of the variable holding one.
CREATE TABLE accounts (
  id             TEXT PRIMARY KEY,
  provider       TEXT NOT NULL CHECK (provider IN ('anthropic')),
  label          TEXT NOT NULL,
  secret         TEXT NOT NULL,
  -- Lower first.
  priority       INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  -- Skipped until then after a rate limit, an exhausted quota or a refused key.
  cooldown_until TEXT,
  last_error     TEXT,
  last_used_at   TEXT,
  -- Last rate-limit headers seen (JSON), refreshed by every call.
  limits         TEXT,
  created_at     TEXT NOT NULL
);
CREATE TABLE account_usage (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  calls      INTEGER NOT NULL DEFAULT 0,
  input      INTEGER NOT NULL DEFAULT 0,
  output     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
-- Anthropic models on the default key now use the accounts (the engine adds that key as the first account).
UPDATE models SET credential_env = NULL WHERE provider = 'anthropic' AND credential_env = 'ANTHROPIC_API_KEY';
