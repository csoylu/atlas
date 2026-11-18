# Changelog

Newest on top. One entry per push to main (see docs/updater.md).

## Changed · #120 · Artifacts replace canvases

Canvases, nodes and whiteboards are gone. Agents now make artifacts: markdown documents, html pages, svg diagrams and links, each a versioned file (artifact_create, artifact_update, artifact_list, artifact_read). In the chat an artifact is a card that says its kind and version ("Updated to v3", "v4 is the latest") and opens that version. The viewer has one header row: tabs, a version picker (with "Restore vN"), Latest, Full size and a ⋯ menu (author, folder, path, source, open in the browser or the Library). The Library has flat folders (rename, delete moves items to Unfiled), "Recently modified" tiles that show the real content, pinned items on top, and search across titles and content. Existing canvases are converted once to html pages in a "Canvases" folder (migration 0041; the old table is kept as an archive).

## Fixed · #122 · The removed claude_code provider can no longer be picked for a model

`POST /api/models` and `PATCH /api/models/:id` with `provider: "claude_code"` now return 400 ("provider claude_code was removed (0018): existing rows stay readable, but new or edited models cannot select it") and write nothing. Existing legacy rows still list in Settings → Models and can be renamed; how they behave when run is unchanged. No migration.

## Fixed · #121 · A task can no longer be put in Running by hand

`POST /api/cards` and `PATCH /api/cards/:id` with `status: "running"` now return 400 with the reason ("Running is set by the dispatcher when a run starts"), instead of leaving the task stuck in Running with no run. Dropping a card on the Running column shows that reason in the banner; in the task window, Running is greyed out as "Running (starts with a run)" unless the task is already running.
