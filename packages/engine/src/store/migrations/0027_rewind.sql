-- Rewind (card #34, 12 Nov 2026). Stop/Esc during a run, or « Rewind to here » on a user message, hides that message
-- and everything after it and restores the agent's workdir files from the snapshot taken before the message.
--
-- messages.rewind_id: the rewind that hid the message (NULL = visible). Rewound messages are never deleted: the
-- transcript stays append-only; they are left out of the model's view and the chat, history_search marks them.
ALTER TABLE messages ADD COLUMN rewind_id TEXT;

-- A snapshot of the agent's workdir (a commit in the hidden git store, data dir /checkpoints) taken right before a user
-- message was stored, with the card's state at that moment (returned to on a rewind). commit_sha NULL: the snapshot
-- failed (error says why) or was pruned.
CREATE TABLE checkpoints (
  id          INTEGER PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  workdir     TEXT,
  commit_sha  TEXT,
  error       TEXT,
  card_status TEXT NOT NULL,
  card_block  TEXT,
  todos       TEXT,
  at          TEXT NOT NULL,
  UNIQUE (card_id, seq)
);

-- One rewind. state: 'restoring' (messages hidden, files being restored: finished at the next start if the engine died),
-- 'done', 'undoing' (messages back, files being put back), 'undone'. before_commit: the workdir right before the rewind
-- (Undo restores it). card_before: the card's status, block and todo list before the rewind, as JSON.
CREATE TABLE rewinds (
  id            TEXT PRIMARY KEY,
  card_id       TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  from_seq      INTEGER NOT NULL,
  upto_seq      INTEGER NOT NULL,
  workdir       TEXT,
  target_commit TEXT,
  before_commit TEXT,
  files         TEXT,
  files_error   TEXT,
  card_before   TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('restoring', 'done', 'undoing', 'undone')),
  at            TEXT NOT NULL,
  undone_at     TEXT
);
CREATE INDEX rewinds_card ON rewinds(card_id);
CREATE INDEX rewinds_pending ON rewinds(state) WHERE state IN ('restoring', 'undoing');
