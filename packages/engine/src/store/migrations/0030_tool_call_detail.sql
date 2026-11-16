-- Chat activity, files & shell (#63): what a file tool did, for the chat's detail views and never sent to the model.
-- JSON (shared ToolCallDetail): edit_file → the lines where each replacement landed; write_file → created or rewrote,
-- with the previous text so a rewrite shows as a diff.
ALTER TABLE tool_calls ADD COLUMN detail TEXT;
