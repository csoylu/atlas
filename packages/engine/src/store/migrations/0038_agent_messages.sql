-- agent_message (#96): one agent writes to another, even one with no task. Outbox written in the same transaction as
-- the message in the target's thread; the dispatcher wakes the target until it has answered (survives a restart),
-- posts the answer in the sender's conversation (replied_at) and wakes the sender until it has read it.
CREATE TABLE agent_messages (
  id                 INTEGER PRIMARY KEY,
  from_agent         TEXT NOT NULL,
  from_card          TEXT NOT NULL,
  to_agent           TEXT NOT NULL,
  to_card            TEXT NOT NULL,
  message_id         TEXT NOT NULL,
  seq                INTEGER NOT NULL,
  at                 TEXT NOT NULL,
  replied_at         TEXT,
  reply_seq          INTEGER,
  reply_delivered_at TEXT
);
CREATE INDEX agent_messages_open ON agent_messages(reply_delivered_at);
