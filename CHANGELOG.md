# Changelog

Newest on top. One push to main = one entry = one release (docs/updater.md). Each entry is a heading
`## Kind · #task · One plain sentence`, then optional details. The kind sets the version (Semantic Versioning,
computed by `scripts/release/changelog.mjs` from the oldest entry to the newest, starting at 0.3.0 = v3, cad983f):
`Fixed` → patch, `Added` or `Changed` → minor, `Breaking` (data or settings stop working without action) → major.
Never type a version number.

## Added · #148 · `npm run ui:check:fast` runs the UI check at the four widths in parallel (about 80 s instead of 3 min)

`scripts/ui-check/parallel.mjs` starts one `check.mjs` per width (1440, 1100, 900, 390), each with its own Chrome and output folder, and exits 1 if any width reports an issue. Same flags as `ui:check`, except `--widths` and `--out`. Test tooling only: no change in the app.

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
