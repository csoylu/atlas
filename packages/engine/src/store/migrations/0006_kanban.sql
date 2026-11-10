-- Kanban flow (design §7, §16): parents, blocks, triage agent, per-agent slots, run kinds.
CREATE TABLE card_links (
  parent_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  child_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, child_id)
);
CREATE INDEX card_links_child ON card_links(child_id);

ALTER TABLE cards ADD COLUMN block_kind TEXT CHECK (block_kind IN ('needs_input', 'dependency', 'capability', 'transient'));
ALTER TABLE cards ADD COLUMN block_reason TEXT;
ALTER TABLE cards ADD COLUMN block_options TEXT; -- JSON array of suggested answers, recommended first
ALTER TABLE cards ADD COLUMN block_until TEXT;   -- transient blocks: when the dispatcher retries

ALTER TABLE agents ADD COLUMN max_runs INTEGER NOT NULL DEFAULT 1;

-- 'chat': answering Can; 'work': a ready card started by the dispatcher; 'triage': shaping a triage card.
ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'work', 'triage'));

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings (key, value) VALUES ('triage_agent', 'atlas');
