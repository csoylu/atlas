-- Workflows v2, stage 3 (#263, design §9): review is the default « Review » workflow of every project with a repo.
--
-- projects.review_agent: the agent that reviews the project's PRs (Settings → Projects), replacing the global
-- Board & triage setting; the lead reviews that agent's own PRs. Copied from the global setting into every project
-- the agent is a member of (a non-member could not review there: it has no workspace of the project).
-- projects.review_seeded: the project's Review workflow was made once (at the engine start after this update, or when
-- the project gets a repo). A Review workflow Master deletes is not made again by itself (« Turn it on » does).
ALTER TABLE projects ADD COLUMN review_agent TEXT;
ALTER TABLE projects ADD COLUMN review_seeded INTEGER NOT NULL DEFAULT 0;

UPDATE projects SET review_agent = (SELECT value FROM settings WHERE key = 'review_agent')
 WHERE EXISTS (
   SELECT 1 FROM project_members m
    WHERE m.project_id = projects.id AND m.agent_id = (SELECT value FROM settings WHERE key = 'review_agent' AND value != '')
 );

DELETE FROM settings WHERE key = 'review_agent';
