-- What a chat's tool calls did outside the chat and its files (card #138): tasks created or changed, messages to other
-- agents or tasks, memories, schedules, canvases, git pushes. A rewind lists those of the part it hides: it takes back
-- what it can (closes a task nobody started, withdraws a message nobody read, archives a new memory, turns off a new
-- schedule) and lists the rest as kept. One row per thing done, written by the runner right after the tool call.
--
-- kind: task | task_change | message | memory | memory_change | schedule | schedule_delete | canvas | push.
-- ref: the thing's id (card, message, memory, schedule, canvas). label: how it is named. data: JSON (message: {toCard,
-- agentMessage}). rewind_id: the rewind that hid the part it was done in (cleared by its undo).
CREATE TABLE side_effects (
  id        INTEGER PRIMARY KEY,
  card_id   TEXT NOT NULL,
  at        TEXT NOT NULL,
  kind      TEXT NOT NULL,
  ref       TEXT,
  label     TEXT NOT NULL,
  data      TEXT,
  rewind_id TEXT
);
CREATE INDEX side_effects_card ON side_effects(card_id, at);

-- What the rewind did with each side effect, as JSON (the list shown, and what Undo puts back).
ALTER TABLE rewinds ADD COLUMN effects TEXT;
