-- App updates from GitHub releases (#123, docs/updater.md). One row: what the last check found and where an install
-- stands, so a kill at any moment is recovered at the next start (updater.ts recover()): an interrupted download is
-- dropped (the installed app was never touched), an install handed to the helper is checked against the version
-- that actually started.
CREATE TABLE app_update (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  checked_at   TEXT,
  check_error  TEXT,
  -- JSON: the published releases newer than the running version, newest first ({version, notes, publishedAt, zip, sums})
  releases     TEXT NOT NULL DEFAULT '[]',
  phase        TEXT NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle', 'downloading', 'verifying', 'installing', 'failed')),
  target       TEXT,
  from_version TEXT,
  received     INTEGER NOT NULL DEFAULT 0,
  total        INTEGER,
  error        TEXT,
  phase_at     TEXT,
  -- the last update that installed: {from, to, at}
  last_update  TEXT
);
INSERT INTO app_update (id) VALUES (1);
