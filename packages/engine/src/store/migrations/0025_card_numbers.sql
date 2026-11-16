-- Sequential card numbers (#1, #2, …, 12 Nov 2026). Board cards get a number, shown instead of the c_ id; the id stays
-- the primary key. Existing board cards (archived included) are numbered in creation order (created_at, then rowid).
-- Direct chats have none. card_counter holds the last number handed out, so a deleted card's number is never reused.
ALTER TABLE cards ADD COLUMN number INTEGER;
UPDATE cards SET number = (
  SELECT COUNT(*) FROM cards c2
  WHERE c2.board = 'main' AND (c2.created_at < cards.created_at OR (c2.created_at = cards.created_at AND c2.rowid <= cards.rowid))
) WHERE board = 'main';
CREATE UNIQUE INDEX cards_number ON cards(number) WHERE number IS NOT NULL;
CREATE TABLE card_counter (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  last INTEGER NOT NULL
);
INSERT INTO card_counter (id, last) SELECT 1, COALESCE(MAX(number), 0) FROM cards;
