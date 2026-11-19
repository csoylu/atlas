-- atlas: foreign_keys off
-- Workflows v2, stage 1 (#258, design §9): task and pull request events start workflows.
--
-- workflow_events: a task or PR event, written in the same transaction as the change that caused it (only while an
-- enabled workflow listens to that kind), and deleted in the same transaction as the runs it started: consumed once,
-- whatever the instant of a kill. No foreign key: an event outlives the deletion of its task.
CREATE TABLE workflow_events (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('task', 'pr')),
  name       TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  project_id TEXT NOT NULL,
  pr_url     TEXT,
  data       TEXT NOT NULL -- JSON: by, from, to, the task's status and assignee then, the PR's fields
);

-- workflow_runs: trigger task | pr, the run's subject (a task, and for a PR run its url), the event that started it,
-- and its context (JSON: what the run knows, the fields a step's text can use).
CREATE TABLE workflow_runs_new (
  id           TEXT PRIMARY KEY,
  workflow_id  TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  number       INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'done', 'failed', 'stopped', 'skipped')),
  trigger      TEXT NOT NULL CHECK (trigger IN ('time', 'manual', 'task', 'pr')),
  reason       TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  subject_card TEXT,
  subject_pr   TEXT,
  event        TEXT,
  context      TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO workflow_runs_new (id, workflow_id, number, state, trigger, reason, started_at, ended_at)
  SELECT id, workflow_id, number, state, trigger, reason, started_at, ended_at FROM workflow_runs;
DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_new RENAME TO workflow_runs;
CREATE INDEX workflow_runs_by_workflow ON workflow_runs(workflow_id, number);
CREATE INDEX workflow_runs_open ON workflow_runs(state);
CREATE INDEX workflow_runs_subject ON workflow_runs(subject_card);
