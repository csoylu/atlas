# Atlas — instructions for Claude

A personal agent harness: several named agents, each with its own model, tools and memory, working off a shared
kanban board, on a schedule, with shared artifacts. One human user, who gives their name and a short description on
first launch (Settings → About you). Full design: `docs/design.md`. Read it before any structural change.

## Stack (decided)
- TypeScript everywhere, strict mode, ESM. Node 24+.
- Engine: one Node process (`packages/engine`). Interface: React + Vite (`packages/ui`). Desktop: Electron (`apps/desktop`)
  wraps both. Server mode: the same engine on a VPS, UI opened in a browser.
- SQLite (`better-sqlite3`, WAL mode) is the single source of truth. No second store, no JSON state files.
- Artifacts (#120, 18 Nov 2026): markdown, html, svg and url files in an agent's workspace, versioned, grouped in flat
  Library folders. They replaced canvases and whiteboards (migration 0041; old canvases were converted to html pages
  in the « Canvases » folder). No board, no x/y nodes: don't bring a canvas or whiteboard back without asking.
- Models: Anthropic Messages API (API key), any OpenAI-compatible endpoint (llama.cpp, Ollama,
  LM Studio) for local models.

## Layout
```
packages/engine   agent loop, tools, providers, scheduler, dispatcher, kanban, store (SQLite), HTTP + WebSocket API
packages/ui       React app: chat, board, Library (artifacts), schedules, settings, logs
packages/shared   types and zod schemas shared by engine and UI (API contract)
apps/desktop      Electron main process: opens the UI window. Dev: loads Vite (:5173), engine runs under system Node.
                  In-process engine (better-sqlite3 rebuilt for Electron) comes with packaging.
```

## Rules
1. **Keep it small.** Pick the simplest thing that works. No plugin system, no abstraction layer, no config option
   until a second real use needs it. A feature that doesn't work reliably is removed, not left half-working.
2. **Every state change is a SQLite transaction.** Nothing important lives only in memory. Killing the process at any
   instant and restarting must resume every agent, run and schedule (see design §6). Test it.
3. **Fail loudly.** A missing model, an expired login, an unknown tool: the run stops with a clear error on the card
   and in the UI, never a silent fallback. No `catch {}` that swallows an error.
4. **Migrations only** for schema changes (`packages/engine/src/store/migrations/NNNN_name.sql`), never edit an
   applied one.
5. **Secrets** live in the OS keychain (Electron `safeStorage`) or env vars on the server, never in SQLite, logs,
   transcripts or the UI.
6. **Tests:** `vitest`. Every engine module has tests; the restart test (rule 2) and the agent-loop test with a fake
   provider must stay green. `npm run typecheck && npm test` before every commit (`npm test` = fast project, ~10 s; `npm run test:full` also runs the slow project: real voice models + the 50-SIGKILL crash test, `CRASH_KILLS=n` shortens it. Run it when you touch voice, the store, runs or leases).
7. Shared types go in `packages/shared`; the UI never imports engine code directly, only the API.

## UI type rules
Same scale as OpenCode (packages/ui/src/styles/theme.css). Enforced by `packages/ui/src/typeRules.test.ts` and ui-check.
- **Tokens** (styles.css, the « type tokens » block): sizes `--fs-small` 13, `--fs-base` 14, `--fs-large` 16, `--fs-xl` 20 px;
  weights `--fw-regular` 440, `--fw-medium` 530, `--fw-bold` 670; line heights `--lh-tight` 130% (one-line labels),
  `--lh-normal` 150%, `--lh-long` 180% (chat messages, descriptions, documents). Families: `--font`, `--mono`.
  Mono text uses the same size tokens.
- **No literal** font-family, font-size, font-weight or line-height in CSS or in inline styles: always a token. Need a
  fifth size? Ask first, don't add one.
- **No text under 13 px.** Allowed exceptions, each marked `/* type-exception: why */` on its line: inputs at 16 px on
  phone (iOS zooms in below 16), and a letter inside a tile too small for 13 px (aria-hidden).
- **Contrast:** text colours that carry information reach 4.5:1 on `--app`, `--panel` and `--raised` in both themes
  (`--faint` is the floor). Placeholders and disabled text may be lower.
- **@font-face** only through the fontsource imports in `main.tsx`.

## Commands
```
cp .env.example .env   # model keys (gitignored); see .env.example
npm install
npm run dev          # engine + UI with hot reload, opens http://localhost:5173
npm run desktop      # Electron app in dev
npm run typecheck && npm test   # fast suite; test:full adds slow suites, test:changed only what your diff affects
npm -w @atlas/desktop run install:mac   # manual build from source into /Applications (agents: never, see Releases)
npm run ui:check     # responsive check of the real UI (below)
node scripts/orb-check/check.mjs   # voice orb overlay: screenshots of every state, frame times, CPU, Esc, click-through, drag (→ shots/orb)
```

**Responsive check** (`scripts/ui-check/check.mjs`, macOS: needs Google Chrome and Xcode's `swiftc`). Opens the running
Atlas app's UI in headless Chrome at 1440 / 1100 / 900 / 390 px (390 = phone, touch) on every main screen: chat with
pins, ticket modal, side panel, board, inbox, Library (list with tiles, search, a doc, its version picker), schedules, every settings page. It reports page-wide horizontal overflow (and
the phone zoom-out it causes), text under 12px, text off-screen outside a scroller, pins or chat buttons covering
messages or the composer, the modal or panel off-screen, uncaught page errors, and key labels that Apple Vision OCR
(`ocr.swift`) can't read at confidence ≥ 0.5. Exit code 1 on any issue; screenshots + `report.json` in
`/tmp/…/atlas-ui-check` (`--out DIR`).
- The engine port is read from the running app (`lsof`; it changes on every start), or `--port N`.
- Read-only: the harness refuses every API write from the page. Pins and the panel come from fixtures added to the
  responses the page sees (4 cards in every pin state, a real document in a panel tab); nothing is stored.
- `--ui packages/ui/dist` tests a local build (`npm -w @atlas/ui run build`) against the same engine, before reinstalling.
- `--widths 390`, `--only chat,modal` (screen-name prefixes) to narrow a run; a full run takes ~75 s.
- Run it after any UI layout change; the acceptance bar is « no issues » at all widths.

**Screenshot tool** (#133, `packages/engine/src/screenshot.ts`): agents have a built-in `screenshot` tool, one picture
of a route (`#/board`) or a workspace page (`pages/x.html`, `/api/files/<agent>/…`) at a width/height and theme, with
optional `clip`, `full_page`, `wait_for` and `actions` (click, type, press). It runs a fresh headless Chrome against the
engine it runs in (no port lookup), refuses every write from the page (the main-chat lookup gets a read-only answer),
fails after 15 s naming what never appeared, and returns page errors + refused writes with the picture (saved under
`screenshots/`). Unit tests: `screenshot.test.ts` (fast); real Chrome: `test/screenshot.chrome.test.ts` (slow project).

## Releases (#123, docs/updater.md)
- **One push to main = one CHANGELOG.md entry = one release.** Whoever pushes to main adds exactly one entry at the
  top: `## Fixed|Added|Changed|Breaking · #task · One plain sentence for Master`, then optional details. The version
  is computed from the entries (`node scripts/release/changelog.mjs version`; Fixed → patch, Added/Changed → minor,
  Breaking → major): never type a number. CI (`.github/workflows/ci.yml`) refuses a push to main without exactly one
  new top entry, runs the tests, builds the Mac app (arm64 + x64 zip and dmg, SHA256SUMS.txt), tags `v<version>` and
  publishes the GitHub release with that entry as its notes. No release when tests fail.
- **Every change reaches main through a pull request** (Master, 18 Nov 2026): no direct push to main, for anyone, docs
  included. Work goes to a branch (`<type>/<task number>-<slug>`), then a PR whose base is main (check a stacked PR's
  base before merging). One merged PR = one push to main = one changelog entry = one release. main refuses
  force-pushes and deletion (GitHub branch protection).
- **Agents never install the app.** No `install:mac`: Master's Atlas shows "Update available" and installs on
  Master's click (it restarts; running tasks resume). `install:mac` stays for a manual build from source.
- **Testing without installing:**
  - UI: `npm run build`, then `npm run ui:check -- --ui packages/ui/dist` (the local build against the running engine,
    read-only), or screenshots of a second engine (below).
  - Engine: a second engine on a copy of the database, never the live one: `sqlite3 <data>/atlas.db ".backup /tmp/x/atlas.db"`,
    then `startEngine({ dbFile: '/tmp/x/atlas.db', dataDir: '/tmp/x', port: 4388, dispatch: false, env: {}, uiDir: 'packages/ui/dist' })`
    (`dispatch: false` so it starts no runs and no schedules).
  - E2E: `e2e/` (Playwright, scripted model) on a local build.
