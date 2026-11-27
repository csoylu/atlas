## Changed · #376 · Agents keep their prompt cache for an hour instead of 5 minutes, the context summary reuses that cache, and it starts at 80 % of the window instead of 70 %.

- Every cache breakpoint of an agent turn (Anthropic and the Claude plan) now lives an hour, so a turn after a long
  wait (you answer later, a task waits) reads its history from the cache instead of paying it again.
- The summary call sends the turn's own prompt plus one instruction, so the conversation is read from the cache; a
  view too big for that is summarized from its text as before.
- Compaction starts at 80 % of the window, less when the model's answer or the summary would not fit after it.
- Settings → Usage shows the tokens written to the cache under « From cache ».
