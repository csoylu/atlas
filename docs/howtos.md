# How-tos: shells, clones, live data, files

Moved out of `CLAUDE.md` (#295) so it is read when needed, not sent with every model request. CLAUDE.md points here.

## All commands
```
cp .env.example .env   # model keys (gitignored); see .env.example
npm ci               # never npm install (see Setup and shells)
npm run dev          # engine + UI with hot reload, opens http://localhost:5173
npm run desktop      # Electron app in dev
npm run typecheck && npm test   # fast suite; test:full adds slow suites, test:changed only what your diff affects
npm -w @atlas/desktop run install:mac   # manual build from source into /Applications (agents: never, see Releases)
npm run ui:check     # responsive check of the real UI (docs/ui.md)
node scripts/orb-check/check.mjs   # voice orb overlay: screenshots of every state, frame times, CPU, Esc, click-through, drag (→ shots/orb)
```

## Agent shell environment
**Agent shell environment** (#136, `packages/engine/src/shellEnv.ts`): every agent command (shell foreground and
`background: true`) runs with the PATH of the user's login shell, read once at engine start (`$SHELL -ilc`, from the
system PATH, 15 s timeout), plus `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` = the agent id (the email stays the user's
git config). Desktop and `main.ts` without a password use the login shell; server mode, Windows and tests keep the
engine's PATH. A failure is logged and shown in Settings → About & data, never silent. Never spawn an agent command
with `process.env` directly: take `ctx.env()`.
The shell is **not confined to a project** (#248): file tools, secrets, memory and instructions are isolated by the
engine, but a command can reach any path by absolute path. Stay in your project's clone and the temp folders; never
read or write another project's workspace. A lead crosses projects through the tools' `project` parameter, not by path.

## Setup and shells
- `npm ci`, never `npm install`: install rewrites package-lock.json and drops the optional
  `@rolldown/binding-darwin-arm64`, so vitest fails with "Cannot find native binding". If the lockfile changed:
  `git checkout package-lock.json && npm ci`.
- Agent shells have no `gh`, `node` or `npx` on PATH (background and nohup shells get only `/usr/bin:/bin:/usr/sbin:/sbin`)
  until #136: start with `export PATH=/opt/homebrew/bin:$HOME/.nvm/versions/node/v24.7.0/bin:$PATH`. `gh` is installed
  and logged in. A restart of Atlas kills foreground tools: detach long runs with `nohup … < /dev/null & disown`.
- Each agent works in its own git clone inside its workspace (atlas and paris: `publish-atlas/`, munih and zurich:
  `atlas/`). Other copies of the code (the root of atlas's workspace, `~/Desktop/perso/atlas`) are stale: don't edit them.
- If your clone holds another run's uncommitted work, don't mix: `git worktree add ../atlas-N origin/main -b <branch>`,
  `npm ci` inside it (no symlinked node_modules), push the branch, open the PR, then `git worktree remove --force`.
- A commit message starting with `#107 …` is dropped as a comment by `rebase --continue`: use `git commit --cleanup=verbatim`.

## Live data
- The live database is `~/Library/Application Support/Atlas/data/atlas.db`: read it with `sqlite3 -readonly`, never write.
- The engine's HTTP port changes at every launch: `lsof -nP -iTCP -sTCP:LISTEN -a -c Atlas`, then
  `http://127.0.0.1:<port>/api/…`. A curl on an old port gives code 000.
- UI against the live data without installing: `ATLAS_ENGINE=http://127.0.0.1:<port> npm -w @atlas/ui run dev` (Vite on :5173).
- A branch against real data: `.backup` the database to `/tmp/<dir>/`; in the copy set `agents.workdir = null`, reset
  running cards and runs, delete schedules; then `ATLAS_DATA_DIR=/tmp/<dir> ATLAS_PORT=4399 npx tsx packages/engine/src/main.ts`
  (shell with `background: true`; it does not stay up under nohup). `ui-check --port 4399` points at it.
- An engine started from a clone cannot decrypt the plan tokens (Electron safeStorage): checks against the real Claude
  or ChatGPT models need the installed app's engine.
- `POST /api/cards` in status `triage` wakes atlas. Throwaway test cards: status `todo`, no assignee.
- Installed build: the UI is in `/Applications/Atlas.app/Contents/Resources/ui/assets/index-*.js` (not in app.asar).

## Files and pictures
- File tools read the workspace and the temp folders, and write only in the workspace. Another agent's file is refused:
  copy it into your workspace first.
- The picture viewer (`read_file` on a png) caches by path: after overwriting a screenshot, copy it under a new name.
