-- Images attached to a task (#119): a JSON array of image blocks (path in <data>/task-images/, media type, size,
-- sha256). The bytes stay in the files, never in SQLite (design §10a).
ALTER TABLE cards ADD COLUMN images TEXT NOT NULL DEFAULT '[]';
