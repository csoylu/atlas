# Changelog

Newest on top. One entry per push to main (see docs/updater.md).

## Added · #119 · Images in tasks: paste, drop or attach them in the New task dialog and a task's description

A task can now carry up to 5 images (png, jpeg, gif or webp, 10 MB each), pasted (Cmd+V), dropped or attached with the image button. They show as thumbnails under the description in the New task dialog, the task window and the thread side panel. Click one to see it full size; × removes it. Pasting text still pastes text. A refused file says why, and nothing is stored. The assignee sees the task's images as pictures from the first turn of every run, and also gets their files in its workspace. This holds for a task assigned later or reassigned, and a removed image is gone from the next turn. Images cancelled in the New task dialog leave nothing behind. Migration 0040 (`cards.images`); the files are in `<data>/task-images/`.

## Changed · #112 · Bigger, calmer look: new type scale, agent faces, status chips

The approved #104 v2 visual pass is now on main (it was finished on a branch and missing from the 01:44 build). Type and rows are bigger, agents have faces in the sidebar, task states show as chips and pinned tasks have coloured edges. All text goes through four size tokens (13/14/16/20 px, weights 440/530/670, line heights 130/150/180%), nothing is under 13 px, and information text keeps 4.5:1 contrast in both themes. The type rules are in CLAUDE.md, with a test that fails on hand-typed sizes. No migration.

## Fixed · #122 · The removed claude_code provider can no longer be picked for a model

`POST /api/models` and `PATCH /api/models/:id` with `provider: "claude_code"` now return 400 ("provider claude_code was removed (0018): existing rows stay readable, but new or edited models cannot select it") and write nothing. Existing legacy rows still list in Settings → Models and can be renamed; how they behave when run is unchanged. No migration.

## Fixed · #121 · A task can no longer be put in Running by hand

`POST /api/cards` and `PATCH /api/cards/:id` with `status: "running"` now return 400 with the reason ("Running is set by the dispatcher when a run starts"), instead of leaving the task stuck in Running with no run. Dropping a card on the Running column shows that reason in the banner; in the task window, Running is greyed out as "Running (starts with a run)" unless the task is already running.
