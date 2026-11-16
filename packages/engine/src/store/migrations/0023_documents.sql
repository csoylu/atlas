-- Documents and the side panel (12 Nov 2026, design §16). A document is a file in an agent's workspace (docs/*.md,
-- pages/*.html, diagrams/*.svg) or a canvas shown as a whiteboard. Atlas indexes it, keeps its last 50 versions and
-- shows it in the panel beside a chat. panel_tabs is each chat's open tabs (agents open and close them).
CREATE TABLE documents (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  path       TEXT,
  canvas_id  TEXT REFERENCES canvases(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('markdown', 'html', 'diagram', 'whiteboard')),
  title      TEXT NOT NULL,
  card_id    TEXT REFERENCES cards(id) ON DELETE SET NULL,
  version    INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- File stat at the last index, so a re-sync reads only files that changed.
  file_stamp TEXT,
  CHECK ((path IS NULL) <> (canvas_id IS NULL))
);
CREATE UNIQUE INDEX documents_file ON documents(agent_id, path) WHERE path IS NOT NULL;
CREATE UNIQUE INDEX documents_canvas ON documents(canvas_id) WHERE canvas_id IS NOT NULL;
CREATE INDEX documents_card ON documents(card_id);

CREATE TABLE document_versions (
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (doc_id, version)
);

CREATE TABLE panel_tabs (
  chat_id      TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  opened_by    TEXT NOT NULL,
  opened_at    TEXT NOT NULL,
  -- The tab shown: the one focused last.
  focused_at   TEXT NOT NULL,
  section      TEXT,
  seen_version INTEGER NOT NULL,
  PRIMARY KEY (chat_id, doc_id)
);
