-- Canvas (design §11, §16): a board of nodes (drawing, html, url, markdown). One JSON document per canvas,
-- versioned; the last 50 versions are kept so an edit can be undone.
CREATE TABLE canvases (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nodes TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE canvas_versions (
  canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  nodes TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (canvas_id, version)
);
