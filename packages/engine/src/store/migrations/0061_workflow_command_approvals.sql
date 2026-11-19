-- atlas: foreign_keys off
-- Workflows v2, stage 2b (#273, design §9 and §10b): « Run a command » steps and Master's approval of them.
--
-- One row per command step Master approved: `digest` = sha256 of {command, secrets (sorted), limitMin, project, repo},
-- exactly what the approval banner shows. A step is approved while its row's digest matches its current config: an
-- agent's edit writes no row, so a changed step needs approving again; Master's own save writes the rows. Only the
-- HTTP routes (Master) write here, never an agent tool.
CREATE TABLE workflow_command_approvals (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  digest      TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  PRIMARY KEY (workflow_id, node_id)
);

-- The Inbox item asking Master to approve a workflow's command steps (notifications.id): one at a time, archived when
-- Master approves or rejects. NULL: none open.
ALTER TABLE workflows ADD COLUMN approval_note INTEGER;
-- A step that couldn't run and is not retried by itself (#273: Atlas stopped while its command ran, it may have run
-- in part): only Retry now or Follow « other exit » move it on.
ALTER TABLE workflow_run_steps ADD COLUMN manual_retry INTEGER NOT NULL DEFAULT 0;
