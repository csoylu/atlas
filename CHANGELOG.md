# Changelog

Newest on top. One push to main = one entry = one release (docs/updater.md). Each entry is a heading
`## Kind · #task · One plain sentence`, then optional details. The kind sets the version (Semantic Versioning,
computed by `scripts/release/changelog.mjs` from the oldest entry to the newest, starting at 0.3.0 = v3, cad983f):
`Fixed` → patch, `Added` or `Changed` → minor, `Breaking` (data or settings stop working without action) → major.
Never type a version number.

## Added · #215 · Memory and secrets now belong to a project, plus a global memory for your own rules that every project sees

Projects 3/5 (design §17). Memory has three levels: global (yours, every project), a project's, and an agent's in a project; a run sees global + its project + its own, never another project's (always-on, recall, search, change notes, background review, cleanup). Agents save with scope `self`, `shared` (this project) or `global`. Migration 0052 keeps every memory in « Atlas »; atlas moves your general rules to global afterwards (`PATCH /api/memories/:id {"scope":"global"}`). Always-on budget: 3000 characters per run, global at most 2000. Secrets are global or one project's; a run gets global + its project's. The memory kind « project » is now shown as « task notes ».

## Added · #214 · Projects get their own workspace and main chat per agent: a member of a second project works in its own clone of that repo, never in another project's folder

Projects 2/5 (design §17). Adding a member to a project clones its repo into `workspaces/<agent>/<project>/` with your gh login (cloning, ready or failed with the reason; Try again; an empty folder without a repo). A run works only in the workspace of its task's project (files, shell, screenshots, artifacts, CLAUDE.md / AGENTS.md) and fails on the card when that clone isn't ready. Each agent has one main chat per project; « Atlas » keeps today's chats and folders exactly as they are. Removing a member stops its runs there, gives its open tasks back to the lead, archives its chat there and keeps its clone on disk until you delete it. Links `/api/files/<agent>/…` still open the same files; another project's files are at `/api/files/<agent>@<project>/…`.

## Added · #209 · Settings → Secrets: see, add, replace, grant and delete your agents' secrets, and see where a value was hidden in a chat

Secrets 4/4 (UI, mockup #205). A new Secrets page in Settings → Team, with a count, lists the agent secrets and their grants (which agents can use each), who made each one and when it was last used, with Replace value, Edit and Delete on each row. Secrets an agent asked for show « No value », with Add the value (the waiting task restarts by itself) and Dismiss. The model keys are listed below as « Models only ». Values are write-only: the field is cleared after saving and a value is never shown again. On a server, a locked secrets file shows an unlock panel and a « Secrets locked · Unlock » badge in the sidebar; once it is unlocked, the page offers Lock now and Change the password. In a chat, a command whose output contained a secret shows « 1 secret hidden », and every `[secret NAME]` is highlighted in the output and in messages. ui-check covers the page, the add form and the locked server.

## Added · #211 · Drag the border between the chat and the side panel to resize the panel; the width is kept

The separator is an 8 px grab area with an accent line on hover, drag or focus. The panel stays between 360 px and the width that leaves the chat 380 px (over the chat at 960 px and below: up to 94 % of it), and is clamped again when the window shrinks, so it never goes off-screen. The width is saved (`atlas.panel.width`) for every chat and the task thread beside it; double-click resets it, and the keyboard moves it (← wider, → narrower, Shift for bigger steps, Home / End). Dragging over an html page in the panel keeps working. Phones keep the full-screen panel with no handle. In a chat narrower than 460 px the composer strip drops « context » and the token counts, as on a phone. ui-check gains a « panel-max » screen (panel at its widest, chat at its narrowest).

## Fixed · #221 · A reviewer no longer mistakes the builder's work for its own, and a review that ends without a verdict is retried once, then shown

Pull requests sat In review for hours with CI green: the reviewer's run started in the builder's thread without its « You review this pull request » note (the builder's last tool result already left a turn owed), and the builder's messages were replayed to it as its own, so zurich answered as munih (« I built it… I won't validate my own work »). Now the note is always added, and another agent's turns reach the model as named context (« [@munih, another agent, wrote this in the thread (not you):] », its tool calls and results as lines), never as the running agent's own; the same holds for the builder reading the reviewer's turns later. A review run that ends with no `qa/validated` success or failure on the head starts once more, told why; after the second the task says « review by @zurich ended without a verdict » with an Inbox item, and Retry starts it again.

## Added · #216 · Pull requests of any project go through the same QA review as Atlas's, with that project's own rules

Projects 4/5. Each project has its PR gate: repo, the CI check that must be green (empty = every check green) and whether each PR must add one changelog entry (migration 0050: Atlas keeps `test` and the changelog rule; a new project starts with any check and no changelog rule). The reviewer gives its verdict with a new engine tool, `pr_validate`, which runs the validation script's code with the task's project's gate from any workspace (Atlas's changelog-only auto-rebase, merge and refusals unchanged; `scripts/pr/validate.mjs` stays for the terminal, with `--repo`, `--ci-job`, `--no-changelog`). `task_request_review` refuses a PR from another repo than the task's project's, and a reviewer who is not a member of the project gets no run: the card says « review agent @X is not a member of project Y ».

## Added · #213 · Projects in the engine: everything you have is now the project « Atlas », and tasks, chats, artifacts and workflows each belong to a project

Projects 1/5 (design §17). New tables `projects` and `project_members`; migration 0048 puts every task, chat, artifact, folder, workflow and memory in « Atlas » (csoylu/atlas), makes every agent a member in its current workspace (nothing moves) and the triage agent its lead. API to list, create, edit, archive and restore projects, and a repo check through gh. Lists and agent tools are scoped to the run's project; only a project's lead may act on or message another project. A project's new tasks go to its lead. Archiving keeps everything, stops its runs, turns its workflows off and makes it read-only. With one project nothing changes; the Projects UI comes later.

## Added · #207 · Agents can store a secret themselves without seeing it, and ask you for one they can't make

Secrets 2/4 (engine). New tool `secret_set`: with `command`, Atlas runs the command and keeps its output as the secret's value without the agent, the transcript or the model ever seeing it; with `value`, the value is replaced by `[secret NAME]` in the stored conversation. A secret an agent makes is granted to that agent only, and an agent can change or delete (`secret_delete`) only its own secrets, never yours, another agent's or a model key. When an agent needs a key only you have, it blocks naming it (`task_block` with `secret`): a « no value » entry appears in Secrets, and the task restarts by itself once you add the value; deleting the entry dismisses it.

## Added · #208 · A server engine keeps its secrets in an encrypted secrets.enc, unlocked with a password at start or from the UI

Secrets 3/4. On a server, model keys typed in Settings and agent secrets go in `<data dir>/secrets.enc` (AES-256-GCM, key from scrypt of a secrets password, written atomically, mode 0600); the password and key are never written anywhere. `ATLAS_SECRETS_PASSWORD` unlocks it at start, so a restart resumes runs that need secrets; without it the store stays locked until unlocked through `POST /api/secrets/unlock` (the Settings → Secrets page comes with 4/4). While locked, commands that use a secret, models whose key is in the file and new secrets stop with « secret store locked: unlock it in Settings → Secrets »; everything else, env-var keys included, keeps working. New routes: status, unlock, lock now, set or change the password. A wrong password answers after a 1 s delay; a tampered file is refused. The desktop app keeps the Keychain.

## Added · #206 · Agents can use secrets you grant them in their shell commands, and secret values are hidden from every output

Engine side of Secrets (1/4; the Settings page comes with 4/4). Secrets have their metadata in a new `secrets` table (name, description, model key or agent secret, granted to no agent, some agents or all, who made it, last used) and their values only in the keychain; no API response ever holds a value, and model keys are never given to agents. An agent's shell commands (foreground and background) get its granted secrets as `$NAME`, read at each command so a new value applies right away; a command using a secret it isn't granted, or one with no value, stops with the reason. Its instructions list the names and descriptions it can use. Every tool output is checked before it is stored, shown or sent to the model: any secret value (8 characters or more, also model keys and plan tokens) becomes `[secret NAME]`, and the chat gets the count for « 1 secret hidden ». Model keys and the server password no longer reach agent shells even when they are in the engine's environment.

## Added · #171 · Workflows page with a canvas: wire steps by dragging, follow each run on the graph, read and run them from your phone

Schedules becomes Workflows in the sidebar (G then W; old #/schedules links land there). The list shows each workflow's trigger, its chain of steps, its current or last run with the task, on/off, Run now and Open; migrated ones say « from Schedules ». New workflow asks for a name and how it starts (a time or by hand), then opens the canvas with an empty agent step selected. On the canvas: drag steps, drag an exit's dot onto a step to wire it, click a link to remove it, add agent steps, approvals and conditions, undo, zoom; the right panel edits the selected step (title, agent, prompt with {{previous.summary}}, {{previous.task}}, {{run.id}}, task mode, exits). Every change saves by itself; a save made stale by another change is refused with the reason and a Reload. The Runs view shows the same graph with each step's state and task, the path taken in green, the runs and their step log, and Stop run. On a phone the steps read as a list (« exit → step », an unwired exit « ends the run ») with the runs, Run now and on/off.

## Fixed · #161 · An update interrupted at the worst moment can no longer leave you without Atlas.app

The helper now swaps the old and new app in one atomic step (renamex_np RENAME_SWAP), so killing it anywhere during
the swap leaves an app that opens. Covers the normal case (data folder and /Applications on the same volume); on
another volume it falls back to two renames as before.

## Fixed · #163 · A long path or URL in the update dialog's release notes now wraps instead of being clipped and scrolling sideways

`overflow-wrap: anywhere` on the note title and body (code blocks wrap too). The e2e test `updater.spec.ts` › "long unbroken word" is no longer `test.fail`: it checks 1440 and 390 px in both themes.

## Fixed · #162 · When GitHub answers the update check with a web page (wifi login page, proxy), Settings → About now says so in a sentence instead of a JSON parser message

The check still fails loudly: the error reads « GitHub did not answer with a release list (a wifi login page or a proxy may be in the way) », and the engine log keeps the real cause (content type, start of the page, parser error).

## Added · #178 · A test that only passed on a retry is now named in the test output and as a warning in CI

vitest retries a failed test (twice in CI), which let a flaky test pass quietly. A small reporter (`scripts/test/retryReporter.ts`) now lists every test that failed and then passed on a retry, by name and file: in the console, and on GitHub Actions as a `::warning` annotation (vitest's own « Flaky Tests » section in the job summary and its failure annotations are kept). A run with no flaky test prints nothing. It reports only; the run stays green, fix the test.

## Changed · #189 · Tasks know their pull requests: a task with an open PR waits In review for QA and moves to Done by itself when the PR merges

A builder ends its run with `task_request_review({summary, prs: [url]})`: the task goes **In review**, which now means « waiting for QA » (no Inbox item, not in « Needs you »), and shows « PR #N » with CI, conflicts and QA on the board tile and in the task view. Atlas reads each PR from GitHub every minute with `gh api` (your own gh login, no token stored). CI green → the review agent (Settings → Board & triage, zurich by default; atlas for zurich's own PRs) gets a run in the same task thread, no more « Validate PR #N » cards. Merged → Done; CI red, a conflict or a failed validation → back to Ready for the builder with the reason as a note. When GitHub can't be read nothing moves and the card says why (an Inbox item after 15 min). `task_complete` is refused while a linked PR is open. Migration 0045 (table `card_prs`, column `cards.reviewer`).

## Fixed · #195 · The validation script's automatic changelog rebase now starts on a conflicting PR, which GitHub runs no CI on

`validate.mjs --ok … --merge` on a PR that conflicts with main in CHANGELOG.md only refused with « CI job "test" has not run … yet », because GitHub does not run CI on a conflicting head, so the #188 rebase never started. In that case CI that never ran on the old head is no longer required: the rebase already waits for CI `test` on the new head and merges only when it is green. CI that did run on the old head and is red or still running is refused as before, and so are a conflicting PR without `--merge` and a non-conflicting PR without CI.

## Fixed · #192 · A document chip in a task's thread opens the document again, from the task window and from the task beside a chat

In the task window, a chip (or a row of the task's Artifacts) shows the document over the whole window at the chip's
version and section; « ‹ Task » or Esc goes back to the task as it was. Beside a chat, the chip opens it in the chat's
documents panel. A chip's section given by its heading text (« 7. Open questions ») now scrolls there too.

## Changed · #188 · Merging a PR whose only conflict is the changelog no longer needs a hand rebase: the validation script rebases it by itself

`node scripts/pr/validate.mjs <pr> --ok --sha <head> --as <who> "…" --merge` on a PR that conflicts with main in CHANGELOG.md only now replays its commits onto main in a throwaway worktree, puts its entry back on top with main's entries byte-identical, checks that every other file equals git's own merge and that the PR's changed lines are the same as before, pushes the branch with `--force-with-lease`, waits for CI `test` on the new head, then validates and merges that head (it prints the old → new head). CI red on the new head: `qa/validated` = failure, no merge. Another conflicting file, merge commits in the PR, edits to older changelog text or a head that moved: refused as before, the author rebases. CHANGELOG.md, the one-entry rule, versions and release notes are unchanged.

## Changed · #170 · Schedules are now workflows: a trigger wired to agent steps, approvals and conditions, run safely across restarts

The engine half of Workflows. A workflow is a time or manual trigger wired to agent steps (a task for an agent, with `{{run.id}}`, `{{previous.summary}}`, `{{previous.task}}`), approvals (a task in your Inbox with Approve / Reject) and conditions (« step X ran fewer than N times », « the previous summary contains … »); each step has named exits (done / failed, approved / rejected, yes / no) and an unwired exit ends the run. A trigger firing while a run is still going is recorded as skipped; Stop run closes the run's open tasks; a restart in the middle of a run carries on from the stored step. Every schedule becomes a one-step workflow « from Schedules » with its prompt, timing, time zone, task mode, on/off, last run and task (migration 0044, the schedules table goes). Agents keep schedule_create / schedule_list / schedule_delete, which now make one-step workflows. API: /api/workflows and /api/workflow-runs replace /api/schedules. The Schedules page reads workflows: it still creates and edits one-step ones; a workflow with more steps shows as a row with on/off, Run now and Delete. The editor for workflow graphs comes in #171.

## Changed · #143 · A task's news in a chat is now one compact row that opens its Inbox entry, and the agent no longer wakes up to repeat it

When a task created from a chat finishes, is blocked, needs your OK, is closed or stopped, the chat gets one row (icon, #N, status, title, time, « Inbox › »); a finished one shows the first line of its summary under it. The row is a link to the task's Inbox entry (a closed task opens the task) and no longer expands. The agent does not start a run for it: it reads the note on its next turn, and its instructions tell it not to restate it. Long summaries in the note are shortened on a sentence, never mid-word, with where to read the rest. Memory changes between two messages are one quiet « N memories changed » row, each memory once, one line each when opened.

## Fixed · #173 · A chat with a web search no longer dies after Atlas switches to another Claude subscription

Anthropic encrypts web search results for the account that ran the search and refuses them from any other one (400 « Invalid `encrypted_content` in `search_result` block », on every retry). paris's main chat broke this way when the first Claude plan hit its limit and calls moved to the second one. Each new search result now records the account that ran it; it is sent exactly as stored through that account, and as one line of text together with its request through any other (results stored before this fix go as text). The pre-send check also stops with the message and block named when a stored result is cut or malformed.

## Fixed · #184 · The end-to-end suite is green again: K12 follows the #131 Todo behaviour, and four flaky spots in the tests are fixed

`e2e/tests/audit/api-cards.spec.ts` K12 now expects a transient block to wait in Todo with `retry.at` about 30 min ahead, no block, "retrying at" as the waiting reason and nothing in Inbox « Needs you » (it still expected `blocked`, stale since #131). `ui-134.spec.ts` killed the `sleep` commands of the tests running in parallel (a blanket `pkill`): each test now kills only its own. `U15` (Esc pressed before the palette listens) and `steps-timeline` (group opened by itself) retry under load instead of failing one run in ~30. `artifacts.spec.ts`: the four fixed `waitForTimeout(600)` wait for the chip row to stop scrolling, and an unused variable is gone. Tests only: no change in the app. Full suite: 178 passed, 1 skipped, 10 of 11 runs in a row green under load (one run lost seven serial tests to a machine stall).

## Fixed · #180 · In the Library's recent tiles, the time and version stay readable at every width; a long folder name is shortened instead.

## Added · #127 · QA check of artifacts: 11 end-to-end tests and a written verification report

`e2e/tests/artifacts.spec.ts` covers the chat card (kind, version, "Updated to vN", "vM is the latest"), the one-row viewer with version picker and restore, the ⋯ menus, the phone layout, the Library (folders, tabs, live tiles, pin, move, rename, delete, search, empty state) and text contrast in both themes. `docs/qa/127-artifacts-report.md` records what was checked on the real data copy. Tests and docs only: no change in the app, no migration.

## Changed · #124 · The app updater is tested end to end: release pipeline, bad and cut downloads, killed swaps, updates while agents work, and the update screens in both themes

About 60 new tests, no app code changed: `scripts/release/pipeline.test.ts` (CI workflow and the one-entry rule on real git histories), `packages/engine/test/updater.qa.test.ts` (fake GitHub: rate limit, bad checksum, cut and stalled downloads, SIGKILL during the download and the swap, several versions skipped) and `e2e/tests/updater.spec.ts` (badge, notes dialog and Settings → About at 1440 and 390 px in both themes, an update clicked while two agents work). Three known bugs are kept as `it.fails` / `test.fail` tests until fixed. Report: docs/qa/124-updater-report.md.

## Added · #148 · `npm run ui:check:fast` runs the UI check at the four widths in parallel (about 80 s instead of 3 min)

`scripts/ui-check/parallel.mjs` starts one `check.mjs` per width (1440, 1100, 900, 390), each with its own Chrome and output folder, and exits 1 if any width reports an issue or dies (killed by a signal, or never started), and names the signal. Same flags as `ui:check`, except `--widths` and `--out`, which it refuses (exit 2). Test tooling only: no change in the app.

## Changed · #126 · Tests: one shared kit, a stable rewind test, retries that show

Tests wait with one `eventually()` helper instead of six private copies, engines for tests are launched with `launch()` (model and other dependencies injected), and a failed test is retried once and marked. The flaky rewind test no longer depends on timing.

## Fixed · #174 · In old chats, a canvas step now shows the page its canvas was converted to, and opens it

A canvas_create, canvas_write or canvas_read row whose canvas became an html page in the « Canvases » folder (#120) shows that page's artifact card; a canvas with no page keeps its plain row. Documents now carry `fromCanvas` in the API.

## Fixed · #145 · In an expanded « N steps » group, the timeline line now runs through the middle of every row icon.

The line sat 1.5 px left of the icons (3 px on a phone). Each step row now draws its own piece of the line from its icon's
position, so it stays centred, never shows through an icon, and stops at the first and last icon. E2E test:
e2e/tests/steps-timeline.spec.ts.

## Fixed · #146 · The "Add images" button of a task without images shows its icon and label on one line, aligned with the description.

In the New task dialog and on an existing task, the empty-state button was a grid: the icon sat above the label, indented, and the label touched the selects row.

## Changed · #136 · Agent commands see your login shell's PATH, and their commits carry the agent's name

At start the engine asks your login shell (`$SHELL -ilc`) for its PATH once and gives it to every agent command, foreground, `background: true` and what they start with nohup: gh, node/npx from nvm and the rest of your terminal's tools work with no `export PATH=…`. The app opened from Finder used to give them only /usr/bin:/bin:/usr/sbin:/sbin. If the login shell can't be read (no $SHELL, error, more than 15 s), the engine logs why and Settings → About & data → Agent shells shows it in red; commands then use the engine's PATH. Server mode (ATLAS_PASSWORD) and Windows keep the engine's own PATH. Agent commands also get `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME` set to the agent id (e.g. munih): a commit made by an agent says which one, with your email unchanged so GitHub still links it to your account. Commits from your own terminal and merges done by GitHub are unchanged. No migration.

## Changed · #142 · Project how-tos moved from agent memory into CLAUDE.md

Master's rule (18 Nov 2026): working how-tos about one project belong in its CLAUDE.md, not in memory. CLAUDE.md gets a How-tos section (setup and shells, live data, tests, UI, files, CI and merging) with the notes agents had saved as shared memories; those memories are archived. No code change, no migration.

## Changed · #120 · Artifacts replace canvases

Canvases, nodes and whiteboards are gone. Agents now make artifacts: markdown documents, html pages, svg diagrams and links, each a versioned file (artifact_create, artifact_update, artifact_list, artifact_read). In the chat an artifact is a card that says its kind and version ("Updated to v3", "v4 is the latest") and opens that version. The viewer has one header row: tabs, a version picker (with "Restore vN"), Latest, Full size and a ⋯ menu (author, folder, path, source, open in the browser or the Library). The Library has flat folders (rename, delete moves items to Unfiled), "Recently modified" tiles that show the real content, pinned items on top, and search across titles and content. Existing canvases are converted once to html pages in a "Canvases" folder (migration 0041; the old table is kept as an archive). Converted canvases start at v1: their old version history stays only in the archived tables.

## Changed · #131 · A task waiting on another task or retrying later waits in Todo, not Blocked: Blocked now always means it needs you

`task_block` with kind `dependency` now takes `waits_on` (task numbers): those tasks become the card's parents, the card waits in Todo with « waiting on #112 (running) » and starts by itself when they are done, with a note telling the agent so. A dependency with no task is refused (the agent creates the task first, or asks you). Temporary failures (rate limits, 5xx, every subscription paused until a reset, an agent's « retry later ») also wait in Todo with « retrying at 14:05 · why » and restart at that time. Neither shows the orange « ! », goes to the Inbox, or is reported to the chat. Both survive a restart. Cards already blocked as « waiting on other work » stay as they are. No migration.

## Fixed · #140 · Task numbers inside message text are plain #112 links with the title on hover, no more chips

In message text, summaries and tables a task reference is now a link-coloured « #112 » in the text's own size and line height, so lines stay evenly spaced. The task's title and status show on hover and are read by screen readers; a click or tap still opens the task. Chips that stand alone (pins, sidebar, cards, tool rows, Library, Memory) are unchanged. ui-check has a new `chat-refs` screen that checks line spacing, size, contrast and the hover title. No migration.

## Fixed · #132 · A [memory] note lists each changed memory once, with its latest text

A memory changed several times between two turns was listed once per change; now it is one line with its latest text. A memory added then forgotten, changed then changed back, or pinned then unpinned is not listed at all, and a memory already shown in an earlier note comes back only if it changed again. The chat row counts distinct memories ("2 memories changed") and no longer repeats ids, also for older notes. No migration.

## Added · #114 · 80 more end-to-end tests cover the API and every screen, with a written QA audit

The audit of 18 Nov 2026 (`docs/audit-2026-11-18.md`) lists what was checked per feature and the bugs found. `e2e/tests/audit/` adds 80 Playwright tests (agents, cards, content API and the UI screens) on the real engine and the built UI with the scripted model. Tests only: no change in the app, no migration.

## Added · #138 · A rewind says what it undoes and what it keeps, and takes back the tasks, messages, memories and schedules nobody acted on

The « Rewind to this message? » dialog, the note above the composer and the « Rewound by you » row now list two groups: Undone (files, plus tasks the rewound part created that nobody started, closed; messages to agents or tasks not read yet, withdrawn; new memories, archived; new schedules that never ran, turned off) and Kept (a task someone already worked on, a message already read, changed memories, canvases, `git push`), with why. « No files changed » never stands alone when something else happened. Undo brings back everything undone (unless it changed since; the note says so). Two rewinds in a row show as one row, whose Undo undoes both. Tool calls now record what they did in a new `side_effects` table (migration 0043, which also adds `rewinds.effects`); rewinds made before this list nothing.

## Changed · #126 · A task is done only once its code is on main

CLAUDE.md's Releases section now says it: before finishing a task, check that none of its branches (`<type>/<N>-…`) has commits that are not on origin/main. If one does, merge it first, or block and name the branch. Tasks with no code finish as before. This is a project rule in CLAUDE.md, not an engine check (Master, 18 Nov 2026). No code change, no migration.

## Changed · #141 · A pull request can only merge into main once the QA agent has validated it

GitHub cannot make an account approve its own pull request, and every agent uses Master's account, so the validation is a commit status, `qa/validated`, set on the PR's head commit by `scripts/pr/validate.mjs`. main requires it and the CI job `test`; a new commit on the PR clears it. The script refuses a PR not based on main, a head that moved since the review, red CI and a PR without exactly one changelog entry. CLAUDE.md's Releases section describes the flow. No code change in the app, no migration.

## Fixed · #144 · A run that searched the web while calling a tool no longer dies with an API 400 once its history is trimmed

When the model asked for a tool and a web search in the same answer, Anthropic sent the search's result at the start of the next answer. Once pruning reached that point it turned the search request into text and kept the result alone, and every retry failed with "Each `web_search_tool_result` block must have a corresponding `server_tool_use` block before it". The request sent to the model now always keeps the two together (or turns both into text), after pruning, summaries and fallback trimming too. Conversations already stuck this way (#142) work again on their next run: the stored messages are not changed. If a history still can't be sent, the run stops with the message and block at fault. No migration.

## Fixed · #125 · Small and dimmed text is readable again in both themes (contrast 4.5:1 or more)

Inbox kind labels, the +/− line counts, the Stop button, timestamps and counts on hovered or selected rows, paused schedules, inactive memories and the disabled Voice fields were under 4.5:1. They now use darker text colours instead of see-through text, and the faint text colour is one step stronger. Includes the `--spec` contrast audit of `scripts/ui-check` (#113).

## Added · #133 · Agents can take a screenshot of Atlas or of a mockup in one step and see it

New `screenshot` tool: `screenshot({ target: "#/chat/paris", width: 1440, theme: "dark" })` returns the picture directly and saves it under `screenshots/` in the agent's workspace. The target is an app route or a page in a workspace (`pages/x.html`, `/api/files/<agent>/…`); other sites are refused. Options: height, full page, one element (`clip`), wait for an element (`wait_for`), and clicks, typing or key presses before the shot (`actions`). Under 500 px it shoots as a phone (touch). It uses this Atlas's own address (no port lookup) and is read-only: the page sees your data but every write it tries is refused and listed. Page errors and console errors come back with the picture. When something never appears within 15 s it fails and says what, and without Google Chrome it says so. No migration.

## Fixed · #123 · The Windows installer is attached to releases again

The installer is now named Atlas-<version>-setup.exe, which the release step uploads (it was "Atlas Setup <version>.exe", so the upload found nothing).

## Changed · Every change now reaches main through a pull request, and main refuses force-pushes and deletion

CLAUDE.md's Releases section says it: no direct push to main, for anyone; a branch, then a PR based on main; one merged PR = one changelog entry = one release. The GitHub branch protection on main (no force-push, no deletion, admins included) was set on 18 Nov 2026. Requiring a validation by the QA agent before a merge is a separate task. No code change, no migration.

## Fixed · #139 · Tool rows show their icon again: no empty box on « Looked at #N », « Listed the board » or « Closed the panel »

The row icon carried its name as a CSS class (`card`, `board`, `panel`), so the board's `.card`, `.board` and `.panel` styles turned it into a grey box, a blank area or a filled square, and stretched the icon stack of the « N steps » header. Icon classes are now prefixed `rowic-<name>`. The e2e spec `ui-134` checks the row icons and the header stack in both themes.

## Fixed · #123 · A flaky updater test no longer blocks releases

The test that checks a second update keeps only the latest previous app sometimes read the app while the helper was swapping it; it now waits through the swap. 0.17.1 was not published because of it; this release carries its Windows fix too.

## Changed · #137 · Agents can read files in the temp folders (/tmp, $TMPDIR) without copying them into their workspace

read_file, grep, glob and list_files now also open paths under /tmp, /private/tmp and the system temp folder, read-only, so an agent can look at a ui-check or Playwright screenshot where it was saved. Links are resolved first: a link in /tmp to a file elsewhere is refused. write_file and edit_file still write only in the agent's workspace. A refused path says the rule: "read: workdir and temp folders; write: workdir only". Paths outside the workspace (temp and saved outputs) now show as absolute paths in grep and glob results. No migration.

## Fixed · #123 · The Windows installer builds again in releases

The Windows packaging step runs in bash, so the version setting reaches electron-builder (PowerShell had turned it into a file name). This is also the first release installed with one click from "Update available".

## Added · #123 · Atlas updates itself: every push to main is a release, and you install it with one click

Atlas checks GitHub for a new version at start, every hour and on "Check now" (Settings → About). When one exists, the sidebar shows "Update available"; the dialog lists what changed in every version since yours and who is working (they resume after the restart). Update downloads the app for your Mac, checks it, backs up the database, then quits, swaps /Applications/Atlas.app and reopens. Agents no longer reinstall the app.

## Changed · #112 · Atlas is bigger and calmer: 14 px text, agent faces, coloured status chips

The approved #104 v2 visual pass, with the OpenCode type scale (four sizes, 13 px minimum) and text contrast of at least 4.5:1 in both themes.

## Added · #119 · Images in tasks: paste, drop or attach them in the New task dialog and a task's description

A task can now carry up to 5 images (png, jpeg, gif or webp, 10 MB each), pasted (Cmd+V), dropped or attached with the image button. They show as thumbnails under the description in the New task dialog, the task window and the thread side panel. Click one to see it full size; × removes it. Pasting text still pastes text. A refused file says why, and nothing is stored. The assignee sees the task's images as pictures from the first turn of every run, and also gets their files in its workspace. This holds for a task assigned later or reassigned, and a removed image is gone from the next turn. Images cancelled in the New task dialog leave nothing behind. Migration 0040 (`cards.images`); the files are in `<data>/task-images/`.

## Changed · #112 · Bigger, calmer look: new type scale, agent faces, status chips

The approved #104 v2 visual pass is now on main (it was finished on a branch and missing from the 01:44 build). Type and rows are bigger, agents have faces in the sidebar, task states show as chips and pinned tasks have coloured edges. All text goes through four size tokens (13/14/16/20 px, weights 440/530/670, line heights 130/150/180%), nothing is under 13 px, and information text keeps 4.5:1 contrast in both themes. The type rules are in CLAUDE.md, with a test that fails on hand-typed sizes. No migration.

## Fixed · #122 · The removed claude_code provider can no longer be picked for a model

`POST /api/models` and `PATCH /api/models/:id` with `provider: "claude_code"` now return 400 ("provider claude_code was removed (0018): existing rows stay readable, but new or edited models cannot select it") and write nothing. Existing legacy rows still list in Settings → Models and can be renamed; how they behave when run is unchanged. No migration.

## Fixed · #121 · A task can no longer be put in Running by hand

`POST /api/cards` and `PATCH /api/cards/:id` with `status: "running"` now return 400 with the reason ("Running is set by the dispatcher when a run starts"), instead of leaving the task stuck in Running with no run. Dropping a card on the Running column shows that reason in the banner; in the task window, Running is greyed out as "Running (starts with a run)" unless the task is already running.

## Fixed · Mac app: in a narrow window (900 px or less) the header starts after the traffic lights

The window buttons covered the menu button and the title.

## Added · #103 · You can show agents pictures, and agents can look at them

Paste, drop or attach images in every composer; read_file and web_fetch of an image return the picture to the model (Anthropic, ChatGPT and OpenAI-compatible models), with thumbnails and a full-size view.

## Changed · #108 · The memory review writes in your language

It reads your latest messages and writes new and updated memories in the language you use.

## Fixed · A git error while saving a snapshot no longer crashes the engine

## Changed · #107 · The task side panel shows the whole task, like the task window

## Added · #105 · End-to-end tests run the real engine and the built UI with a scripted model

Playwright tests for the slash commands (popup, /clear, /compact, rewind, restart), extended in #100.

## Fixed · Claude 4.6 and newer models show their thinking again

Their thinking was stored empty; Atlas now asks every Claude 4.6+ model for summarized thinking.

## Changed · #102 · The chat box starts at four lines and grows with your text

Up to 40% of the window, then it scrolls inside; it shrinks back after sending.

## Fixed · #99 · /compact during a run no longer restarts the job that was stopped

## Added · #99 · Slash commands in the chat box: /clear and /compact

/clear folds the conversation so far (with Undo), /compact [focus] writes a summary now.

## Changed · #101 · Plan and local models are added from Settings → Model list

## Added · Developer scripts: responsive UI check, voice orb check and request dumps

## Added · #96 · An agent can write to any other agent and get the answer back

## Changed · The test suite is split: npm test runs the fast tests in about 10 seconds
