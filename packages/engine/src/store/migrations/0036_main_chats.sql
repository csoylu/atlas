-- v3: one main chat per agent (the direct chat the sidebar and voice open); other direct chats are its History.
ALTER TABLE agents ADD COLUMN main_chat TEXT;
