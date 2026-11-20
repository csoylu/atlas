-- Files open in a chat's pane (#303, the workbench's Files tab), beside panel_tabs (artifacts). The tab shown is the
-- one focused last, over both tables. `path` is relative to the chat's agent workspace in the chat's project.
CREATE TABLE panel_files (
  chat_id    TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  opened_by  TEXT NOT NULL,
  opened_at  TEXT NOT NULL,
  focused_at TEXT NOT NULL,
  line       INTEGER,
  PRIMARY KEY (chat_id, path)
);
