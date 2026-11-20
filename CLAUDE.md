# Atlas — instructions for Claude

A personal agent harness: named agents, each with its own model, tools and memory, working off a shared kanban board,
on schedules, with shared artifacts. One human user (name and description in Settings → About you).
Full design: `docs/design.md`: read it before any structural change.

**Read before you do it** (reference moved out of this file, #295; every rule there still holds):
- UI work (type rules, ui-check, screenshot tool, UI how-tos): `docs/ui.md`
- Writing or running tests, testing without installing: `docs/testing.md`
- Changelog entry, PR, review, merge, CI, releases: `docs/releases.md` (updater: `docs/updater.md`)
- Shell environment, **sandbox** (what agent commands can reach, `GH_TOKEN`, how to tell a denial from a bug), clones,
  worktrees, files: `docs/howtos.md`

## Stack (decided)
- TypeScript everywhere, strict mode, ESM. Node 24+.
- Engine: one Node process (`packages/engine`). UI: React + Vite (`packages/ui`). Desktop: Electron (`apps/desktop`)
  wraps both. Server mode: the same engine on a VPS, UI in a browser.
- SQLite (`better-sqlite3`, WAL) is the single source of truth. No second store, no JSON state files.
- Artifacts (#120): markdown, html, svg and url files in an agent's workspace, versioned, in flat Library folders. They
  replaced canvases and whiteboards (migration 0041; old canvases became html pages in the « Canvases » folder). No
  board, no x/y nodes: don't bring a canvas or whiteboard back without asking.
- Models: Anthropic Messages API, any OpenAI-compatible endpoint (llama.cpp, Ollama, LM Studio) for local models.

## Layout
```
packages/engine   agent loop, tools, providers, scheduler, dispatcher, kanban, store (SQLite), HTTP + WebSocket API
packages/ui       React app: chat, board, Library (artifacts), schedules, settings, logs
packages/shared   types and zod schemas shared by engine and UI (API contract)
apps/desktop      Electron main process. Dev: loads Vite (:5173), engine under system Node.
```

## Rules
1. **Keep it small.** The simplest thing that works. No plugin system, abstraction layer or config option until a
   second real use needs it. A feature that doesn't work reliably is removed, not left half-working.
2. **Every state change is a SQLite transaction.** Nothing important lives only in memory. Killing the process at any
   instant and restarting must resume every agent, run and schedule (design §6). Test it.
3. **Fail loudly.** A missing model, an expired login, an unknown tool: the run stops with a clear error on the card
   and in the UI, never a silent fallback. No `catch {}` that swallows an error.
4. **Migrations only** for schema changes (`packages/engine/src/store/migrations/NNNN_name.sql`), never edit an
   applied one; a new one is numbered above every one on main.
5. **Secrets** (model keys, agent secrets): values in the OS keychain (Electron `safeStorage`) or server env vars, never
   in SQLite, logs, transcripts, the UI or an API response; SQLite keeps only metadata (table `secrets`). Agents get
   only secrets granted to them, as env vars of their shell commands, never a model key; every tool output passes the
   redactor (`Secrets.redact`) before it is stored or sent to a model. Never spawn an agent command or store a tool
   output around those two (design §10b). Never spawn with `process.env`: take `ctx.env()`.
   Agent commands are spawned only by `spawnAgentCommand` (`sandbox.ts`, #298; Seatbelt with `ATLAS_SANDBOX=1`, fail
   closed); a test refuses any other `shell: true` spawn.
6. **Tests:** `vitest`. Every engine module has tests; the restart test and the agent-loop test with a fake provider
   stay green. `npm run typecheck && npm test` before every commit; `npm run test:full` when you touch voice, the
   store, runs or leases (voice suites run only locally: state the result in the review summary). No sleep loops:
   use the kit (`docs/testing.md`).
7. Shared types go in `packages/shared`; the UI never imports engine code, only the API.
8. **UI type:** only the type tokens (sizes 13/14/16/20, weights 440/530/670, line heights 130/150/180%), no literal
   font values, no text under 13 px, 4.5:1 contrast for information text in both themes. Details: `docs/ui.md`.

## Commands
```
npm ci               # never npm install (it breaks the lockfile's native bindings)
npm run dev          # engine + UI with hot reload, http://localhost:5173
npm run typecheck && npm test   # fast suite; test:full adds slow suites, test:changed only what your diff affects
npm run ui:check     # responsive check of the real UI on a throwaway engine (docs/ui.md): after any UI layout change, never for engine/docs only
# Master only (a real window or /Applications; not available in the sandbox): npm run desktop, orb-check, install:mac
```

## Releases and review (full flow: `docs/releases.md`)
- **Every change reaches main through a PR** from a branch `<type>/<task number>-<slug>`, base main. No direct push.
- **One PR = one changelog entry = one release.** Each PR adds exactly one new file `changelog/<task>-<slug>.md`,
  first line `## Fixed|Added|Changed|Breaking · #task · One plain sentence for Master`, and changes no other
  changelog file. Never type a version number.
- **Merge only after QA validation** (commit status `qa/validated`, plus green CI `test`). Push, open the PR, then end
  your run with `task_request_review` (not `task_complete`). Merged → Done; CI red, conflict or failed validation →
  back to you with the reason: fix, push, `task_request_review` again. One PR per task.
- **Agents never install the app** (no `install:mac`, it is Master's): Master installs updates.
- Project how-tos go in `docs/howtos.md` (or the doc of their topic) through a PR, never in agent memory.
