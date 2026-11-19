## Fixed · #247 · The shell environment test no longer depends on your git config or on the agent shell it runs in

### Details
- `shellEnv.test.ts` « a git commit made with it carries the agent name and the configured email » now runs git with its
  own HOME and global config (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`) and without the caller's `GIT_*` / `EMAIL`
  variables. It failed in agent shells (which set `GIT_AUTHOR_NAME`) and with a different global `user.email`.
- Code under test unchanged.
