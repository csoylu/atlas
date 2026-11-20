-- Internet access per workspace (#298 §2, S3). A project's default level and allowed hosts; a member (a workspace)
-- can override both (NULL = the project's). Levels apply to agent commands in the sandbox and to web_fetch.
-- `allowed_hosts` is a JSON list of `host` or `*.suffix` rules. A member's own list replaces the project's (no merge).
ALTER TABLE projects ADD COLUMN network TEXT NOT NULL DEFAULT 'on' CHECK (network IN ('on', 'hosts', 'off'));
ALTER TABLE projects ADD COLUMN allowed_hosts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE project_members ADD COLUMN network TEXT CHECK (network IN ('on', 'hosts', 'off'));
ALTER TABLE project_members ADD COLUMN allowed_hosts TEXT;

-- Hosts the allow-list refused, per workspace: what Settings offers to « Allow ». One row per host, counted.
CREATE TABLE network_refusals (
  project_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  host       TEXT NOT NULL,
  count      INTEGER NOT NULL,
  last_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, agent_id, host)
);
