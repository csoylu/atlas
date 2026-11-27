-- The agent's default effort (#380), used when a chat or task has effort on Auto (cards.effort NULL).
-- NULL = no effort sent, the model's own default.
ALTER TABLE agents ADD COLUMN effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'xhigh', 'max'));
