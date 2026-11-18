-- One workspace and one main chat per agent per project (#214, design §17).
-- The main chat moves from agents to project_members: the default project's members keep exactly their chat (same id,
-- same history); another project's main chat is created on first use.
-- `home` = the member works in the agent's own workdir (agents.workdir or data/workspaces/<agent>): the first
-- project's members, as before projects. Another project's workspace is a clone in data/workspaces/<agent>/<project>.
ALTER TABLE project_members ADD COLUMN home INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_members ADD COLUMN main_chat TEXT;
UPDATE project_members SET home = 1, main_chat = (SELECT a.main_chat FROM agents a WHERE a.id = project_members.agent_id)
WHERE project_id = (SELECT id FROM projects WHERE status = 'active' ORDER BY created_at, rowid LIMIT 1);
ALTER TABLE agents DROP COLUMN main_chat;

-- A removed member's workspace stays on disk until Master deletes it (never automatic). `home` = the agent's own
-- workdir (agents.workdir, the first project's workspace): never deleted from here.
CREATE TABLE kept_workspaces (
  project_id TEXT NOT NULL REFERENCES projects(id),
  agent_id   TEXT NOT NULL,
  path       TEXT NOT NULL,
  home       INTEGER NOT NULL DEFAULT 0,
  kept_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, agent_id)
);

-- An agent's artifacts are files of one of its workspaces: the same path may exist in two projects.
DROP INDEX documents_file;
CREATE UNIQUE INDEX documents_file ON documents(agent_id, project_id, path);
