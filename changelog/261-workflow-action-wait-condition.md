## Added · #261 · Workflows get three new steps that use no model: Action (change a task's status or assignee with a note, notify you, validate and merge the PR), Wait (for CI, a conflict, a merge or the task, with a time limit) and Condition on the task's, PR's and earlier steps' fields.
- Validate + merge uses the same gate as QA's pr_validate, on the commit CI and the review saw: it ends « merged » or « refused » with GitHub's reason.
- A Wait survives a restart: past its time limit, it takes « timed out » at once.
- A step that gets no answer (GitHub logged out, its agent deleted) is not a failure: the run waits, Atlas retries every minute and tells you once after 15 minutes, and the run offers Retry now or Follow the negative exit.
- Conditions can be tried on a past run before saving. The editor for all this comes in 5/6; « Run a command » in #273.
