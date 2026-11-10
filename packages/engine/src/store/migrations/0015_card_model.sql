-- Per chat/card model and effort, chosen above the composer (Can, 10 Nov 2026). NULL = the agent's model / the
-- model's default effort. No foreign key: a deleted model makes the next run fail with that reason (fail loudly).
ALTER TABLE cards ADD COLUMN model_id TEXT;
ALTER TABLE cards ADD COLUMN effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
