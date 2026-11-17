# Atlas end-to-end tests (Playwright)

Real engine (in-process, temp SQLite dir) + the **built UI** (`packages/ui/dist`) + a **scripted model** (`harness/scripted.ts`,
records every request so tests can assert what the agent was sent). Headless Chromium drives the UI like a user.
Every feature is run on both surfaces: a direct chat and a task chat (ticket modal).

    npm ci && npm run build            # repo root: build the UI once (and after UI changes)
    cd e2e && npm i && npx playwright install chromium
    npx playwright test                # all;  npx playwright test slash-clear  # one file

Use a checkout path without spaces (native modules fail to build in "Application Support").

Specs: `slash-popup` (#99 step 1), `slash-compact` (2), `slash-clear` (3), `slash-running` (4), `slash-rewind` (5), `slash-restart` (6).
`harness/conv.ts` = page object for one conversation (composer, popup, rows, toast); `harness/fixtures.ts` = `atlas` + `openSurface`.
Tests marked `test.fail()` document a known bug: they go red when it is fixed, then remove the line.
