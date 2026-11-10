-- Durability (design §6): a run is owned by one engine instance through a renewable lease.
ALTER TABLE runs ADD COLUMN owner TEXT;
ALTER TABLE runs ADD COLUMN lease_until TEXT;
-- Shell tools record their pid so an orphan left by a crash can be killed on restart.
ALTER TABLE tool_calls ADD COLUMN pid INTEGER;
