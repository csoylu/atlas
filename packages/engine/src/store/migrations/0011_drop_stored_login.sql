-- Server login moved to the ATLAS_PASSWORD env var (design §12; secrets never in SQLite, CLAUDE.md rule 5).
-- Remove what the first version stored: a password hash and an unused on/off flag.
DELETE FROM settings WHERE key IN ('server_password_hash', 'server_login_enabled');
