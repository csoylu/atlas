-- Effort 'none' = thinking off, for local models (Can, 11 Nov 2026). SQLite can't change a CHECK in place: a new
-- column with the wider check takes the values, then the name.
ALTER TABLE cards ADD COLUMN effort_new TEXT CHECK (effort_new IN ('none', 'low', 'medium', 'high', 'xhigh', 'max'));
UPDATE cards SET effort_new = effort;
ALTER TABLE cards DROP COLUMN effort;
ALTER TABLE cards RENAME COLUMN effort_new TO effort;
