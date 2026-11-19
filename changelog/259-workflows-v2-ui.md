## Added · #259 · Workflows can start on a task or pull request event, with filters, fields you insert into prompts, and runs that show what started them
### What changed
- New workflow is a dialog: pick how it starts (at set times, task event, pull request event, only by hand), the event, « Only if » filters (project fixed to the workflow's) and the loop guard.
- The canvas names every exit beside its dot, labels edges that go back, lights the selected step's incoming edges, and dashes the steps a run did not reach. On a phone: the ordered steps, view-only.
- « Insert a field » in prompts and questions lists the run's fields with the last run's values; fields show as chips.
- Runs show what started them (task or PR, linked) and « What the run knows » (Copy as JSON), with an All / Failed filter.
- The list shows each trigger with its icon and project, and a second line when a workflow needs you or the loop guard stopped it (Turn on again).
- A task lists the workflows acting on it, their current step and a link to the run. Event workflows get « Run on a task… » / « Run on a PR… ».
