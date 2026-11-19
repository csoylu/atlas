-- atlas: foreign_keys off
-- Workflows v2, stage 2 (#261, design §9): Action and Wait steps, and « couldn't run ».
--
-- workflow_nodes: two more kinds, action (no model: set status / assignee, validate + merge a PR, notify) and wait
-- (until an event, with a time limit). Rebuilt for the CHECK; nothing references it.
CREATE TABLE workflow_nodes_new (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  id          TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('trigger', 'agent', 'approval', 'condition', 'action', 'wait')),
  x           REAL NOT NULL DEFAULT 0,
  y           REAL NOT NULL DEFAULT 0,
  config      TEXT NOT NULL,
  own_card_id TEXT,
  PRIMARY KEY (workflow_id, id)
);
INSERT INTO workflow_nodes_new (rowid, workflow_id, id, kind, x, y, config, own_card_id)
  SELECT rowid, workflow_id, id, kind, x, y, config, own_card_id FROM workflow_nodes;
DROP TABLE workflow_nodes;
ALTER TABLE workflow_nodes_new RENAME TO workflow_nodes;

-- workflow_run_steps, per step:
--   deadline_at   a Wait's time limit (an instant: a restart past it takes « timed out »);
--   data          JSON the step needs to carry on after a kill (the PR a merge acts on and the head it pins);
--   couldnt       why the step couldn't run (no answer: gh logged out, agent missing…), NULL when it could;
--   couldnt_since since when, retry_at the next try (every minute), tries how many, notified_at the one Inbox item
--                 (after 15 min).
ALTER TABLE workflow_run_steps ADD COLUMN deadline_at TEXT;
ALTER TABLE workflow_run_steps ADD COLUMN data TEXT;
ALTER TABLE workflow_run_steps ADD COLUMN couldnt TEXT;
ALTER TABLE workflow_run_steps ADD COLUMN couldnt_since TEXT;
ALTER TABLE workflow_run_steps ADD COLUMN retry_at TEXT;
ALTER TABLE workflow_run_steps ADD COLUMN tries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workflow_run_steps ADD COLUMN notified_at TEXT;
