## Fixed · #231 · A blocked task whose pull request was merged now goes to Done by itself and leaves « Needs you »

The pull request watcher read only tasks In review. When a reviewer blocked a task to ask you something and the PR was
then merged another way (main's `validate.mjs --merge` from a terminal), the task stayed blocked in « Needs you » even
though nothing was left to decide (#226). The watcher now also reads blocked tasks with linked PRs: once none is open
and one is merged, the task goes to Done with « PR #N merged into main (sha) », as from review. Anything else (PR still
open, red CI, closed unmerged) leaves the question to you.
