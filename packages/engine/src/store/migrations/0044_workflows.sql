-- Workflows (#170, design §9) replace schedules: a trigger (time or manual) wired to agent steps, approvals and
-- conditions. Every schedule becomes a workflow « trigger → one agent step » with origin 'schedules', keeping its id
-- (so schedule_delete, rewinds and the memory cleanup still find it), prompt, cron or date, time zone, task mode,
-- on/off, next and last run, last error and its task. Then the schedules table goes.

CREATE TABLE workflows (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  origin        TEXT,                       -- 'schedules' when migrated from a schedule
  revision      INTEGER NOT NULL DEFAULT 1, -- bumped by every graph save; a stale save is refused
  next_run_at   TEXT,                       -- next time-trigger firing (null: manual, off, or a fired one-shot)
  last_fired_at TEXT,
  last_error    TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX workflows_due ON workflows(enabled, next_run_at);

-- kind: trigger | agent | approval | condition. config: JSON (shared WorkflowNode). own_card_id: an agent step's task
-- kept across runs (« one task, keeps history »): runtime state, not part of the graph or its revision.
CREATE TABLE workflow_nodes (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('trigger', 'agent', 'approval', 'condition')),
  x           REAL NOT NULL DEFAULT 0,
  y           REAL NOT NULL DEFAULT 0,
  config      TEXT NOT NULL,
  own_card_id TEXT,
  PRIMARY KEY (workflow_id, id)
);

-- One edge per exit of a node.
CREATE TABLE workflow_edges (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  from_node   TEXT NOT NULL,
  exit        TEXT NOT NULL,
  to_node     TEXT NOT NULL,
  PRIMARY KEY (workflow_id, from_node, exit)
);

CREATE TABLE workflow_runs (
  id          TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'done', 'failed', 'stopped', 'skipped')),
  trigger     TEXT NOT NULL CHECK (trigger IN ('time', 'manual')),
  reason      TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);
CREATE INDEX workflow_runs_by_workflow ON workflow_runs(workflow_id, number);
CREATE INDEX workflow_runs_open ON workflow_runs(state);

CREATE TABLE workflow_run_steps (
  id         INTEGER PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  round      INTEGER NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('running', 'waiting', 'done', 'failed', 'stopped')),
  exit       TEXT,
  card_id    TEXT,
  summary    TEXT,
  started_at TEXT NOT NULL,
  ended_at   TEXT
);
CREATE INDEX workflow_run_steps_run ON workflow_run_steps(run_id, id);
CREATE INDEX workflow_run_steps_card ON workflow_run_steps(card_id);

INSERT INTO workflows (id, name, enabled, origin, revision, next_run_at, last_fired_at, last_error, created_by, created_at, updated_at)
  SELECT id, title, enabled, 'schedules', 1, next_run_at, last_fired_at, last_error, created_by, created_at, updated_at FROM schedules;

INSERT INTO workflow_nodes (workflow_id, id, kind, x, y, config)
  SELECT id, 'trigger', 'trigger', 40, 120,
         json_object('kind', 'time', 'repeat', kind, 'cron', cron, 'at', at, 'timezone', timezone)
  FROM schedules;

INSERT INTO workflow_nodes (workflow_id, id, kind, x, y, config, own_card_id)
  SELECT id, 'step1', 'agent', 300, 120,
         json_object('title', title, 'agentId', agent_id, 'prompt', prompt,
                     'newTaskEachRun', CASE create_card WHEN 1 THEN json('true') ELSE json('false') END),
         chat_card_id
  FROM schedules;

INSERT INTO workflow_edges (workflow_id, from_node, exit, to_node) SELECT id, 'trigger', 'start', 'step1' FROM schedules;

-- The last firing becomes run 1, done, with the task it posted on.
INSERT INTO workflow_runs (id, workflow_id, number, state, trigger, reason, started_at, ended_at)
  SELECT 'wr_' || id, id, 1, 'done', 'time', 'ran as a schedule, before workflows', last_fired_at, last_fired_at
  FROM schedules WHERE last_fired_at IS NOT NULL;
INSERT INTO workflow_run_steps (run_id, node_id, kind, round, state, exit, card_id, summary, started_at, ended_at)
  SELECT 'wr_' || id, 'step1', 'agent', 1, 'done', 'done', last_card_id, NULL, last_fired_at, last_fired_at
  FROM schedules WHERE last_fired_at IS NOT NULL;

DROP TABLE schedules;
