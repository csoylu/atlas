-- Cards moved to 'blocked' by hand before kanban.update gave them a block: give them one (the Inbox needs a reason).
UPDATE cards SET block_kind = 'needs_input', block_reason = 'Moved to blocked by you. Reply or move the card to continue.', block_options = '[]'
WHERE status = 'blocked' AND block_kind IS NULL;
