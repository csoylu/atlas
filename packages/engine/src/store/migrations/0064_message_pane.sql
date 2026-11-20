-- #305 « What the agent sees »: the pane tab open when Master sent the message (JSON PaneSees), null = closed or left out.
ALTER TABLE messages ADD COLUMN pane TEXT;
