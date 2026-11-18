# Changelog

Newest on top. One push to main = one entry = one release (docs/updater.md). Each entry is a heading
`## Kind · #task · One plain sentence`, then optional details. The kind sets the version (Semantic Versioning,
computed by `scripts/release/changelog.mjs` from the oldest entry to the newest, starting at 0.3.0 = v3, cad983f):
`Fixed` → patch, `Added` or `Changed` → minor, `Breaking` (data or settings stop working without action) → major.
Never type a version number.

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
