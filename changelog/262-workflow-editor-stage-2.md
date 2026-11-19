## Added · #262 · The workflow editor has panels for every new step (Action, Wait, Condition on fields, Agent step in the task thread), an Add step menu that also opens when you drag from an exit, an approval banner above a workflow that waits for your OK, and Retry or Follow on a step that couldn't run.
- Add step lists each kind with its exits. The new step goes to the right of the selected step, on its first free exit. Drag an exit's dot onto empty canvas and the same menu opens there, with a ghost step already wired.
- Action: set the task status or the assignee, validate and merge the PR, notify you, or run a command (needs your OK). Its panel lists every exit that leads to it.
- Condition on fields: tests on the task's, PR's and earlier steps' fields, and « try on run N » before saving. Wait: the event and a time limit.
- An agent step can work in the task thread and be « the project's review agent » (the lead reviews that agent's own PRs).
- A workflow with a command an agent wrote shows exactly what you approve: the command, the checkout, the secrets, the payload variables and the time limit. Approve or reject from the phone too.
- In a run, a step that couldn't run is red with « Couldn't run · retrying ». Its panel has Retry now and Follow the negative exit, and the task links to the run.
- Selecting a step lights the edges into it and dims the others. Exits are named on the nodes and on edges that go back.
