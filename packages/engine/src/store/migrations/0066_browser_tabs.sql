-- The shared browser (#298 §3, S6): one tab per chat or task, reopened after a restart. `chat_id` is the chat's or
-- task's card id, or 'master' for Master's own pane (no workspace: project_id and agent_id NULL). The workspace
-- (project × agent) picks the browser profile and the internet level. `owner`: who has the input.
CREATE TABLE browser_tabs (
  chat_id    TEXT PRIMARY KEY,
  project_id TEXT,
  agent_id   TEXT,
  url        TEXT,
  title      TEXT NOT NULL DEFAULT '',
  owner      TEXT NOT NULL CHECK (owner IN ('agent', 'master')),
  updated_at TEXT NOT NULL,
  CHECK ((project_id IS NULL) = (agent_id IS NULL))
);
