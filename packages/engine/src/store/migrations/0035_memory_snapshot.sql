-- v3 memory: the memory block a conversation's system prompt shows is frozen when it starts (the prompt cache stays
-- valid); later changes reach the agent as a note in the transcript. memory_seen: the last memory_changes id the
-- agent's view reflects. reviewed_upto_seq: the background memory review read the transcript up to here.
ALTER TABLE conversations ADD COLUMN memory_snapshot TEXT;
ALTER TABLE conversations ADD COLUMN memory_seen INTEGER;
ALTER TABLE conversations ADD COLUMN reviewed_upto_seq INTEGER;
