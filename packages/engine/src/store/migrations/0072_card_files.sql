-- Files attached to a task that aren't pictures (#348): a JSON array of {path, bytes, media_type}, the files in
-- <data>/task-images/ beside the task's pictures. The bytes stay in the files, never in SQLite.
ALTER TABLE cards ADD COLUMN files TEXT NOT NULL DEFAULT '[]';
