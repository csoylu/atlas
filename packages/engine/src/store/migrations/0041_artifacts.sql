-- atlas: foreign_keys off
-- Artifacts (#120, design §16): canvases, nodes and whiteboards are gone. Every artifact is a file in an agent's
-- workspace (markdown, html, svg, or a .url link), versioned as before, in flat Library folders (folder_id NULL =
-- Unfiled; deleting a folder moves its artifacts to Unfiled).
--
-- The canvases and canvas_versions tables stay as an archive: on start, Documents.convertCanvases() writes each
-- canvas once as an html page (pages/canvases/…) in its author's workspace, in the « Canvases » folder; from_canvas
-- remembers which canvas a page came from so it is converted only once.
CREATE TABLE folders (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX folders_name ON folders(name COLLATE NOCASE);

-- Whiteboard documents go (their canvases become pages instead), with their versions and panel tabs.
DELETE FROM panel_tabs WHERE doc_id IN (SELECT id FROM documents WHERE kind = 'whiteboard');
DELETE FROM document_versions WHERE doc_id IN (SELECT id FROM documents WHERE kind = 'whiteboard');
DELETE FROM documents WHERE kind = 'whiteboard';

CREATE TABLE documents_new (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  path        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('markdown', 'html', 'diagram', 'url')),
  title       TEXT NOT NULL,
  card_id     TEXT REFERENCES cards(id) ON DELETE SET NULL,
  version     INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  file_stamp  TEXT,
  pinned_at   TEXT,
  chat_id     TEXT REFERENCES cards(id) ON DELETE SET NULL,
  folder_id   TEXT REFERENCES folders(id) ON DELETE SET NULL,
  -- The name given by artifact_create (links have no title in their content).
  name        TEXT,
  from_canvas TEXT
);
INSERT INTO documents_new (id, agent_id, path, kind, title, card_id, version, updated_by, updated_at, file_stamp, pinned_at, chat_id)
  SELECT id, agent_id, path, kind, title, card_id, version, updated_by, updated_at, file_stamp, pinned_at, chat_id FROM documents;
DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;
CREATE UNIQUE INDEX documents_file ON documents(agent_id, path);
CREATE INDEX documents_card ON documents(card_id);
CREATE INDEX documents_folder ON documents(folder_id);
CREATE UNIQUE INDEX documents_from_canvas ON documents(from_canvas) WHERE from_canvas IS NOT NULL;
