## Fixed · #274 · A tool call cut off at the model's output limit now says so, instead of telling the model to escape its quotes.

The model is told that nothing ran and to send a long file in parts (a first `write_file`, then `edit_file` appends, or
several files), and the task's row reads « Couldn't call write_file · cut off at the output limit ». The OpenAI-compatible
and ChatGPT providers now report a turn cut at the limit even when it holds tool calls (they said `tool_use` before).
