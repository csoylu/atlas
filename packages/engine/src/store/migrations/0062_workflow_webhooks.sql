-- atlas: foreign_keys off
-- Workflows v2, stage 1 (#260, design §9): the webhook trigger.
--
-- workflow_hooks: a webhook trigger's secret URL (/hook/<token>). The token itself is in the secret store (the
-- keychain, or the server's secrets.enc) under `secret` (`hook:<…>`), like every credential (rule 5); here only its
-- sha256, to find the workflow of a call. seen_port (desktop): the engine port of the URL Master last saw (made,
-- copied) or a caller used; another port today means the old URL gets no answer. last_*: the last call with a valid
-- token (a wrong token leaves no trace): ran / skipped / refused, why, its run, its body (cut).
CREATE TABLE workflow_hooks (
  workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  secret      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  seen_port   INTEGER,
  last_at     TEXT,
  last_result TEXT CHECK (last_result IN ('ran', 'skipped', 'refused')),
  last_reason TEXT,
  last_run    TEXT,
  last_body   TEXT
);

-- workflow_runs: trigger webhook (rebuilt for the CHECK; same columns as 0059).
CREATE TABLE workflow_runs_new (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'done', 'failed', 'stopped', 'skipped')),
  trigger      TEXT NOT NULL CHECK (trigger IN ('time', 'manual', 'task', 'pr', 'webhook')),
  reason       TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  subject_card TEXT,
  subject_pr   TEXT,
  event        TEXT,
  context      TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO workflow_runs_new (id, workflow_id, number, state, trigger, reason, started_at, ended_at, subject_card, subject_pr, event, context)
  SELECT id, workflow_id, number, state, trigger, reason, started_at, ended_at, subject_card, subject_pr, event, context FROM workflow_runs;
DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_new RENAME TO workflow_runs;
CREATE INDEX workflow_runs_by_workflow ON workflow_runs(workflow_id, number);
CREATE INDEX workflow_runs_open ON workflow_runs(state);
CREATE INDEX workflow_runs_subject ON workflow_runs(subject_card);
