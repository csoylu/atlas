## Changed · #334 · Who reviews a project's pull requests is now the agent you choose in its Review workflow, not a project setting.

- Settings → Projects → Review agent and the « reviewer » badges are gone. An agent step has one Agent picker and a new « Verdict on the PR » switch: on, its agent gets pr_validate and the exits are approved / changes asked. Any agent step, in any workflow, can have it.
- The default Review workflow has nine steps: « Built by another agent? » sends the reviewer's own PRs to a second review step, « Review the reviewer's PR », run by another agent.
- Nothing changes on the day of the update: Atlas's « Review the PR » gets zurich, and the second step gets atlas, the lead, who reviewed zurich's PRs until now. Datinel's steps get its reviewer and lead the same way.
- A new project's Review workflow starts with no agent: an Inbox item, a bar on the workflow and a « no agent » chip on the step lead you to choose one. A task whose review step has no usable agent says « couldn't run » with Choose the agent and Retry.
- Who reviews is shown on the project's Workflows card (« PR verdicts ») and on the agent's page, read from the steps.
