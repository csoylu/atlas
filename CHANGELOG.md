# Changelog

Newest on top. One push to main = one entry = one release (docs/updater.md). Each entry is a heading
`## Kind · #task · One plain sentence`, then optional details. The kind sets the version (Semantic Versioning,
computed by `scripts/release/changelog.mjs` from the oldest entry to the newest, starting at 0.3.0 = v3, cad983f):
`Fixed` → patch, `Added` or `Changed` → minor, `Breaking` (data or settings stop working without action) → major.
Never type a version number.

## Changed · #120 · Artifacts replace canvases

Canvases, nodes and whiteboards are gone. Agents now make artifacts: markdown documents, html pages, svg diagrams and links, each a versioned file (artifact_create, artifact_update, artifact_list, artifact_read). In the chat an artifact is a card that says its kind and version ("Updated to v3", "v4 is the latest") and opens that version. The viewer has one header row: tabs, a version picker (with "Restore vN"), Latest, Full size and a ⋯ menu (author, folder, path, source, open in the browser or the Library). The Library has flat folders (rename, delete moves items to Unfiled), "Recently modified" tiles that show the real content, pinned items on top, and search across titles and content. Existing canvases are converted once to html pages in a "Canvases" folder (migration 0041; the old table is kept as an archive). Converted canvases start at v1: their old version history stays only in the archived tables.

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
