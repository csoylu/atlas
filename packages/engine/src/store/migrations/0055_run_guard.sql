-- Loop guard (#239): the counters of a run, so a run resumed after a restart goes on from them (never from zero),
-- and why the guard or the ceiling stopped it (NULL = it was not stopped by them).
ALTER TABLE runs ADD COLUMN turns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN repeat_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN repeat_key TEXT;
ALTER TABLE runs ADD COLUMN limit_reason TEXT;
