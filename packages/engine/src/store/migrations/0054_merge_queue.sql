-- Merge queue per project (#236, design §7.1): the tasks In review of a project are reviewed and merged one at a time,
-- in the order they asked for review. Only the head of the queue gets a reviewer run; before it does, Atlas brings
-- its PRs up to date with main (automatic rebase, new migrations renumbered above main's).
-- review_queued_at: when the task entered the queue (task_request_review; again at the end after a send-back).
-- review_head_at:   when it became the head of its project's queue (null = not the head yet).
ALTER TABLE cards ADD COLUMN review_queued_at TEXT;
ALTER TABLE cards ADD COLUMN review_head_at TEXT;
-- synced_sha: the PR head Atlas checked or made up to date with main (null = check again: a new head, or main moved).
-- sync_error: why the last try to bring it up to date failed (a git or push error, not a conflict).
ALTER TABLE card_prs ADD COLUMN synced_sha TEXT;
ALTER TABLE card_prs ADD COLUMN sync_error TEXT;

-- Tasks already In review keep the order in which they asked.
UPDATE cards SET review_queued_at = COALESCE(
  (SELECT MAX(e.at) FROM card_events e WHERE e.card_id = cards.id AND e.kind = 'review_requested'),
  updated_at)
WHERE status = 'review';
