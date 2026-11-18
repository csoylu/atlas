# Atlas end-to-end tests (Playwright)

Real engine (in-process, temp SQLite dir) + the **built UI** (`packages/ui/dist`) + a **scripted model** (`harness/scripted.ts`,
records every request so tests can assert what the agent was sent). Headless Chromium drives the UI like a user.
Every feature is run on both surfaces: a direct chat and a task chat (ticket modal).

    npm ci && npm run build            # repo root: build the UI once (and after UI changes)
    cd e2e && npm i && npx playwright install chromium
    npx playwright test                # all;  npx playwright test slash-clear  # one file

If Chromium isn't installed, use Google Chrome: `E2E_CHANNEL=chrome npx playwright test`.
Use a checkout path without spaces (native modules fail to build in "Application Support").

Specs: `slash-popup` (#99 step 1), `slash-compact` (2), `slash-clear` (3), `slash-running` (4), `slash-rewind` (5), `slash-restart` (6).
`updater` (#124): the update badge, notes dialog and Settings → About at 1440 and 390 px, dark and light (screenshots in `shots/updater/`), and an update clicked while two agents work (fake GitHub + fake Atlas.app from `packages/engine/test/updaterKit.ts`; Mac only).
`task-prs` (#189): a task linked to its PR on the board: In review with « PR #41 » and its reviewer, CI green → the reviewer's run, failed validation → Ready with the reason, merged → Done (fake GitHub reader, screenshots in `shots/task-prs/`).
`secrets`, `secrets-server`, `secrets-leaks` (#210): Settings → Secrets, an agent's shell and the chat pill, the server's lock (locked → unlock → Lock now), and a leak audit with canary values (`harness/leaks.ts`: SQLite + WAL, every file, logs, API, WebSocket, model requests, snapshots) with the redactor's known limits pinned (`docs/qa/210-secrets-leak-audit.md`). `harness/secrets.ts` = the `w` fixture (desktop store, leak audit after each test).
`harness/conv.ts` = page object for one conversation (composer, popup, rows, toast); `harness/fixtures.ts` = `atlas` + `openSurface`.
A test marked `test.fail()` documents a known bug: it goes red when the bug is fixed, then remove the line (right now: the long unbroken word in the update notes, `updater.spec.ts`, #163).
