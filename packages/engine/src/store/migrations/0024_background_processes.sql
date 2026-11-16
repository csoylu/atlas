-- Background shell processes (shell with background: true, 12 Nov 2026). Output goes to log_path (the agent's outputs
-- folder in the data dir). owner + lease_until as for runs: a process whose engine died (lease expired) is killed and
-- marked 'lost' at the next start. read_offset = how far shell_output has read the log.
CREATE TABLE background_processes (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  command     TEXT NOT NULL,
  pid         INTEGER,
  log_path    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running', 'exited', 'killed', 'lost')),
  exit_code   INTEGER,
  signal      TEXT,
  read_offset INTEGER NOT NULL DEFAULT 0,
  owner       TEXT NOT NULL,
  lease_until TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);
CREATE INDEX background_processes_running ON background_processes(status) WHERE status = 'running';
