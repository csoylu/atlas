-- The merge queue of #236 (migration 0054) is removed (#249, Master: GitHub's merge queue was meant, not one built
-- into Atlas). Every task In review gets its reviewer run as soon as its CI is green again; its columns go.
ALTER TABLE cards DROP COLUMN review_queued_at;
ALTER TABLE cards DROP COLUMN review_head_at;
ALTER TABLE card_prs DROP COLUMN synced_sha;
ALTER TABLE card_prs DROP COLUMN sync_error;
