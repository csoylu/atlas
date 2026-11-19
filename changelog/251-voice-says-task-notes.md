## Fixed · #251 · When you talk to Atlas by voice, a task that finishes, closes or needs you is said out loud again, once, after the current reply

Since #143 a task note no longer wakes the agent, so no reply run said it and the voice stayed silent (the slow
voice test « #52: a card report during a spoken turn… » failed every time). The voice now says the note itself, as
one short sentence (« Task 12 is closed: Fix login. »), queued behind what it is saying; the summary stays in the chat.
