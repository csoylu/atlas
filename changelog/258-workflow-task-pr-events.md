## Added · #258 · Workflows can now start when a task or a pull request changes (created, status, assignee, review, blocked, done; opened, CI, conflict, validated, merged), and a step can use the task's and PR's fields.
- Task and PR triggers with filters (status, assignee, from-status; PR repo, base, result). A project's workflow sees only its project's tasks, a global one every project's. The editor for them comes in the next stage; today's Workflows screens show them as « When a task is done » and so on.
- Each event fires a workflow once, even if Atlas is killed at that instant: the event is stored with the change that caused it.
- `{{task.title}}`, `{{pr.url}}`, `{{project.name}}`, `{{event.from}}`, `{{steps.<id>.summary}}`… in a step's prompt; an unknown field fails the step and says which.
- Loop guard: a workflow that runs more than 5 times in an hour on the same task or PR (a number per workflow), or whose runs keep feeding each other, turns itself off and tells you in the Inbox.
- Run now can take a task or a PR as its subject; the API lists the workflows acting on a task with their current step.
