# Changelog

Newest on top. One entry per push to main (see docs/updater.md).

## Changed · #112 · Bigger, calmer look: new type scale, agent faces, status chips

The approved #104 v2 visual pass is now on main (it was finished on a branch and missing from the 01:44 build). Type and rows are bigger, agents have faces in the sidebar, task states show as chips and pinned tasks have coloured edges. All text goes through four size tokens (13/14/16/20 px, weights 440/530/670, line heights 130/150/180%), nothing is under 13 px, and information text keeps 4.5:1 contrast in both themes. The type rules are in CLAUDE.md, with a test that fails on hand-typed sizes. No migration.

## Fixed · #122 · The removed claude_code provider can no longer be picked for a model

`POST /api/models` and `PATCH /api/models/:id` with `provider: "claude_code"` now return 400 ("provider claude_code was removed (0018): existing rows stay readable, but new or edited models cannot select it") and write nothing. Existing legacy rows still list in Settings → Models and can be renamed; how they behave when run is unchanged. No migration.

## Fixed · #121 · A task can no longer be put in Running by hand

`POST /api/cards` and `PATCH /api/cards/:id` with `status: "running"` now return 400 with the reason ("Running is set by the dispatcher when a run starts"), instead of leaving the task stuck in Running with no run. Dropping a card on the Running column shows that reason in the banner; in the task window, Running is greyed out as "Running (starts with a run)" unless the task is already running.
