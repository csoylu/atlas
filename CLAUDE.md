# Atlas — instructions for Claude

A personal agent harness: several named agents, each with its own model, tools and memory, working off a shared
kanban board, on a schedule, with a shared canvas. One user (Can). It replaces Hermes Agent for his Datinel team
(lead atlas, engineers munih and paris, QA zurich). Full design: `docs/design.md`. Read it before any structural change.

## Stack (decided)
- TypeScript everywhere, strict mode, ESM. Node 24+.
- Engine: one Node process (`packages/engine`). Interface: React + Vite (`packages/ui`). Desktop: Electron (`apps/desktop`)
  wraps both. Server mode: the same engine on a VPS, UI opened in a browser.
- SQLite (`better-sqlite3`, WAL mode) is the single source of truth. No second store, no JSON state files.
- Canvas: the `@excalidraw/excalidraw` component, embedded, not reimplemented.
- Models: Anthropic Messages API (API key), any OpenAI-compatible endpoint (llama.cpp, Ollama,
  LM Studio) for local models.

## Layout
```
packages/engine   agent loop, tools, providers, scheduler, dispatcher, kanban, store (SQLite), HTTP + WebSocket API
packages/ui       React app: chat, board, canvas, schedules, settings, logs
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
   provider must stay green. `npm run typecheck && npm test` before every commit.
7. Shared types go in `packages/shared`; the UI never imports engine code directly, only the API.

## Commands
```
cp .env.example .env   # model keys (gitignored); see .env.example
npm install
npm run dev          # engine + UI with hot reload, opens http://localhost:5173
npm run desktop      # Electron app in dev
npm run typecheck && npm test
npm -w @atlas/desktop run install:mac   # build the Mac app and install it in /Applications (quits the running one)
```

**After every change that ships** (pushed to main and touching the engine, UI or desktop app): run
`npm -w @atlas/desktop run install:mac` so Can's /Applications/Atlas.app is always the latest. Can asked for this
(10 Nov 2026). It quits a running Atlas; say so in the report.
