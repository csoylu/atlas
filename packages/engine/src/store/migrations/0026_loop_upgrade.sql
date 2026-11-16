-- Loop upgrade (card #31, 12 Nov 2026).
-- last_input_tokens / last_input_upto: the provider-reported prompt size of the conversation's last model turn and the
-- seq of the last message it included. The compaction decision uses it (+ an estimate of the messages added since);
-- cleared whenever the view changes (summary, prune). NULL = no real reading: estimate with chars/4.
-- prune_upto_seq: messages up to this seq are seen pruned (big tool outputs/inputs replaced by stubs). The transcript
-- itself never changes.
-- todos: the agent's todo list (todo_write), a JSON array of {content, status}.
ALTER TABLE conversations ADD COLUMN last_input_tokens INTEGER;
ALTER TABLE conversations ADD COLUMN last_input_upto INTEGER;
ALTER TABLE conversations ADD COLUMN prune_upto_seq INTEGER;
ALTER TABLE conversations ADD COLUMN todos TEXT;
