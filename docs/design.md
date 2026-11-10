# Atlas — design

Status: proposal, 9 Nov 2026. Owner: Can. Written by atlas from a week of running the Datinel team on Hermes Agent.

## 1. Goal
One app where Can's agents work like a small team:
- **Agents**: named (atlas, munih, paris, zurich…), each with a role prompt, a model, a tool set, a working
  directory and a memory.
- **Kanban** board: the only task tracker. Cards are assigned to agents, run automatically, block on questions,
  go to review, finish with a handoff.
- **Schedules**: run an agent prompt or create a card at a time or on a cron expression.
- **Canvas**: an Excalidraw whiteboard that Can and agents both read and write (diagrams, plans, mockups).
- **Models**: Anthropic (cloud) and local LLMs (OpenAI-compatible server), chosen per agent and per card.
- **Chat**: talk to any agent directly; agents message each other.
- Runs as a Mac/Windows Electron app, or as a server on a VPS opened in a browser.

Non-goals for v1: multi-user, plugin marketplace, mobile app, voice, a skill store. Telegram comes after v1 (§13).

## 2. Architecture
```
 Electron window / browser
        │  HTTP (REST) + one WebSocket (events)
 ┌──────▼─────────────────────────────────────────────┐
 │ engine (one Node process)                          │
 │  api ── dispatcher ── runner(s) ── agent loop      │
 │           │              │            │            │
 │        scheduler      tools       providers        │
 │           └──────────┬───┴────────────┘            │
 │                   store (SQLite, WAL)              │
 └────────────────────────────────────────────────────┘
```
- One process, one database. Agents are **rows**, not separate processes with their own state. A run executes in
  the engine's event loop. Tools that block (shell, heavy file work) run in a child process or a worker thread.
- Desktop mode: Electron's main process starts the engine in-process and loads the UI. Server mode:
  `node engine` serves the built UI and listens on localhost behind a reverse proxy with auth (§12).
- The UI holds no state of its own beyond the view: it reads through the API and updates from WebSocket events.

## 3. Data model (SQLite)
| Table | Key columns |
|---|---|
| `agents` | id, name, role_prompt, model_ref, tools (json), workdir, enabled |
| `models` | id, provider (`anthropic`/`openai_compat`), name, base_url, credential_ref, context_window, verified_at, last_error |
| `credentials` | id, provider, label, kind (`api_key`/`oauth`), secret_ref (keychain key, not the secret), expires_at, cooldown_until, usage (json) |
| `cards` | id, board, title, body, status, assignee (agent id), priority, model_override, workdir, created_by, created_at |
| `card_links` | parent_id, child_id |
| `card_events` | id, card_id, at, kind, payload (json): status changes, comments, blocks, answers, handoffs |
| `runs` | id, card_id or chat_id or schedule_id, agent_id, status (`queued`/`running`/`waiting`/`done`/`failed`/`interrupted`), lease_until, attempt, error, started_at, ended_at |
| `messages` | id, conversation_id, seq, role, content (json blocks), tokens, at — the full transcript, append-only |
| `conversations` | id, agent_id, kind (`chat`/`card`/`schedule`), summary, summary_upto_seq |
| `tool_calls` | id, run_id, tool_use_id, name, input, status, output_ref, started_at, ended_at |
| `schedules` | id, agent_id, cron or at, prompt or card_template, timezone, next_run_at, last_run_id, enabled |
| `memory` | id, agent_id or `shared`, text, updated_at |
| `canvases` | id, name, scene (json), version, updated_by, updated_at |
| `notifications` | id, kind, card_id, text, delivered_at |

Large tool outputs and files go to `data/blobs/<sha256>`; tables keep the reference.

## 4. Agent loop
```
loop:
  context = build_context(conversation)          # §8
  response = provider.stream(model, context, tools)
  append assistant message (one transaction)
  if no tool_use: finish run
  for each tool_use:
     record tool_call(status=running)            # before executing
     output = execute(tool, input)               # with timeout + abort signal
     record tool_call(status=done, output)       # and append tool_result message
  check: abort requested? budget exceeded? → stop cleanly
```
- Streaming to the UI over WebSocket; the stored message is written once the block completes.
- Limits per run: max turns, max tokens, max wall time. Hitting one ends the run as `waiting` with a note, never
  silently.
- Independent tool calls in one response may run in parallel.
- A card run ends only through a tool: `card_complete(summary)`, `card_block(kind, question)`,
  `card_request_review(summary)`. A run that stops without one → card back to `ready` with the last output as a
  comment, and the attempt counts.

## 5. Providers and credentials
One provider interface; direct API implementations plus subscription adapters:
- **Anthropic** Messages API: tool use, prompt caching (cache the system prompt and the stable prefix), extended
  thinking when the model supports it. Auth by API key, or the Claude plan through Atlas's own approved OAuth client (see below).
- **OpenAI-compatible** `/v1/chat/completions` with tools: llama.cpp server, Ollama, LM Studio, vLLM. Base URL + model
  name + optional key.

Rules:
- **Validate models.** Saving a model runs a 1-token test call; the result goes in `verified_at` / `last_error` and
  shows in Settings. Every run checks again if the last check is older than 10 min or failed. A model that doesn't
  answer blocks the run with « model X at Y is not reachable », never a fallback to another model.
- **Credential pool per provider.** Ordered list. On 429 or quota: set `cooldown_until` from the reset header, move to
  the next credential, retry. When all are cooling down, the run goes `waiting` until the earliest reset and the card
  shows that time.
- **OAuth refresh ahead of expiry** (at 80 % of the lifetime) in the scheduler, and on any 401 once. If refresh fails:
  every card on that credential shows « re-login needed » with a button; no run is marked failed for it.
- Usage (tokens, cost estimate, account) recorded per run and per credential, shown in Settings.

### Anthropic accounts (built 10 Nov 2026, `engine/src/accounts.ts`, Agents page « Anthropic accounts »)
Several API keys in priority order. Anthropic models without their own `credential_env` use them (migration 0012 moved
the seeded `sonnet` off `ANTHROPIC_API_KEY`; that key becomes the first account « Default »). A call goes to the
first enabled account with a key that isn't cooling down; 429 (until the reset/retry-after Anthropic sends), 401/403
(30 min), billing/credit errors (1 h) and 5xx/overloaded (30 s) cool that account and the same call moves to the
next. A call that already streamed text, or a request the API rejects (400), is never replayed elsewhere. Every
response's `anthropic-ratelimit-*` headers are stored per account (shown as requests/input/output per minute left),
tokens are counted per account and day. Keys: desktop keychain (`ANTHROPIC_KEY_<id>`), server env (name only).
### Claude plan (built 11 Nov 2026, `engine/src/claude-plan.ts`, Models page « Claude plan »)
Can asked for his Claude subscription in Atlas and said (10 Nov 2026) he has Anthropic's permission. Anthropic's
[credential use policy](https://code.claude.com/docs/en/legal-and-compliance) forbids third-party apps from offering
Claude.ai login or routing requests through plan credentials *without* that authorization, so the integration is built
for an **approved, registered Atlas client** and nothing else:
- Every connection detail comes from Anthropic's approval and is a placeholder until Can fills it in on the Models
  page (keychain entries) or in `.env` on a server: `ATLAS_CLAUDE_CLIENT_ID`, `_CLIENT_SECRET` (optional),
  `_AUTHORIZE_URL`, `_TOKEN_URL`, `_REVOKE_URL` (optional), `_SCOPES`, `_REDIRECT_PORT` (if the redirect URI is
  registered with a fixed port; default any loopback port, RFC 8252), `_API_BASE` (default api.anthropic.com),
  `_HEADERS` (JSON, only headers the approval names). Read live from the engine env: no restart after a change.
- Atlas identifies as itself. It refuses Claude Code's client id (`9d1c250a-…`), refuses headers that name Claude
  Code or that Atlas sets itself (user-agent, x-app, authorization…), and never rewrites the system prompt or tool
  names. This is the line between an approved app and the Hermes approach (borrowed Claude Code identity + renames to
  slip past Anthropic's third-party check), which Atlas does not copy.
- Flow: authorization code + PKCE (S256) with a loopback callback on 127.0.0.1, state checked, token exchange as a
  form POST. Tokens in the keychain (`CLAUDE_TOKENS`, never in SQLite, env, the secrets list or the API); refreshed
  5 min before expiry, one refresh at a time; a dead refresh (`invalid_grant`…) or a 401 signs out with the reason.
- Calls: the Anthropic provider with `Authorization: Bearer` (no API key), model provider `claude_plan`. A 429 pauses
  the plan until `retry-after` / the latest `anthropic-ratelimit-*-reset` (else 1 min); the pause ends by itself or
  with Resume. One account, no rotation around limits. Usage is counted like every other source (Usage: « Claude plan »).
- Server engines: unavailable (no keychain for tokens), like the ChatGPT plan.

The legacy `claude_code` CLI provider (migration 0017) stays removed (0018): rows readable, never runnable.

### ChatGPT plan (built 10 Nov 2026, `engine/src/chatgpt.ts` + `providers/chatgpt.ts`, Agents page « ChatGPT plan »)
Can asked for OpenAI usage by subscription login. OpenAI's **Sign in with ChatGPT**
lets open-source, locally hosted apps use a person's ChatGPT plan (developers.openai.com/siwc, « ChatGPT plan
usage »; terms openai.com/policies/sign-in-with-chatgpt-terms). Atlas is free, runs on Can's machine and will be public.
- **Own identity, no borrowed client id.** First sign-in registers Atlas dynamically (`client_id=dynamic_agent_client`,
  `agent_name_hint=Atlas`, this machine's `ext_agent_host_id` = `urn:uuid:…` made once); the callback's issued
  `oaiapp_…` id is saved and reused. (Hermes/opencode's older route logs in with Codex's client id: that would be
  impersonating another app, which the terms forbid.) PKCE + state + nonce, loopback `http://127.0.0.1:<port>/auth/callback`
  opened in the system browser (Electron `window.open` → `shell.openExternal`), ID token verified against OpenAI's
  JWKS (signature, issuer, audience = issued id, expiry, nonce), returning sign-ins must be the same account.
- **Tokens** (access 1 h, rotating refresh 30 d, ID token) live in the keychain as `CHATGPT_TOKENS`, hidden from the
  key list, the engine env and the API. Refresh 5 min before expiry, one at a time; a dead refresh token signs out
  (registration kept). Sign out revokes the refresh token at OpenAI. Desktop only for now: a server engine has no
  keychain, and the terms want tokens in storage the user controls (a self-hosted VM flow exists; not built).
- **Requests**: `POST https://api.openai.com/v1/responses`, bearer token, `store: false`, `stream: true`, system prompt
  in `instructions`, Atlas tools as one `namespace` « atlas » (function calls replayed with `namespace`), no
  `max_output_tokens`/`temperature`. Success only on `response.completed`. Models from `GET /v1/models`
  (visibility « list »), added with « Give to agents » as provider `chatgpt` (migration 0013 rebuilt `models` for the
  new CHECK value; migrations starting `-- atlas: foreign_keys off` run with foreign keys off and are checked first).
- **Terms built in**: one account, no rotation around limits; board cards and schedules use the signed-in
  plan just like direct chats, with no separate background-use opt-in (explicitly authorized by Can, 10 Nov 2026);
  a usage-limit error pauses
  every plan request with « Manage usage » (chatgpt.com/settings/usage) + Resume, never a switch to other billing.
  UI per OpenAI's guidelines: « Continue with ChatGPT » button (`data-oai-siwc-button`), a one-time « You're using your
  ChatGPT plan » notice, « Using ChatGPT plan · Manage usage » by the composer. Missing: OpenAI's official logo on the
  button (add the approved asset when the repo goes public).

### Local models (built 10 Nov 2026, `engine/src/local.ts`, UI page « Models »)
The engine manages **Ollama** on its own machine (Can's choice over bundling llama.cpp: already installed, least new
code). Models come from the **Ollama library only**: Hugging Face search and `hf.co/…` pulls were removed (Can,
10 Nov 2026) and the engine refuses such names with that reason. The UI only asks; the engine acts, so it
works with the window closed and, later, on the VPS for that machine's models.
- Finds the binary in the usual install paths (GUI apps don't get the shell PATH); offers `brew install ollama` when
  Homebrew exists, otherwise links to ollama.com/download.
- Ownership: a server that already answers (Ollama app, `brew services`) is used and left alone ("external"). Otherwise
  the engine runs `ollama serve` itself ("atlas", log in `<data>/logs/ollama.log`), passes `OLLAMA_CONTEXT_LENGTH`
  (setting, default 32k), restarts it after a crash (at most 4 times per 10 min, with back-off) and stops it with the
  engine. Stop on an external brew service stops the service, after which Atlas owns the server.
- Autostart (setting, default on): before every call to a model whose base URL is the managed server, the provider
  wrapper in `Models.provider()` starts the server if it's down; with autostart off the call fails with that reason.
- Downloads by library name (`qwen3:8b`) stream progress over the WebSocket (`local.pull`, summed over layers).
- **Usage** (Can, 10 Nov 2026; `engine/src/usage.ts`, migration 0014): every model call is a `model_usage` row (model,
  source, agent, card, conversation, tokens in/out/cached; no foreign keys so totals outlive deletions). `input` is the
  whole prompt: Anthropic's uncached `input_tokens` + cache reads + cache writes. Chat screens show, above the
  composer, the context fill at the latest answer (prompt / model window; amber past 50 %, red past the 70 %
  compaction point) and the chat's tokens, plus « Using ChatGPT plan · Manage usage » on the plan. The Models page
  starts with « Usage »: 30-day totals, tokens per day stacked by source, per-model today/7/30 days. Tokens only, no
  cost (no price table to keep right); ChatGPT plan quota stays in ChatGPT settings (OpenAI exposes no figure).
- **Model and effort per chat/card** (Can, 10 Nov 2026; migration 0015 `cards.model_id`, `cards.effort`): two quiet
  pickers above the composer. Empty = the agent's model / the model's default effort. Effort low · medium · high ·
  xhigh · max goes to Claude as `output_config.effort`, to the ChatGPT plan as `reasoning.effort`, to Ollama and other
  OpenAI-compatible servers as `reasoning_effort` (xhigh/max → high). Picking doesn't move a chat up the history; a
  deleted picked model makes the next run fail with that reason. The dispatcher checks the card's model when it has one.
- **Models page = where models come from** (Can, 10 Nov 2026): « Available to agents » (every Atlas model), ChatGPT
  plan, Anthropic accounts, then Ollama (server, installed, download). The Agents page keeps agents, their model
  pick and memory.
- « Give to agents » creates an Atlas model (`openai_compat`, `<server>/v1`) for an installed Ollama model; a model in
  use by an Atlas model can't be deleted. `ATLAS_OLLAMA_URL` points the engine at another port.

## 6. Durability: restart never loses or kills work
- A runner claims a run by setting `lease_until = now + 60 s` and renews it every 20 s.
- On engine start (and every 30 s), runs with `status=running` and an expired lease become `interrupted`, then
  `queued` again with the same conversation. **Interruption is not a failure**: it doesn't count toward the retry
  limit and needs no human action.
- Resume rule: the transcript is complete up to the last committed message. A tool call recorded as `running` with no
  result gets a synthetic tool_result « interrupted by a restart, re-run it if still needed » so the model decides. No
  tool is replayed blindly.
- Shell commands run with a stored pid; on restart, the orphan is killed and reported.
- Graceful shutdown: stop claiming, ask runners to finish the current model call or tool, commit, release leases.
- Required test: start 3 runs with a fake provider and a slow fake tool, kill the process at random points 50 times,
  restart, and check every run completes with a consistent transcript.

## 7. Kanban and dispatcher
Statuses: `triage → todo → ready → running → (blocked | review) → done`, plus `archived`.
- `todo` waits on parents; it moves to `ready` when all parents are `done`.
- The dispatcher starts `ready` cards whose assignee has a free slot (default 1 run per agent, configurable).
- **No hidden guards.** If a `ready` card isn't starting, the card shows why, in plain words (agent busy with t_x,
  credential cooling down until 14:05, model unreachable). Every reason is computed from the tables, not from a
  side cache.
- `blocked` kinds: `needs_input` (a question, options, recommended first), `dependency`, `capability` (missing
  access), `transient` (with a retry time, auto-unblocks). Answering a question from the UI or a reply on Telegram
  writes an `answer` event and puts the card back to `ready`.
- Review: `review` reassigns to a reviewer agent; the reviewer completes or requests changes (back to the builder).
- Failure limit: 2 failed attempts in a row → `blocked/capability` with both errors. Interruptions and provider
  outages don't count.
- Comments on a running card are delivered to the agent at its next turn.
- No automatic decomposition: only an agent or Can creates cards.
- Notifications: only `needs_input`, `capability` blocks and cards Can subscribed to. Not every status change.

## 8. Context management
- The full transcript is never deleted. What's sent to the model is a **view**: system prompt + memory + card + the
  conversation summary (if any) + the most recent messages that fit.
- Compaction when the view passes 70 % of the context window: a summary call over the oldest part, stored in
  `conversations.summary` with `summary_upto_seq`. If the summary call fails: drop the oldest tool **outputs** first
  (replace with « output omitted, n chars, see tool_call #id »), then older assistant text; never drop user messages
  or the card. Retry the summary on the next turn.
- A tool `history_search(query)` lets the agent read omitted parts of its own transcript.
- Memory: per-agent and shared notes, small (a few KB), always in the system prompt. Agents edit them through a tool.

## 9. Scheduler
- `schedules` rows with a cron expression or a one-shot time, in the user's timezone. Missed runs while the engine was
  down: run once at start (not once per missed slot), noted in the run.
- A schedule either sends a prompt to an agent (new conversation, or a named one) or creates a card from a template.
- Same lease mechanism as runs, so a restart doesn't double-fire.

## 10. Tools (v1)
| Tool | Notes |
|---|---|
| `read_file`, `write_file`, `edit_file`, `list_files`, `search_files` | inside the agent's workdir unless allowed outside |
| `shell` | runs in the workdir, timeout, output capped and stored as a blob |
| `web_fetch`, `web_search` | fetch → markdown; search through a configured API |
| `card_*` | create, comment, block, complete, request_review, list, show |
| `message_agent` | posts into the other agent's chat; the reply arrives as a message later |
| `canvas_read`, `canvas_write` | read the scene as JSON; add/update/delete elements |
| `schedule_create`, `schedule_list`, `schedule_delete` | |
| `memory_edit` | |
| `ask_user` | in chat runs only; on cards use `card_block(needs_input)` |

MCP client support (stdio and HTTP) comes after v1, so existing servers (PlanetScale, Stripe, Cloudflare) plug in
without new code.

Permissions per agent: allowed tools, allowed paths, shell on/off, network on/off. Dangerous shell patterns
(`rm -rf` outside the workdir, `git push --force`, writing to `~/.ssh`) require Can's approval in the UI.

## 11. Canvas
- `@excalidraw/excalidraw` React component; scene stored as JSON in `canvases`, versioned (each save bumps
  `version`; keep the last 50).
- Live sync: the UI sends scene updates over the WebSocket; the engine broadcasts them; agents' `canvas_write`
  goes through the same path, so Can sees agent edits appear.
- Agent tools work on a simplified element format (rectangle, ellipse, arrow, text, frame with x, y, w, h, label,
  links between elements) converted to Excalidraw elements in the engine, so a model doesn't have to produce raw
  Excalidraw JSON.
- A card can link a canvas; a canvas element can link a card.

## 12. UI and API
- Screens: **Chat** (agent list + conversation, streaming, tool calls collapsible), **Board** (columns, card detail with
  events, runs, transcript link, « why not running »), **Canvas**, **Schedules**, **Agents** (prompt, model, tools,
  memory), **Settings** (models, credentials, usage), **Logs**.
- API: REST for reads and commands (`/api/cards`, `/api/agents`, `/api/runs`…), one WebSocket for events
  (`run.delta`, `run.status`, `card.updated`, `canvas.patch`, `notification`). Types and zod schemas in
  `packages/shared`.
- Server mode auth: one user, a passkey or a long random token set at install, cookie session; listen on
  localhost behind Caddy/Tailscale. Never expose the engine port directly.
- Direct chat (built 10 Nov 2026, « Chat » page): Can talks to any agent without a card. One chat per agent, stored
  as a card on the `direct` board (`cards.board`, unused until then) so runs, leases, streaming and recovery are the
  card machinery unchanged; it stays `done`, never shows on the board or in `card_list`, and refuses status/assignee/
  parent changes and blocks. The agent's system prompt says it's a direct chat; work to track becomes cards via
  `card_create`. Deleting an agent archives its chat.
- Look (built 10 Nov 2026, `packages/ui/src/styles.css`): a "framed sheet" — sidebar and 48px top bar on one tinted
  frame, the work on a sheet inset 8px with a 1px edge and 16px corners, no shadows at rest, no gradients. One accent,
  sea teal, on running work, focus and the mark; status colours only on status. IBM Plex Sans/Mono bundled with the
  app (no font CDN). Three themes — **light**, **gray** (soft neutral greys for long sessions) and **dark** (true
  black) — differ only in CSS tokens on `html[data-theme]`; "Auto" follows the OS between light and dark. The choice
  is per device (localStorage), applied before first paint by `index.html`; `?theme=gray` previews one without
  saving. Excalidraw follows: light → light, gray/dark → dark. Chat follows the AI-chat convention: assistant text
  unboxed, the user's messages in a bubble, tool calls as one quiet line each, a rounded composer.

## 13. After v1
Telegram bot (notifications + answering `needs_input`), MCP client, browser automation tool, git worktree per card,
image input, cost dashboards, export/import of agents.

## 14. Build order
Each step ends with something Can can use.
1. **Skeleton**: monorepo, engine with SQLite + migrations, UI shell, Electron wrapper, `npm run dev` and `desktop`.
2. **One agent, chat**: Anthropic provider, agent loop, file + shell tools, streaming chat in the UI, transcript
   stored. Fake provider for tests.
3. **Durability**: leases, resume, the kill-and-restart test (§6). Do this before adding features.
4. **Models and credentials**: local OpenAI-compatible provider, model validation, credential pool, OAuth refresh,
   Settings screen.
5. **Kanban**: cards, dispatcher, card tools, board UI, blocks and answers, review, « why not running ».
6. **Multi-agent**: several agents, `message_agent`, memory, per-agent permissions.
7. **Scheduler**: schedules, schedule tools, UI.
8. **Context management** (§8) with the summary fallback.
9. **Canvas** (§11).
10. **Server mode** (§12 auth) and move to the VPS.
11. After v1 (§13).

## 15. Lessons from Hermes (don't repeat)
What actually went wrong on the Datinel board during the first week of November 2026, and the rule here that
prevents it:
| What happened | Rule |
|---|---|
| A gateway restart killed every running agent; the cards were marked crashed, hit « gave up », and sat blocked for 5 hours until someone unblocked them by hand. | Restart = interruption, auto-resume, not counted as failure (§6). |
| A `ready` card silently didn't start for hours because of a 24 h « open PR » respawn guard. | No hidden guards; every « not starting » reason shown on the card (§7). |
| « Could not check paris's Bot Chat registry (profile_mismatch) »: per-profile state databases disagreed. | One process, one database; agents are rows (§2). |
| Workers died on « OAuth access token has expired » (HTTP 401) and needed a manual unblock. | Refresh ahead of expiry, refresh on 401, pause instead of fail (§5). |
| A profile's default model pointed at a local model that wasn't loaded; its cards crashed with « model not found ». | Model validation at save and before runs; no silent fallback (§5). |
| The context summarizer failed and a deterministic fallback lost most of the conversation's detail. | Transcript never deleted; summary is a view; degrade by dropping tool outputs first (§8). |
| An automatic decomposer created child cards with odd parents. | No automatic decomposition (§7). |
| Telegram pinged Can on every status change. | Notify only on questions, hard blocks and subscriptions (§7). |
| Rate limits (429) across shared accounts stalled agents. | Credential pool with cooldowns and visible reset times (§5). |
| ~80 state modules for sessions, locks and repairs. | Keep the store small; one transaction per change; delete code rather than add repair paths (CLAUDE.md rule 1). |

## 16. Decisions from Can (9 Nov 2026)
These override the sections above where they differ.
- **Triage agent.** Can drops raw ideas in `triage`. A designated triage agent (setting, default atlas) picks every
  `triage` card, rewrites title/body, splits it into cards if needed, sets assignee, priority and parents, then moves
  each to `todo` (has an open blocker/parent) or `ready`. This is the only « decomposition », and it's done by an
  agent through `card_*` tools (§7 stays true: no hidden automatic splitting).
- **The card chat is the agent's conversation.** Each card has one `conversation`; its transcript (assistant text,
  tool calls, results) streams live in the card panel. Can types in the same panel: the message is appended as a
  `user` message and delivered at the agent's next turn (or starts a run if the card is idle). No separate
  « comments » channel for Can.
- **Canvas = whiteboard + live renders, one surface.** A canvas holds nodes of pluggable kinds, each a small
  renderer module registered in the UI (`packages/ui/src/canvas/renderers/*`):
  - `drawing`: Excalidraw scene (system design, diagrams),
  - `html`: an HTML string rendered in a sandboxed iframe,
  - `url`: any running app (Vite/React/Next dev server, a built `dist/`) in an iframe,
  - `markdown`: an explanation block.
  Nodes are placed and resized on an infinite board. Agents use `canvas_read` / `canvas_write` on the node list.
  Adding a kind = one renderer file + one entry in the shared zod union; nothing else (the one place where a
  registry is warranted, since Can asked for it).
- **Name**: the app is **Atlas** (repo `csoylu/atlas`, folder `~/Desktop/perso/atlas`, env prefix `ATLAS_`).
  The lead agent is also called atlas; in the UI agents always show as `@atlas`.
- **Agent integration**: own agent loop as in §4–5. Claude plan only through Atlas's own approved OAuth client (§5); no CLI adapter, no Claude Code identity.
- **How runs end** (built in step 5): run kinds `triage` / `work` / `chat`. A work run that stops without
  `card_complete` / `card_request_review` / `card_block` blocks the card (`needs_input`, its last message as the
  question) instead of retrying in a loop. A failed run blocks it (`transient` with a retry time for 429/5xx,
  `capability` otherwise). A failed triage waits until Can writes or presses Retry. Can's message on a blocked or
  review card puts it back to `ready`; elsewhere the agent replies in chat. Every start writes a `system` note
  in the chat saying why the agent started.
- **Canvas details** (built in step 9): one versioned JSON document per canvas (last 50 versions, restorable).
  The UI saves with optimistic versions and, on conflict, merges (server nodes + Can's changed nodes − his deleted
  ones); agents apply node ops on the latest version (no conflicts). Drawings: agents write `sketch` elements,
  converted in the UI with Excalidraw's skeleton API (arrows laid out between the boxes they join, colours adjusted
  for the dark theme's inversion); once edited in the full-screen editor a drawing stores Excalidraw elements and
  agents read a compact summary. HTML runs in an opaque-origin sandbox; agent workspace files are served at
  `/api/files/<agent>/<path>` with a CSP sandbox header, so a built app or page can be shown in a `url` node.
- **Context management** (built in step 8): each model has a `context_window` (default 200k Anthropic, 32k local;
  a model test reads the real value from Ollama `/api/ps` or llama.cpp `/props`, since local servers run far below
  the model's maximum and Ollama silently cuts prompts that overflow). Token counts are estimated (~4 chars/token).
  Past 70 % the runner folds the oldest messages into `conversations.summary` with the agent's own model, cutting only
  before an assistant message so tool calls and results stay paired, folding enough to leave about half the budget
  free, a bounded chunk per call. If the summary call fails, the view drops old tool outputs, then old tool inputs,
  then old assistant text, never Can's words or the newest two turns, and the summary is retried at the next turn
  (event `compaction_failed` on the card). Agents read anything left out with `history_search` (query or `#seq`).
- **Schedules** (built in step 7, rebuilt in 10): a schedule gives an agent a prompt on a cron (in its time zone,
  default the engine's) or once at a time. Each run either creates a new dated card (ready, assigned), or posts the
  prompt on the schedule's own card and reopens it (done/todo → ready; running: read at the next turn; blocked or in
  review: waits for Can), so a recurring job keeps its history in one conversation. A firing claims its slot
  (compare-and-set on `next_run_at`) in the same transaction as the card it touches: no double fire across restarts;
  missed slots fire once at start with a note. A failing schedule records `last_error` and moves to its next slot.
  Agents have `schedule_list` / `schedule_create` / `schedule_delete`. UI: presets (weekdays/day/week/hour) or raw
  cron, live preview of the next runs, Run now, pause.
- **Server mode auth** (rebuilt in 10; the first version accepted forged cookies): login exists only when the engine
  gets `ATLAS_PASSWORD` (env, ≥ 12 chars, never stored). Session = stateless token with expiry (30 days), HMAC-signed
  with a key derived from the password, cookie HttpOnly + SameSite=Strict (+ Secure behind HTTPS via the proxy).
  5 wrong passwords lock the client out for a minute, doubling. Without a password the engine refuses non-loopback
  hosts. In every mode, browser requests from another site (Origin) and non-loopback Host names (DNS rebinding) are
  refused: localhost is reachable from any page Can opens. Desktop and `npm run dev` have no login.

- **Atlas will be public** (Can, 10 Nov 2026): the repo becomes open source. Keep secrets out of it (they already are:
  keychain/env only) and write docs for someone who isn't Can.

## 17. Open questions for Can
- Import Hermes data (agents' prompts, memory, open cards) at step 6, or start clean?
- Does the VPS run the only engine (desktop app connects to it), or does each machine run its own?
