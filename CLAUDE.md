# Atlas — instructions for Claude

A personal agent harness: several named agents, each with its own model, tools and memory, working off a shared
kanban board, on a schedule, with shared artifacts. One human user, who gives their name and a short description on
first launch (Settings → About you). Full design: `docs/design.md`. Read it before any structural change.

## Stack (decided)
- TypeScript everywhere, strict mode, ESM. Node 24+.
- Engine: one Node process (`packages/engine`). Interface: React + Vite (`packages/ui`). Desktop: Electron (`apps/desktop`)
  wraps both. Server mode: the same engine on a VPS, UI opened in a browser.
- SQLite (`better-sqlite3`, WAL mode) is the single source of truth. No second store, no JSON state files.
- Artifacts (#120, 18 Nov 2026): markdown, html, svg and url files in an agent's workspace, versioned, grouped in flat
  Library folders. They replaced canvases and whiteboards (migration 0041; old canvases were converted to html pages
  in the « Canvases » folder). No board, no x/y nodes: don't bring a canvas or whiteboard back without asking.
- Models: Anthropic Messages API (API key), any OpenAI-compatible endpoint (llama.cpp, Ollama,
  LM Studio) for local models.

## Layout
```
packages/engine   agent loop, tools, providers, scheduler, dispatcher, kanban, store (SQLite), HTTP + WebSocket API
packages/ui       React app: chat, board, Library (artifacts), schedules, settings, logs
packages/shared   types and zod schemas shared by engine and UI (API contract)
apps/desktop      Electron main process: opens the UI window. Dev: loads Vite (:5173), engine runs under system Node.
                  In-process engine (better-sqlite3 rebuilt for Electron) comes with packaging.
```

## Rules
1. **Keep it small.** Pick the simplest thing that works. No plugin system, no abstraction layer, no config option
   until a second real use needs it. A feature that doesn't work reliably is removed, not left half-working.
2. **Every state change is a SQLite transaction.** Nothing important lives only in memory. Killing the process at any
   instant and restarting must resume every agent, run and schedule (see design §6). Test it.
3. **Fail loudly.** A missing model, an expired login, an unknown tool: the run stops with a clear error on the card
   and in the UI, never a silent fallback. No `catch {}` that swallows an error.
4. **Migrations only** for schema changes (`packages/engine/src/store/migrations/NNNN_name.sql`), never edit an
   applied one.
5. **Secrets** (model keys and agent secrets) have their values in the OS keychain (Electron `safeStorage`) or env vars
   on the server, never in SQLite, logs, transcripts, the UI or an API response; SQLite keeps only their metadata
   (table `secrets`, #206). Agents get only the secrets granted to them, as env vars of their shell commands, never a
   model key; every tool output passes the redactor (`Secrets.redact`, values → `[secret NAME]`) before it is stored or
   sent to a model. Never spawn an agent command or store a tool output around those two (design §10b).
6. **Tests:** `vitest`. Every engine module has tests; the restart test (rule 2) and the agent-loop test with a fake
   provider must stay green. `npm run typecheck && npm test` before every commit (`npm test` = fast project, ~10 s; `npm run test:full` also runs the slow project: real voice models + the 50-SIGKILL crash test, `CRASH_KILLS=n` shortens it. Run it when you touch voice, the store, runs or leases).
7. Shared types go in `packages/shared`; the UI never imports engine code directly, only the API.

## UI type rules
Same scale as OpenCode (packages/ui/src/styles/theme.css). Enforced by `packages/ui/src/typeRules.test.ts` and ui-check.
- **Tokens** (styles.css, the « type tokens » block): sizes `--fs-small` 13, `--fs-base` 14, `--fs-large` 16, `--fs-xl` 20 px;
  weights `--fw-regular` 440, `--fw-medium` 530, `--fw-bold` 670; line heights `--lh-tight` 130% (one-line labels),
  `--lh-normal` 150%, `--lh-long` 180% (chat messages, descriptions, documents). Families: `--font`, `--mono`.
  Mono text uses the same size tokens.
- **No literal** font-family, font-size, font-weight or line-height in CSS or in inline styles: always a token. Need a
  fifth size? Ask first, don't add one.
- **No text under 13 px.** Allowed exceptions, each marked `/* type-exception: why */` on its line: inputs at 16 px on
  phone (iOS zooms in below 16), and a letter inside a tile too small for 13 px (aria-hidden).
- **Contrast:** text colours that carry information reach 4.5:1 on `--app`, `--panel` and `--raised` in both themes
  (`--faint` is the floor). Placeholders and disabled text may be lower.
- **@font-face** only through the fontsource imports in `main.tsx`.

**Writing tests** (`packages/engine/test/kit`): never write your own sleep loop. `eventually(fn, {timeout, what})` waits for
the thing you need (a returned value, or an assertion that stops throwing); `retry(fn, {times, retryIf})` re-runs a flaky
operation; `launch({ script | provider, ...startEngineOptions })` gives a throwaway engine with every dependency injected
(the model, `updates.fetch`, `dbFile`, `leaseMs`…) that stops itself after the test. To order two things, make the first
signal the second (a marker file, an event), never `sleep(1500)`. A failed test is retried once and shown as retried: a
test that needs it is broken, fix it. Reproduce a timing flake under load: `yes > /dev/null &` ×8 and loop the test.

## Commands
```
cp .env.example .env   # model keys (gitignored); see .env.example
npm install
npm run dev          # engine + UI with hot reload, opens http://localhost:5173
npm run desktop      # Electron app in dev
npm run typecheck && npm test   # fast suite; test:full adds slow suites, test:changed only what your diff affects
npm -w @atlas/desktop run install:mac   # manual build from source into /Applications (agents: never, see Releases)
npm run ui:check     # responsive check of the real UI (below)
node scripts/orb-check/check.mjs   # voice orb overlay: screenshots of every state, frame times, CPU, Esc, click-through, drag (→ shots/orb)
```

**Responsive check** (`scripts/ui-check/check.mjs`, macOS: needs Google Chrome and Xcode's `swiftc`). Opens the running
Atlas app's UI in headless Chrome at 1440 / 1100 / 900 / 390 px (390 = phone, touch) on every main screen: chat with
pins, ticket modal, side panel, board, inbox, Library (list with tiles, search, a doc, its version picker), workflows (list, canvas edit, canvas runs, off), every settings page. It reports page-wide horizontal overflow (and
the phone zoom-out it causes), text under 12px, text off-screen outside a scroller, pins or chat buttons covering
messages or the composer, the modal or panel off-screen, uncaught page errors, and key labels that Apple Vision OCR
(`ocr.swift`) can't read at confidence ≥ 0.5. Exit code 1 on any issue; screenshots + `report.json` in
`/tmp/…/atlas-ui-check` (`--out DIR`).
- Beyond layout it also fails on: an error banner the page raised (`.error[role=alert]`, e.g. « task … not found »: a
  fixture the harness forgot to serve), and two text boxes of the same header overlapping (« All tasks » tab over the
  « Tasks » title, #224). Fixture tasks (`c_uicheck…`) are served in full (task, messages, runs, timeline, usage); a
  fixture page that opens an update in the Inbox gets a fake 204 for « mark read » (listed under refused writes).
- The engine port is read from the running app (`lsof`; it changes on every start), or `--port N`.
- Read-only: the harness refuses every API write from the page. Pins and the panel come from fixtures added to the
  responses the page sees (4 cards in every pin state, a real document in a panel tab); nothing is stored.
- `--ui packages/ui/dist` tests a local build (`npm -w @atlas/ui run build`) against the same engine, before reinstalling.
- `--widths 390`, `--only chat,modal` (screen-name prefixes) to narrow a run; a full run takes ~75 s.
- Run it after any UI layout change; the acceptance bar is « no issues » at all widths. **Run only what the change can
  affect** (#240, Master: « tasks in side panel doesn't need 260 screens »):
  - Engine-only or docs-only change: no ui-check.
  - UI change: `--only` on the screens that render the changed components, plus the ones the builder lists, at all four
    widths. `--only` matches screen-name **prefixes**: `chat` (all `chat-*`), `task` (task-board, -list, -inbox, -chat,
    -images, -blocked), `thread` (thread, thread-images), `new-task-images`, `panel` (panel, panel-max), `drawer`,
    `board`, `inbox`, `library`, `settings-` (or `settings-memory`, `settings-secrets`…), `workflow` (list, edit, runs,
    off), `palette`, `shortcuts`. The list of names: `grep -oE "name: '[^']+'" scripts/ui-check/check.mjs`.
  - **Full run** (no `--only`) only when the change touches something every screen shares: global styles (`styles.css`
    tokens and resets, `theme.css`), the app shell or sidebar, shared headers, the side panel shell, fonts
    (`main.tsx` imports), or `scripts/ui-check` itself.
  - **One ui-check at a time** on the machine (two at once give false failures): `pgrep -fl check.mjs` first, wait if
    one runs.

**Screenshot tool** (#133, `packages/engine/src/screenshot.ts`): agents have a built-in `screenshot` tool, one picture
of a route (`#/board`) or a workspace page (`pages/x.html`, `/api/files/<agent>/…`) at a width/height and theme, with
optional `clip`, `full_page`, `wait_for` and `actions` (click, type, press). It runs a fresh headless Chrome against the
engine it runs in (no port lookup), refuses every write from the page (the main-chat lookup gets a read-only answer),
fails after 15 s naming what never appeared, and returns page errors + refused writes with the picture (saved under
`screenshots/`). Unit tests: `screenshot.test.ts` (fast); real Chrome: `test/screenshot.chrome.test.ts` (slow project).

**Agent shell environment** (#136, `packages/engine/src/shellEnv.ts`): every agent command (shell foreground and
`background: true`) runs with the PATH of the user's login shell, read once at engine start (`$SHELL -ilc`, from the
system PATH, 15 s timeout), plus `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME` = the agent id (the email stays the user's
git config). Desktop and `main.ts` without a password use the login shell; server mode, Windows and tests keep the
engine's PATH. A failure is logged and shown in Settings → About & data, never silent. Never spawn an agent command
with `process.env` directly: take `ctx.env()`.

## Releases (#123, docs/updater.md)
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
  for Master: no Inbox item) and Atlas reads the PR from GitHub every minute (`gh api`, Master's gh login). When CI
  `test` is green, the reviewer's run starts **in the same task thread**: zurich (Settings → Board & triage → Review
  agent), or atlas for zurich's own PRs. No separate "Validate PR #N" task any more. The reviewer reads the diff and
  checks it (code: tests, the feature in a build, screenshots for UI; docs only: read it), then gives its verdict with
  the engine's **`pr_validate` tool** (#216: `{pr, verdict: "ok", sha: <head>, reason: "what was checked"}`, merges
  by default; or `{pr, verdict: "fail", reason: "why, for the builder"}`), offered only to the task's reviewer while
  it is In review. Master's terminal: `node scripts/pr/validate.mjs <pr> --ok --sha <head> --as master "…" --merge`
  (same gate, same code). **ui-check in a review (#240):** none for an engine-only or docs-only PR; for a UI PR,
  `--only` on the screens the diff can affect at all four widths (the builder names them in the `task_request_review`
  summary, otherwise the reviewer derives them from the diff); a full run only for a change to something shared by every
  screen (list in the ui-check section), with the reason said in the verdict. Never two runs at once (`pgrep -fl
  check.mjs`). The verdict says which screens were checked and which were not: a narrowed run is never reported as a full
  one. Builders: name the affected screens in the summary. Atlas moves the task by itself: **merged → Done**; **CI red, a conflict
  or a failed validation → Ready** for the builder, with the reason as a note in the thread; the builder fixes, pushes and calls
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
  green: success, neutral or skipped). Atlas: csoylu/atlas, `test`. A new project: no CI job. Set it with
  `PATCH /api/projects/:id {"ciJob": "…"}`. Nothing in the gate is Atlas-specific: a project's rules live in its CI.
  `task_request_review` refuses a PR of another repo than the task's project's (and a project without a repo). The
  reviewer must be a member of the project (its review runs in its workspace for that project); otherwise nothing
  starts and the card says « review agent @X is not a member of project Y ». On the GitHub side Master
  sets, per repo, branch protection on main: required status `qa/validated`, plus the required CI check if there is one
  (agents never change a repo's settings).
- **Merge queue (#236): one PR at a time per project.** The tasks In review of a project are reviewed and merged in the
  order they called `task_request_review`; a task sent back leaves the queue and re-enters at the end when it asks
  again. Only the head gets a reviewer run; the others wait In review and their card says « 3rd in the queue, behind
  #214 and #215 », the head « 1st in the queue for 25 min · … ». Before the head is reviewed, Atlas brings each of its
  PRs up to date with main in the reviewer's clone of the repo (its workspace for the project, or a folder right in it
  whose origin is the repo; a throwaway worktree, the clone's branches untouched): a rebase that applies cleanly is
  pushed (`--force-with-lease` on the head GitHub showed) and the review waits for CI on the new head; a real conflict
  sends the task back with the files named and the queue moves on. **Migration numbers:** a migration the PR adds whose
  number main already took is renamed to the next free one in that same push, with every reference to its file stem in
  the files the PR changes (thread note « migration 0051_x renamed 0052_x »); only migrations new in the PR move. CI (the
  job `test` on the PR: `node scripts/pr/migrations.mjs check HEAD^1 HEAD`) fails a new migration not above every
  number on main, so a clash never merges (the review gate reads only CI, #238). After the queue rebased your branch, `git fetch` and reset to `origin/<branch>`
  before pushing again (a plain push is refused). Master's terminal `--merge` may jump the queue: the next read sees it,
  and every queued PR is brought up to date again.
- **Done means on main** (#126, #189): a task with a PR ends with `task_request_review` and becomes Done when the PR
  merges, by itself. A task with several branches links every PR. A task with no code (mockup, audit, report)
  finishes with `task_complete` as usual.
- **Agents never install the app.** No `install:mac`: Master's Atlas shows "Update available" and installs on
  Master's click (it restarts; running tasks resume). `install:mac` stays for a manual build from source.
- **Testing without installing:**
  - UI: `npm run build`, then `npm run ui:check -- --ui packages/ui/dist` (the local build against the running engine,
    read-only), or screenshots of a second engine (below).
  - Engine: a second engine on a copy of the database, never the live one: `sqlite3 <data>/atlas.db ".backup /tmp/x/atlas.db"`,
    then `startEngine({ dbFile: '/tmp/x/atlas.db', dataDir: '/tmp/x', port: 4388, dispatch: false, env: {}, uiDir: 'packages/ui/dist' })`
    (`dispatch: false` so it starts no runs and no schedules).
  - E2E: `e2e/` (Playwright, scripted model) on a local build.

## How-tos (moved here from agent memory, 18 Nov 2026)
Project how-tos live in this file, not in agent memory. Add one here (through a PR) when you learn it the hard way.

**Setup and shells**
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

**Live data**
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

**Tests**
- Under load (several agents, load average ~30) `npm test` fails at random (changelog, dispatcher, lifecycle, rewind,
  runner), and in `test:full` the voiceLoop barge-in test too. Rerun the failing files alone
  (`npx vitest run --project fast <files>`, `--project slow` for voice) before calling it a regression.
- Engine tests with a scripted FakeProvider call `startEngine({ memoryReview: false, … })`, or the background memory
  review eats the script.
- E2E: `npm run build`, then in `e2e/`: `E2E_CHANNEL=chrome npx playwright test --reporter=line` (~20–50 s).

**UI**
- Styles are global: a class named after data (`card`, `board`, `panel`) collides with the board's CSS. Prefix dynamic
  class names (`rowic-<name>`) and update the selectors in `scripts/ui-check` when renaming.
- The task view is `packages/ui/src/CardView.tsx`, shared by `CardModal.tsx` and `ThreadPanel.tsx`: edit it for both.
- `ui-check` tests the built UI (`npm run build` first: a stale `packages/ui/dist` gives false errors) and needs
  `npm ci` once in the clone ("Cannot find package 'sharp'" otherwise). Several runs at once give false failures
  (layout width, "never showed .settings"): check `pgrep -fl check.mjs`, rerun the failing screens alone with `--only`
  and `--widths`. The OCR reading "All" as "AIl" or "Links" as "LInks" is a known quirk: the
  comparison folds `i`, `I` and `l` into one letter (nothing else is forgiven).
- An HTML mockup in the side panel gets the panel's width, so a page with a 640 px breakpoint shows its phone layout
  there: judge the desktop layout full size (`/api/files/<agent>/pages/<file>.html`).

**Files and pictures**
- File tools read the workspace and the temp folders, and write only in the workspace. Another agent's file is refused:
  copy it into your workspace first.
- The picture viewer (`read_file` on a png) caches by path: after overwriting a screenshot, copy it under a new name.

**CI and merging**
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
