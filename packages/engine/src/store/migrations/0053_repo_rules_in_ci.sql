-- A repo's own rules are checked by the repo's CI on the pull request, not by the engine's review gate (#238): the
-- project option « changelog » (0050, #216) goes; Atlas's one-entry-per-PR rule now runs in its CI job « test ».
-- A red CI is then where a builder learns what to fix: the PR keeps the name and link of its failing check.
ALTER TABLE projects DROP COLUMN changelog;
ALTER TABLE card_prs ADD COLUMN ci_failed_name TEXT;
ALTER TABLE card_prs ADD COLUMN ci_failed_url TEXT;
