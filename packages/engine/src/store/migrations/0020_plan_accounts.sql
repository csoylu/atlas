-- Several subscriptions per plan provider (design §5, 11 Nov 2026): Claude plan and ChatGPT plan accounts, each
-- with its own name, sign-in and keychain entry (`secret` = the entry's name; tokens never live here). Calls go to the
-- accounts in `position` order; one that reaches its usage limit is paused (until its reset, or until Resume when the
-- provider gives none) and the work moves to the next one.
CREATE TABLE plan_accounts (
  id           TEXT PRIMARY KEY,
  provider     TEXT NOT NULL CHECK (provider IN ('claude_plan', 'chatgpt')),
  label        TEXT NOT NULL,
  position     INTEGER NOT NULL,
  secret       TEXT NOT NULL UNIQUE,
  -- Claude: the OAuth client the tokens belong to. ChatGPT: this account's issued registration (oaiapp_…).
  client_id    TEXT,
  subject      TEXT,
  email        TEXT,
  scopes       TEXT,
  expires_at   TEXT,
  signed_in_at TEXT,
  last_used_at TEXT,
  -- Usage limit: paused since paused_at, until paused_until (NULL = until the user resumes).
  paused_at    TEXT,
  paused_until TEXT,
  last_error   TEXT,
  -- The plan's usage windows from the latest response (JSON PlanQuota), and the raw limit headers (for checking).
  quota        TEXT,
  quota_raw    TEXT,
  created_at   TEXT NOT NULL
);

-- The single sign-ins made so far become the first account of their provider: same keychain entry, no new sign-in.
INSERT INTO plan_accounts (id, provider, label, position, secret, client_id, email, scopes, expires_at, signed_in_at, paused_at, paused_until, last_error, created_at)
  SELECT 'pa_claude1', 'claude_plan', 'Main', 0, 'CLAUDE_TOKENS', client_id, email, scopes, expires_at, signed_in_at,
         CASE WHEN paused_until IS NOT NULL THEN COALESCE(signed_in_at, paused_until) END, paused_until, last_error,
         COALESCE(signed_in_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM claude_account WHERE client_id IS NOT NULL OR email IS NOT NULL;
INSERT INTO plan_accounts (id, provider, label, position, secret, client_id, subject, email, scopes, expires_at, signed_in_at, paused_at, last_error, created_at)
  SELECT 'pa_chatgpt1', 'chatgpt', 'Main', 0, 'CHATGPT_TOKENS', client_id, subject, email, scopes, expires_at, signed_in_at, paused_at, last_error,
         COALESCE(signed_in_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  FROM chatgpt_account WHERE client_id IS NOT NULL;

-- What stays per provider: the one-time welcome notices and this machine's ChatGPT host id.
INSERT OR REPLACE INTO settings (key, value) SELECT 'claude_welcomed', '1' FROM claude_account WHERE welcomed = 1;
INSERT OR REPLACE INTO settings (key, value) SELECT 'chatgpt_welcomed', '1' FROM chatgpt_account WHERE welcomed = 1;
INSERT OR REPLACE INTO settings (key, value) SELECT 'chatgpt_host_id', host_id FROM chatgpt_account;
DROP TABLE claude_account;
DROP TABLE chatgpt_account;

-- Which subscription served each call (the composer shows that one's quota).
ALTER TABLE model_usage ADD COLUMN account_id TEXT;

-- Things the user is told about (a subscription hit its limit and work moved on; every subscription is exhausted).
CREATE TABLE notifications (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  kind    TEXT NOT NULL,
  title   TEXT NOT NULL,
  body    TEXT NOT NULL,
  card_id TEXT,
  read_at TEXT
);
CREATE INDEX notifications_at ON notifications(at);
