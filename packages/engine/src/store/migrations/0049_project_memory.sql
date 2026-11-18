-- Memory and secrets per project (#215, design §17). 0048 put every memory in project « Atlas »: agent memories are
-- that agent in Atlas, shared ones are Atlas's. A new scope `global` (the user's own rules and preferences, every
-- project) has project_id NULL; none is made here: the lead moves the user's general preferences there by hand
-- (PATCH /api/memories/:id {"scope": "global"}). Secrets keep their project (NULL = global, as before).

-- The project before a change, for undo and for « what changed that this run can see ».
ALTER TABLE memory_changes ADD COLUMN before_project_id TEXT;
UPDATE memory_changes SET before_project_id = (SELECT m.project_id FROM memories m WHERE m.id = memory_changes.memory_id)
WHERE before_scope IS NOT NULL;

-- A memory without a project can only be global; there are none yet, but make it so.
UPDATE memories SET project_id = (SELECT id FROM projects ORDER BY created_at, rowid LIMIT 1)
WHERE project_id IS NULL AND scope != 'global';

CREATE INDEX memories_project ON memories(project_id, scope, status);
