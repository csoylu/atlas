## Changed · #263 · Review is now the default « Review » workflow of every project with a repo, one you can see, edit, turn off and reset in Workflows.

- Seven steps: a task asks for review → CI finished on the PR (at most 2 h; no wait at all in a project with no CI job and a PR with no check) → CI green, no conflict? → Review the PR in the task thread → Validate + merge → Task → Done; every negative exit sends the task back to its builder with the reason.
- The reviewer is chosen per project (Settings → Projects → Review agent), copied from the old Board & triage setting; the project's lead reviews that agent's own PRs.
- A task In review whose project has no Review workflow on says so, with Turn it on and Validate by hand, and you get one Inbox item.
- Tasks already In review at the update get their Review run at once. `scripts/pr/validate.mjs --as master --merge` still works whatever the workflow does.
