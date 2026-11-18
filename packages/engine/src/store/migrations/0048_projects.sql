-- Projects (#213, design §17): a repo the team works on, with its own tasks, chats, artifacts, workflows and memory.
-- Everything that exists becomes the project « Atlas » (repo csoylu/atlas): every agent is a member, its workspace
-- stays its own workdir (workspace null: agents.workdir stays the one setting, nothing is cloned or moved), and the
-- triage agent becomes the project's lead.

CREATE TABLE projects (
  id         TEXT PRIMARY KEY,                       -- a slug of the first name ('atlas'), never changes
  name       TEXT NOT NULL,
  repo       TEXT,                                   -- GitHub owner/name; fixed once set
  lead       TEXT REFERENCES agents(id),             -- gets the project's new tasks (triage); null = none set
  colour     INTEGER NOT NULL,                       -- hue 0-359 from PROJECT_HUES (shared)
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE UNIQUE INDEX projects_name ON projects(name COLLATE NOCASE);

CREATE TABLE project_members (
  project_id  TEXT NOT NULL REFERENCES projects(id),
  agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace   TEXT,                                  -- absolute path; null = the agent's own workdir (agents.workdir)
  clone_state TEXT NOT NULL DEFAULT 'pending' CHECK (clone_state IN ('pending', 'cloning', 'ready', 'failed')),
  clone_error TEXT,
  joined_at   TEXT NOT NULL,
  PRIMARY KEY (project_id, agent_id)
);

INSERT INTO projects (id, name, repo, lead, colour, created_at)
VALUES (
  'atlas', 'Atlas', 'csoylu/atlas',
  -- no triage agent set (or it's gone): none, as today
  (SELECT a.id FROM settings s JOIN agents a ON a.id = s.value WHERE s.key = 'triage_agent'),
  212, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
INSERT INTO project_members (project_id, agent_id, workspace, clone_state, joined_at)
SELECT 'atlas', id, NULL, 'ready', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM agents;
-- The lead is the project's triage agent now: one source of truth.
DELETE FROM settings WHERE key = 'triage_agent';

-- The project of everything else. Nullable columns (SQLite can't add a REFERENCES column with a default); the engine
-- always sets them on cards, documents and folders; workflows and memories may stay null (= global).
ALTER TABLE cards ADD COLUMN project_id TEXT REFERENCES projects(id);
UPDATE cards SET project_id = 'atlas';
CREATE INDEX cards_project ON cards(project_id, status);

ALTER TABLE documents ADD COLUMN project_id TEXT REFERENCES projects(id);
UPDATE documents SET project_id = 'atlas';

ALTER TABLE folders ADD COLUMN project_id TEXT REFERENCES projects(id);
UPDATE folders SET project_id = 'atlas';
-- Folder names are unique within a project, not across them.
DROP INDEX folders_name;
CREATE UNIQUE INDEX folders_name ON folders(project_id, name COLLATE NOCASE);

ALTER TABLE workflows ADD COLUMN project_id TEXT REFERENCES projects(id);
UPDATE workflows SET project_id = 'atlas';

ALTER TABLE memories ADD COLUMN project_id TEXT REFERENCES projects(id);
UPDATE memories SET project_id = 'atlas';
