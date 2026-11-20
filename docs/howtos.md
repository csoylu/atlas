# How-tos: shells, sandbox, clones, files

Moved out of `CLAUDE.md` (#295) so it is read when needed, not sent with every model request. CLAUDE.md points here.

## All commands
```
cp .env.example .env   # model keys (gitignored); see .env.example
npm ci               # never npm install (see Setup and shells)
npm run dev          # engine + UI with hot reload, opens http://localhost:5173
npm run desktop      # Electron app in dev (Master only: needs a real window, not available in the sandbox)
npm run typecheck && npm test   # fast suite; test:full adds slow suites, test:changed only what your diff affects
npm -w @atlas/desktop run install:mac   # Master only: manual build from source into /Applications
npm run ui:check     # responsive check of the real UI on a throwaway engine (docs/ui.md); runs in the sandbox
node scripts/orb-check/check.mjs   # Master only: voice orb overlay (needs a real window and screen capture; → shots/orb)
```

## Agent shell environment
**Agent shell environment** (#136, `packages/engine/src/shellEnv.ts`): every agent command (shell foreground and
`background: true`) runs with the PATH of the user's login shell, read once at engine start (`$SHELL -ilc`, from the
system PATH, 15 s timeout), plus `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` = the agent id (the email stays the user's
git config). Desktop and `main.ts` without a password use the login shell; server mode, Windows and tests keep the
engine's PATH. A failure is logged and shown in Settings → About & data, never silent. Never spawn an agent command
with `process.env` directly: take `ctx.env()`.
Without the sandbox (`ATLAS_SANDBOX` not 1, until S5) the shell is **not confined to a project** (#248): a command can
reach any path by absolute path. Stay in your project's clone and `$TMPDIR`; never read or write another project's
workspace. A lead crosses projects through the tools' `project` parameter, not by path.

## Sandbox
Agent commands (shell, background shell, `secret_set` commands, workflow command steps) run in a sandbox (#298: Seatbelt
on a Mac, bubblewrap on Linux; today with `ATLAS_SANDBOX=1`, always from S5). Everything in this file works inside it;
what it takes away is listed here.
- **Readable:** your workspace (your clones and worktrees), the toolchains (`~/.nvm`, `~/.cargo`, `~/.rustup`,
  `~/Library/Caches/ms-playwright`, Homebrew), `~/.gitconfig` (name and email). **Writable:** your workspace and your
  private `$TMPDIR`. `HOME` is your workspace: npm, git and gh keep their caches and config there.
- **Not there:** the Atlas data dir (`atlas.db`, other agents' workspaces), your real home (`~/.ssh`, `~/.config/gh`,
  keychains), the shared `/tmp`, the live engine's port, Docker, `open`, `osascript`, `launchctl`, Google Chrome.app, ssh.
  Use `$TMPDIR`, never a literal `/tmp/…`. Ask the engine through your tools, not `curl /api`.
  **Quote `"$TMPDIR"` and `"$HOME"`**: both sit under `Application Support`, a path with a space. Tests that pass a
  path to a shell command or parse it from output quote it too (#314).
- **Internet** (Settings → Workspaces) is On, Allowed hosts or Off per project and per agent. With Allowed hosts the
  proxy variables are set for you (`HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1`) and a host outside the list answers
  « <host> is not in this workspace's allowed hosts »: ask Master to allow it. Off: only localhost works (your own
  dev server does). The level in force when a command starts applies to it.
- **git and gh use your `GH_TOKEN` secret**, over https (a `git@github.com:` remote is rewritten to https for you; the
  remote stays as it is). No ssh, no ssh-agent. Without the secret, git stops with « GH_TOKEN is not granted to you… »
  and `gh` says it is not logged in: block with `task_block(kind: "capability", secret: "GH_TOKEN")`, Master adds it
  and the task restarts. The engine's own work (PR polling, review, merge, project clones) does not use it.
- **A sandbox denial** reads « Operation not permitted » (Mac; on Linux the path « No such file or directory » or
  « Read-only file system »), on a path outside the lists above or a program that needs the window server. A bug in
  the code reads differently: a stack trace, a failed assertion, a missing module. Check with the same command on a
  path inside your workspace before you chase the code, and never work around a denial (symlinks, copying secrets):
  report it to atlas.
- **Other processes are invisible (#322).** `ps` is refused and `pgrep`/`pkill` fail (« Cannot get process list »,
  exit 3 or 126), and a signal only reaches your own command's tree. To see or stop something you started, keep the id of
  a background `shell` and use `shell_output` / `shell_kill`. You cannot tell whether another agent runs a ui-check: see
  « One ui-check at a time » in `docs/ui.md`.
- **Browser:** `chrome-headless-shell --no-sandbox` from Playwright's cache (`npx playwright install
  chromium-headless-shell` when missing; `scripts/ui-check/tooling.mjs` does it for you). `ATLAS_CHROME` overrides.
- **Tests inside the sandbox:** `npm run typecheck && npm test` pass (a few tests skip by name where the sandbox refuses `ps`/`pgrep`,
  `osascript` or a long unix-socket path; CI and your own shell run them). `test:full`'s slow suites that need the host
  (real Chrome, voice models) skip or fail there, by design.
- **Check a command as an agent runs it:** `node --import tsx scripts/test/sandbox-run.ts <clone> -- '<command>'` (the real
  profile on a copy of the clone, GH_TOKEN passed through from your environment).
- **Master only** (need a real window, a screen or `/Applications`): `npm run desktop`, `orb-check`, `install:mac`.
  Test the desktop through e2e on a build.

## Setup and shells
- `npm ci`, never `npm install`: install rewrites package-lock.json and drops the optional
  `@rolldown/binding-darwin-arm64`, so vitest fails with "Cannot find native binding". If the lockfile changed:
  `git checkout package-lock.json && npm ci`.
- Agent shells have `gh`, `node` and `npx` on PATH (the login shell's, #136). If a nohup shell lacks them:
  `export PATH=/opt/homebrew/bin:$HOME/.nvm/versions/node/v24.7.0/bin:$PATH`. `gh` and `git` use your `GH_TOKEN` secret
  (Sandbox, above). A restart of Atlas kills foreground tools: detach long runs with `nohup … < /dev/null & disown`.
- Each agent works in its own git clone inside its workspace (atlas and paris: `publish-atlas/`, munih and zurich:
  `atlas/`). Other copies of the code (the root of atlas's workspace, `~/Desktop/perso/atlas`) are stale: don't edit them.
- If your clone holds another run's uncommitted work, don't mix: `git worktree add ../atlas-N origin/main -b <branch>`,
  `npm ci` inside it (no symlinked node_modules), push the branch, open the PR, then `git worktree remove --force`.
- A commit message starting with `#107 …` is dropped as a comment by `rebase --continue`: use `git commit --cleanup=verbatim`.

## Data and a second engine
- Agents do not read the live database or call the live engine: the sandbox denies both (Sandbox, above). Test against a
  throwaway engine on a seeded database in `$TMPDIR`: `scripts/ui-check/engine.ts` for the UI, the kit's `launch()` or
  `e2e/harness` for the engine (`docs/testing.md`). A change that needs real data: ask Master to run it on the live app.
- Checks on the live app (its database, its port) are Master's, from his own shell: `ui-check --port N` checks any engine he
  started. Ask him for one when a change depends on real volume.
- An engine started from a clone cannot decrypt the plan tokens (Electron safeStorage): checks against the real Claude
  or ChatGPT models need the installed app's engine.
- `POST /api/cards` in status `triage` wakes atlas. Throwaway test cards: status `todo`, no assignee.

## Files and pictures
- File tools read the workspace and the temp folders, and write only in the workspace. Another agent's file is refused:
  copy it into your workspace first.
- The picture viewer (`read_file` on a png) caches by path: after overwriting a screenshot, copy it under a new name.
