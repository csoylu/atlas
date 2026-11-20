-- The browser tab in a chat's pane (#306): ordered with the pane's artifacts and files (opened_at), the one focused
-- last is shown (focused_at). `agent_used`: the agent has opened or driven this tab (the bar then offers Hand back
-- once Master has taken it; a page Master opened from a link and no agent touched shows no driver).
ALTER TABLE browser_tabs ADD COLUMN opened_at TEXT;
ALTER TABLE browser_tabs ADD COLUMN focused_at TEXT;
ALTER TABLE browser_tabs ADD COLUMN agent_used INTEGER NOT NULL DEFAULT 0;
UPDATE browser_tabs SET opened_at = updated_at, focused_at = updated_at, agent_used = (owner = 'agent');
