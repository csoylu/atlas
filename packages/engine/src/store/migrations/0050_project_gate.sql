-- PR validation gate per project (#216): the CI check required green before QA validates a PR (null = every check
-- run on the head green) and whether each PR must add exactly one CHANGELOG.md entry. Atlas keeps today's rules
-- (job « test », changelog on); any other project starts with « any check » and no changelog rule.
ALTER TABLE projects ADD COLUMN ci_job TEXT;
ALTER TABLE projects ADD COLUMN changelog INTEGER NOT NULL DEFAULT 0 CHECK (changelog IN (0, 1));
UPDATE projects SET ci_job = 'test', changelog = 1 WHERE repo = 'csoylu/atlas' COLLATE NOCASE;
