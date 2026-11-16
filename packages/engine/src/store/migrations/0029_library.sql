-- Library (design §16, Linear direction): every document in one list. Pinned documents sit on top; chat_id is the
-- direct chat a document was first opened in (the Library's « chat » filter; a card's documents also count for the
-- chat the card came from).
ALTER TABLE documents ADD COLUMN pinned_at TEXT;
ALTER TABLE documents ADD COLUMN chat_id TEXT REFERENCES cards(id) ON DELETE SET NULL;
UPDATE documents SET chat_id = (SELECT t.chat_id FROM panel_tabs t WHERE t.doc_id = documents.id ORDER BY t.opened_at LIMIT 1);
