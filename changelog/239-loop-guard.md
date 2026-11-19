## Changed · #239 · A long task no longer pauses after 150 turns: it keeps going while it makes progress, and stops only when it repeats itself or reaches a 600-turn safety ceiling, asking the project's lead first

- Loop guard: the same tool call with the same result 5 times in a row, or 30 turns in a row where every tool call
  failed, stops the run with what repeated (« Stopped: `npm test` failed the same way 5 times in a row »).
- The stop goes to the project's lead in the task thread: it lets the agent continue, re-scopes the task, or blocks it
  for you with a real question. You are asked directly only when the stopped agent is the lead itself.
- In a direct chat the stop is a message in the chat; your reply resumes.
- The counters survive a restart: a loop doesn't start again from zero.
