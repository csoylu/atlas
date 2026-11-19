## Added · #237 · Every task shows how long it has been in its state, and a task stuck with nothing moving it is marked on its card, with the reason and one Inbox item to unstick it

- « In review · 2 h », « Running · 35 min », « Blocked · 1 d » on the board tile, at the end of a list row and next to the status in the task view (not for Triage, Done or Closed).
- Stuck: In review 45 min with CI green and no review running or verdict; Working 10 min with no run; Ready 30 min while the agent has a free slot; Todo 10 min after all its parents are done. Blocked is never stuck.
- The Inbox item offers the action that fits (Retry the review, Restart the run, Move to Ready, Open) and leaves by itself when the task moves. The project's lead is told once in its main chat.
- A review that ends twice without a verdict now uses the same mark and Inbox item.
