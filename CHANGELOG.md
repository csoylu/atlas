# Changelog

Newest on top. One entry per push to main (see docs/updater.md).

## Fixed · #122 · The removed claude_code provider can no longer be picked for a model

`POST /api/models` and `PATCH /api/models/:id` with `provider: "claude_code"` now return 400 ("provider claude_code was removed (0018): existing rows stay readable, but new or edited models cannot select it") and write nothing. Existing legacy rows still list in Settings → Models and can be renamed; how they behave when run is unchanged. No migration.

## Fixed · #121 · A task can no longer be put in Running by hand

`POST /api/cards` and `PATCH /api/cards/:id` with `status: "running"` now return 400 with the reason ("Running is set by the dispatcher when a run starts"), instead of leaving the task stuck in Running with no run. Dropping a card on the Running column shows that reason in the banner; in the task window, Running is greyed out as "Running (starts with a run)" unless the task is already running.
