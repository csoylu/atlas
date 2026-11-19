## Added · #273 · Workflows can run a command you approve, in a clean checkout of the main branch, and an agent step can work in the task's own thread

- « Run a command »: a clean checkout of the project's default branch per step, only the secrets the step lists, run
  fields as env vars (never pasted into the command), 16 KB / 128 KB caps, a time limit that stops the whole process
  group, output with secret values hidden and the full log in `outputs/workflows/`. Exits « exit 0 » / « other exit ».
- An agent's new or edited command needs your approval (one Inbox item; `POST /api/workflows/:id/approve` or
  `/reject`); until then a firing is skipped. No agent tool can approve.
- A command cut off by an Atlas stop is never run again by itself: you get an Inbox item at once.
- Agent step « in the task thread »: done / not done; for a review, ok → approved, fail → changes asked with the reason.
