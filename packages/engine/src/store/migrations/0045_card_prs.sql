-- Tasks linked to their pull requests (#189). A task whose PR is open sits In review (status 'review', which now means
-- « waiting for QA », not « waiting for the user »); the engine reads each PR from GitHub (gh api, the user's own login:
-- no token here) and moves the task: merged → done, CI red / conflict / qa failed / closed unmerged → ready.
CREATE TABLE card_prs (
  card_id        TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  repo           TEXT NOT NULL,              -- owner/name
  number         INTEGER NOT NULL,
  url            TEXT NOT NULL,
  linked_at      TEXT NOT NULL,
  branch         TEXT,
  base           TEXT,
  head_sha       TEXT,
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'merged', 'closed')),
  merge_sha      TEXT,
  mergeable      INTEGER,                    -- 1 / 0 / NULL (GitHub still computing)
  ci             TEXT,                       -- pending | success | failure | NULL (no check run yet)
  qa             TEXT,                       -- qa/validated on the head: pending | success | failure | NULL
  qa_description TEXT,
  checked_at     TEXT,                       -- last successful read
  error          TEXT,                       -- last read failed: why
  error_since    TEXT,
  reviewed_sha   TEXT,                       -- head the reviewer was started on (once per head)
  failed_sha     TEXT,                       -- head a failure already sent back to the builder (once per head)
  PRIMARY KEY (card_id, repo, number)
);
CREATE INDEX card_prs_open ON card_prs(state);

-- Who checks the PRs while the task is In review.
ALTER TABLE cards ADD COLUMN reviewer TEXT;

-- The reviewing agent (Settings → Board & triage): zurich when this team has one (Atlas's own QA agent).
INSERT OR IGNORE INTO settings (key, value) SELECT 'review_agent', id FROM agents WHERE id = 'zurich';
