## Changed · #238 · The review gate only reads CI: a repo's own rules (Atlas's changelog entry) run in that repo's CI, so a rule changed on main never needs an app update

- Atlas's CI job `test` checks the one-entry-per-PR rule on every pull request (`changelog.mjs check HEAD^1 --pr`).
- `pr_validate` and `scripts/pr/validate.mjs` keep only the generic gate: base = the repo's default branch, reviewed head unchanged, no conflict, required CI check green. The project option « changelog » is removed (migration 0053) and `--no-changelog` is gone.
- A red CI check is named and linked, in the refusal and in the note that sends the task back to its builder.
