## Fixed · #325 · A review cut by a restart now finishes: its verdict moves the task again, and a builder who pushed a fix during a review can ask for a new one

### Details
- On 20 Nov (Atlas 0.78.0) the review of #314 stayed « running » for hours. The reviewer's run was cut when Atlas stopped (08:54 UTC), and after the restart (11:43 UTC) it went on as a new run. That run's `pr_validate` fail never reached the review step, which was still watching the old run. The step now follows the run that resumes the review.
- A review run that was cut and never resumes reaches the Inbox after 15 minutes with Atlas running. Retry on the task wakes the reviewer again.
- `task_request_review` now works while the task is In review, but only for the builder: it stops the open Review run and starts one on the new head. Anyone else (the reviewer) gets a refusal that says what to do.
- The merge step merges only the commit the reviewer approved. If a commit is pushed after an ok verdict, the merge is refused (« a commit was pushed after your review ») and the task goes back to the builder.
