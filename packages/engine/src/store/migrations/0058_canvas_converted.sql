-- Canvas conversion happens once per canvas (#253). Until now Documents.convertCanvases() picked every canvas with no
-- document (from_canvas), so a converted page deleted from the Library came back at the next start of the app.
-- converted_at is the marker instead: set in the same transaction as the page, never cleared, whatever happens to the
-- page afterwards.
ALTER TABLE canvases ADD COLUMN converted_at TEXT;

-- Databases where the conversion already ran (a converted page, or the « Canvases » folder it creates, is there):
-- every canvas is marked. A canvas without its page there was converted, then its page was deleted, and stays deleted.
-- A database coming straight from before #120 has neither: its canvases are converted at the next start, as before.
UPDATE canvases SET converted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE EXISTS (SELECT 1 FROM documents WHERE from_canvas IS NOT NULL)
     OR EXISTS (SELECT 1 FROM folders WHERE name = 'Canvases' COLLATE NOCASE);
