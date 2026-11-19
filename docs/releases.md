# Releases, changelog and the review flow

Moved out of `CLAUDE.md` (#295) so it is read when needed, not sent with every model request. CLAUDE.md points here.

Also see `docs/updater.md`.

## Releases (#123)
- **One push to main = one changelog entry = one release; one file per PR** (#223). Each PR adds exactly one new file
  `changelog/<task>-<slug>.md` (lower case, the task's number first) whose first line is
  `## Fixed|Added|Changed|Breaking · #task · One plain sentence for Master` (the same task as the file name), then
  optional details (`###` for sub-headings: a second `## ` line is refused). It changes no other changelog file: an
  existing entry is never edited, and `changelog/history.md` (the frozen entries from before #223, the former
  CHANGELOG.md) never changes. Two PRs never touch the same file, so the changelog never conflicts. The order of the
  entries is the order their files reached main in git history (`git log --first-parent`); the version is computed
  from 0.3.0 through history.md then the files in that order (`node scripts/release/changelog.mjs version`; Fixed →
  patch, Added/Changed → minor, Breaking → major; needs the full history, not a shallow clone): never type a number.
  `changelog.mjs full` prints the whole changelog with each version, generated, never committed. CI
  (`.github/workflows/ci.yml`) checks the rule on every pull request (first step of the job `test`: `changelog.mjs
  check HEAD^1 --pr` on GitHub's merge commit, #238), refuses a push to main that does not add exactly one entry file or changes another,
  runs the tests, builds the Mac app (arm64 + x64 zip and dmg, SHA256SUMS.txt), tags `v<version>` and publishes the
  GitHub release with that entry as its notes and the full changelog as `CHANGELOG.md`. No release when tests fail.
- **Every change reaches main through a pull request** (Master, 18 Nov 2026): no direct push to main, for anyone, docs
  included. Work goes to a branch (`<type>/<task number>-<slug>`), then a PR whose base is main (check a stacked PR's
  base before merging). One merged PR = one push to main = one changelog entry = one release. main refuses
  force-pushes and deletion (GitHub branch protection).
- **A PR merges only once zurich (QA) has validated it** (#141). GitHub cannot make an account approve its own PR (all
  agents are csoylu), so the validation is the commit status `qa/validated` on the PR's head; main requires it and the CI
  job `test`, so a new commit needs a new validation. **Flow (#189): the task carries its PR.** Push the branch, open
  the PR, then end your run with `task_request_review({summary, prs: ["https://github.com/csoylu/atlas/pull/N"]})`
  (not `task_complete`, which is refused while a linked PR is open). The task goes **In review** (waiting for QA, not
  for Master: no Inbox item) and Atlas reads the PR from GitHub every minute (`gh api`, Master's gh login). **The review
  is a workflow (#263):** every project with a repo has a default « Review » workflow (Workflows, marked « default »;
  « Reset to default » restores its steps and layout): a task asks for review → CI finished on the PR (at most 2 h; a
  project with no CI job whose PR has no check goes on at once) → CI green, no conflict? → Review the PR, **in the same
  task thread**, by the project's review agent (Settings → Projects → the project → Review agent: zurich), or the
  project's lead on that agent's own PRs → Validate + merge → Task → Done. Timed out, no, changes asked and refused all
  go to « Back to the builder ». No separate "Validate PR #N" task. The reviewer reads the diff and
  checks it (code: tests, the feature in a build, screenshots for UI; docs only: read it), then gives its verdict with
  the engine's **`pr_validate` tool** (#216: `{pr, verdict: "ok", sha: <head>, merge: false, reason: "what was
  checked"}`, the workflow's next step merges; or `{pr, verdict: "fail", reason: "why, for the builder"}`), offered
  only to the task's reviewer while it is In review. A review that ends without a verdict runs once more, then the step
  « couldn't run » (Retry on the task). Master's terminal, always open whatever the workflow does:
  `node scripts/pr/validate.mjs <pr> --ok --sha <head> --as master "…" --merge` (same gate, same code); a merge outside
  the workflow stops its run and the task goes Done. A project whose Review workflow is off or deleted: each task In
  review says « No Review workflow is on in <project> » with Turn it on and Validate by hand, and Master gets one Inbox
  item. **ui-check in a review (#240):** none for an engine-only or docs-only PR; for a UI PR,
  `--only` on the screens the diff can affect at all four widths (the builder names them in the `task_request_review`
  summary, otherwise the reviewer derives them from the diff); a full run only for a change to something shared by every
  screen (list in the ui-check section), with the reason said in the verdict. Never two runs at once (`pgrep -fl
  check.mjs`). The verdict says which screens were checked and which were not: a narrowed run is never reported as a full
  one. Builders: name the affected screens in the summary. **Merged → Done**; **CI red, a conflict, a timeout, changes
  asked or a refused merge → Ready** for the builder, with the reason as a note in the thread; the builder fixes, pushes and calls
  `task_request_review` again. Blocked only ever means "needs Master". When GitHub can't be read (gh logged out,
  offline) nothing moves; the card says why. The gate (`pr_validate` and the script, same code) refuses a base other
  than the repo's default branch, a head that moved, a conflict (the builder rebases) and a required CI check that is
  not green, naming the red check and linking it. **A repo's own rules are checks of that repo, run by its CI on the
  PR, never code in the gate** (#238): an installed engine reads only CI, so a rule changed on main (the changelog
  entry format, say) applies at once, without updating the app. A new repo rule = a step in the repo's CI (Atlas: in
  the job `test`). When CI is red, the builder's note names the failing check and links its log. `--list` shows the PRs still waiting. Master can validate from a terminal too
  (`--as master`). The gate guards against accidents, not misuse: `--as` is a name anyone can type.
- **Other projects (#216).** The same flow works for any project with a GitHub repo (Datinel: datinel/datinel). The gate
  comes from the task's project: `repo` and `ciJob` (the check that must be green; empty = every check run on the head
  green: success, neutral or skipped; no check at all passes). Atlas: csoylu/atlas, `test`. A new project: no CI job. Set it with
  `PATCH /api/projects/:id {"ciJob": "…"}`. Nothing in the gate is Atlas-specific: a project's rules live in its CI.
  `task_request_review` refuses a PR of another repo than the task's project's (and a project without a repo). Each
  project gets its own Review workflow when it gets a repo. The review agent must be a member of the project (it
  reviews in its workspace for that project); unset, disabled or not a member, the review step « couldn't run » and
  says where to fix it (Settings → Projects), never another agent. Every task In review gets its own Review run,
  independently of the others (#249 removed #236's merge queue). Atlas's CI also refuses
  a PR whose new migration is not numbered above every one on main (`node scripts/pr/migrations.mjs check HEAD^1 HEAD`):
  main moved, renumber yours above and rebase. On the GitHub side Master
  sets, per repo, branch protection on main: required status `qa/validated`, plus the required CI check if there is one
  (agents never change a repo's settings).
- **Done means on main** (#126, #189): a task with a PR ends with `task_request_review` and becomes Done when the PR
  merges, by itself. One PR per task where the project has a Review workflow (#263: one run, one verdict, one merge):
  work that needs two PRs is two tasks. A task with no code (mockup, audit, report)
  finishes with `task_complete` as usual.
- **Agents never install the app.** No `install:mac`: Master's Atlas shows "Update available" and installs on
  Master's click (it restarts; running tasks resume). `install:mac` stays for a manual build from source.

## CI and merging how-tos
- Your entry is your own file, `changelog/<task>-<slug>.md`: never edit another one or `changelog/history.md` (a fix
  to an old entry fails: add a new file). Two entries in one PR fail too, so one PR per task (a second PR for the
  same task needs another slug and its own entry). A conflict with main is in code, never in the changelog: fetch,
  rebase, push, then `task_request_review` again with the new head.
- `changelog.mjs version|full` read git history: in a shallow clone they refuse (`git fetch --unshallow`). A file
  not committed yet counts as the newest entry.
- Before merging, check the PR's base (`gh pr view N --json baseRefName`); after, `git merge-base --is-ancestor <commit> origin/main`.
- A push to main runs test, changelog, mac (arm64, x64), windows, release; about 8 min from merge to release. In windows
  jobs, commands with `-c.x=y` flags need `shell: bash` (PowerShell splits them).
- Direct API calls atlas uses for Master: `PATCH /api/cards/:id {"status":"archived"}` (a direct chat accepts only
  that), `DELETE /api/cards/:id` (removes the task, its thread and messages for good: only when Master asks),
  `PATCH /api/agents/:id {"modelId":"…"}` (verify in `model_usage`).
