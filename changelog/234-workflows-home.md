## Changed · #234 · The Workflows page is easier to read: workflows are grouped On, Off and Past, each row shows its trigger in plain words, its last 10 runs and its next run, and an empty page offers three examples to start from

- Header: « 2 on · 1 off · 1 past » instead of « 1 on of 2 ».
- One-off workflows that already ran move to a folded « Past » group, with no Run now and no switch.
- A row: name, trigger in words (« Every Monday at 09:00 », « By hand »), the steps' agents; a strip of the last 10 runs, the last run's state and task, a Review button when a run waits for you; the next run; ▶ Run now and the on/off switch. Click the row to open the workflow. « from Schedules » is gone.
- No workflow yet: Morning report, Weekly check and Task with your OK create a ready-to-edit workflow (time ones start off).
- API: a workflow has `recentRuns`, the states of its last 10 runs.
