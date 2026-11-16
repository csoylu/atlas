-- Rewind only restores what its own chat changed (card #68, 14 Nov 2026). A rewind used to put the whole shared workdir
-- back to a snapshot, wiping other cards' work done meanwhile. Now every file a card's tool call changed is logged here,
-- with its state before and after (a blob in the hidden git store + its git mode; sha NULL = the file did not exist).
-- write_file/edit_file: the file they wrote. shell (foreground): the files that differ between snapshots taken right
-- before and right after the command. error: the change could not be tracked (a snapshot failed); path is then NULL.
-- rewind_id: the rewind that put this change back (NULL = in effect). A rewind restores each path to its state before
-- the chat's first change after the target message, and refuses (lists a conflict) when the file is not as the chat
-- left it, or another card changed it too.
CREATE TABLE file_changes (
  id          INTEGER PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  workdir     TEXT NOT NULL,
  path        TEXT,
  before_sha  TEXT,
  before_mode TEXT,
  after_sha   TEXT,
  after_mode  TEXT,
  error       TEXT,
  tool        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT NOT NULL,
  rewind_id   TEXT
);
CREATE INDEX file_changes_card ON file_changes(card_id, started_at);
CREATE INDEX file_changes_path ON file_changes(workdir, path, ended_at);

-- The file operations a rewind made (JSON: [{workdir, path, from, to}], from/to = {sha, mode} or null): Undo replays
-- them backwards. NULL on rewinds made before this migration (their Undo no longer touches files).
ALTER TABLE rewinds ADD COLUMN ops TEXT;
