# Atlas — design

Status: proposal, 9 Nov 2026. Owner: Can Soylu. Written by atlas from a week of running the Datinel team on Hermes Agent.

## 1. Goal
One app where the user's agents work like a small team:
- **Agents**: named (atlas, munih, paris, zurich…), each with a role prompt, a model, a tool set, a working
  directory and a memory.
- **Kanban** board: the only task tracker. Cards are assigned to agents, run automatically, block on questions,
  go to review, finish with a handoff.
- **Workflows** (replaced Schedules, #170): a trigger (a time, or by hand) wired to agent steps, approvals and conditions.
- **Canvas**: a board that the user and agents both read and write (HTML mockups, running apps, notes; diagrams as svg).
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
| `cards` | id, board, title, body, status, assignee (agent id), priority, model_override, workdir, origin_card (direct chat it came from), created_by, created_at |
| `card_reports` | id, chat_id, card_id, transition, message_id, at, delivered_at — report-back outbox (§16) |
| `card_links` | parent_id, child_id |
| `card_events` | id, card_id, at, kind, payload (json): status changes, comments, blocks, answers, handoffs |
| `runs` | id, card_id or chat_id or schedule_id, agent_id, status (`queued`/`running`/`waiting`/`done`/`failed`/`interrupted`), lease_until, attempt, error, started_at, ended_at |
| `messages` | id, conversation_id, seq, role, content (json blocks), tokens, at — the full transcript, append-only |
| `conversations` | id, agent_id, kind (`chat`/`card`/`schedule`), summary, summary_upto_seq |
| `tool_calls` | id, run_id, tool_use_id, name, input, status, output_ref, started_at, ended_at |
| `workflows`, `workflow_nodes`, `workflow_edges`, `workflow_runs`, `workflow_run_steps` | §9 (migration 0044; replaced `schedules`) |
| `card_prs` | card_id, repo, number, url, branch, base, head_sha, state, merge_sha, mergeable, ci, qa, qa_description, checked_at, error, error_since, reviewed_sha, failed_sha — §7.1 (migration 0045); `cards.reviewer` |
| `memories` | id, kind (`rule`/`preference`/`fact`/`project`), scope (`shared`/`agent:<id>`), text (≤ 500), source_conversation_id + source_seq, card_id, status (`active`/`stale`/`archived`), pinned, created_at, confirmed_at, updated_at, updated_by — Memory v2 (§8, migration 0033); `memories_fts` (FTS5, porter) kept in sync by triggers |
| `memory_changes` | id, memory_id, at, by, action, before_text/kind/status/pinned, undone_by — every change, for the daily digest and undo |
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
  silently. Built: the turn limit (150, `MAX_TURNS`) ends the run `done` with a `system` note « Paused after N turns:
  reply to continue. » (a work card blocks needs_input with it); a reply resumes.
- Independent tool calls in one response may run in parallel.
- A card run ends only through a tool: `card_complete(summary)`, `card_block(kind, question)`,
  `card_request_review(summary)`. A run that stops without one → card back to `ready` with the last output as a
  comment, and the attempt counts.

## 5. Providers and credentials
One provider interface; direct API implementations plus subscription adapters:
- **Anthropic** Messages API: tool use, prompt caching (cache the system prompt and the stable prefix), extended
  thinking when the model supports it. Auth by API key, or the Claude plan through subscription OAuth (see below).
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
Claude has two independent billing/authentication paths:
- **API keys:** normal Anthropic accounts, using `x-api-key`. No subscription identity or OAuth scopes.
- **Subscription:** `claude_plan`, built-in public Claude Code OAuth client, authorization at
  `https://claude.ai/oauth/authorize`, JSON token exchange/refresh at `https://platform.claude.com/v1/oauth/token`.
  PKCE S256 and random state; the user pastes the complete `code#state` from the browser callback.
  Reject mismatched state before exchanging; pending login expires after 10 minutes.
- Access/refresh tokens stay in the desktop keychain, never SQLite or UI. Refresh near expiry is single-flight;
  dead refresh grants/401 sign out. A 429 pauses that subscription until its reset and the call moves to the next
  one (see « Plan subscriptions » below).
- Subscription requests use the Claude Code-compatible headers and system prefix. Client version is hardcoded
  to the user's installed 2.1.322. This is direct OAuth API integration, not a spawned Claude Code process.
- Advanced `ATLAS_CLAUDE_*` overrides remain available for custom OAuth servers; no configuration required normally.
- Server engines without a secure secret store cannot sign in.

Thinking (12 Nov 2026): Claude 4.6+ models get `thinking: { type: 'adaptive', display: 'summarized' }`
(their default display is « omitted »: empty thinking text, signature only); older names get no thinking parameter.
The chat hides thinking blocks with no text.

The legacy `claude_code` CLI provider (migration 0017) stays removed (0018): rows readable, never runnable.

### ChatGPT plan (built 10 Nov 2026, `engine/src/chatgpt.ts` + `providers/chatgpt.ts`, Agents page « ChatGPT plan »)
The user asked for OpenAI usage by subscription login. OpenAI's **Sign in with ChatGPT**
lets open-source, locally hosted apps use a person's ChatGPT plan (developers.openai.com/siwc, « ChatGPT plan
usage »; terms openai.com/policies/sign-in-with-chatgpt-terms). Atlas is free, runs on the user's machine and will be public.
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
- **Several accounts, failover (decision, 11 Nov 2026).** OpenAI's terms ask for one account and no rotation
  around limits; the user was told and chose otherwise: several ChatGPT subscriptions can be signed in and a usage limit
  on one moves the work to the next (« Plan subscriptions » below). Board cards and schedules use the plan just like
  direct chats, with no separate background-use opt-in (explicitly authorized by the user, 10 Nov 2026). Never a switch to
  other billing (API keys). Each account has its own registration (`oaiapp_…`); the host id stays per machine.
  UI per OpenAI's guidelines: « Continue with ChatGPT » button (`data-oai-siwc-button`), a one-time « You're using your
  ChatGPT plan » notice, « Using ChatGPT plan · Manage usage » by the composer. Missing: OpenAI's official logo on the
  button (add the approved asset when the repo goes public).

### Plan subscriptions (built 11 Nov 2026, `engine/src/plan-accounts.ts`, Models page « Claude plan » / « ChatGPT plan »)
The user's decisions (11 Nov 2026): several Claude **and** ChatGPT subscriptions, each with its own name (« Main »,
« Work »…), sign-in and keychain entry; automatic failover; quotas on the Models page and in the composer.
- **Table `plan_accounts`** (migration 0020): provider, label, position (= failover order), keychain entry name
  (`CLAUDE_TOKENS` / `CHATGPT_TOKENS` for the first account — the single sign-in made before 0020 became « Main »
  with its tokens untouched — `…_TOKENS_<ID>` for the others), sign-in metadata, pause, quota JSON + raw limit
  headers. Welcome flags and ChatGPT's host id moved to `settings`; `claude_account` / `chatgpt_account` dropped.
  One Claude/ChatGPT identity can't be signed in to two subscriptions.
- **Models stay per provider** (`plan-claude-opus-5-5`, `gpt-…`): a call goes to the first signed-in, unpaused
  subscription in list order. A usage limit (Claude: HTTP 429; ChatGPT: `subscription_sharing_usage_limit_exceeded`)
  pauses that subscription until its reset (Claude: `retry-after`, else the reset of the `rejected` unified window,
  else `anthropic-ratelimit-unified-reset`; ChatGPT: `resets_at`/`resets_in_seconds` in the error or `retry-after`,
  else until Resume), writes a **notification** row (`notifications` table, shown as a system notification by the
  app) and the same call goes to the next one. Text already streamed is never replayed: the run retries and lands on
  the next one. **All paused**: the call fails transient with `retryAt` = earliest reset; the card waits in `todo`
  with a retry time until then (#131) (« retrying at 16:40 » / « Mon 09:00 ») and it restarts by itself.
- **Quotas**: every Claude plan response's `anthropic-ratelimit-unified-5h-utilization` / `-5h-reset` and `-7d-…`
  (utilization a fraction, reset unix seconds) and `-status` are stored per subscription; ChatGPT: Codex-style
  `x-codex-primary/secondary-used-percent` / `-window-minutes` / `-reset-after-seconds` if OpenAI sends them, else
  the Models page says it reports none and links « Manage usage ». Every limit-looking header is kept raw
  (`quota_raw`) to check what the providers really send. `model_usage.account_id` records which subscription
  answered; the composer strip shows that one's « ▮ 62% of 5h » (amber past 80 %, weekly added when past 80 %).


### Local models (built 10 Nov 2026, `engine/src/local.ts`, UI page « Models »)
The engine manages **Ollama** on its own machine (the user's choice over bundling llama.cpp: already installed, least new
code). Models come from the **Ollama library only**: Hugging Face search and `hf.co/…` pulls were removed (the user,
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
- **Usage** (10 Nov 2026; `engine/src/usage.ts`, migration 0014): every model call is a `model_usage` row (model,
  source, agent, card, conversation, tokens in/out/cached; no foreign keys so totals outlive deletions). `input` is the
  whole prompt: Anthropic's uncached `input_tokens` + cache reads + cache writes. Chat screens show, above the
  composer, the context fill at the latest answer (prompt / model window; amber past 50 %, red past the 70 %
  compaction point) and the chat's tokens, plus « Using ChatGPT plan · Manage usage » on the plan. The Models page
  starts with « Usage »: 30-day totals, tokens per day stacked by source, per-model today/7/30 days. Tokens only, no
  cost (no price table to keep right); ChatGPT plan quota stays in ChatGPT settings (OpenAI exposes no figure).
- **Model and effort per chat/card** (10 Nov 2026; migration 0015 `cards.model_id`, `cards.effort`): two quiet
  pickers above the composer. Empty = the agent's model / the model's default effort. Effort low · medium · high ·
  xhigh · max goes to Claude as `output_config.effort`, to the ChatGPT plan as `reasoning.effort`, to Ollama and other
  OpenAI-compatible servers as `reasoning_effort` (xhigh/max → high). Picking doesn't move a chat up the history; a
  deleted picked model makes the next run fail with that reason. The dispatcher checks the card's model when it has one.
- **Models page = where models come from** (10 Nov 2026): « Available to agents » (every Atlas model), ChatGPT
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
Statuses: `triage → todo → ready → running → (blocked | review) → done`, plus `closed` and `archived`.
- `todo` waits on parents; it moves to `ready` when all parents are `done`.
- `closed` = cancelled: nothing (more) is done. The user closes from the card; agents with `card_update(status=closed)`.
  Closing stops the card's work/triage run. Unlike `done` it doesn't satisfy parents: children stay `todo` and say
  « parent c_x was closed ». Not a delete (the card and its chat stay); setting another status reopens it.
- The dispatcher starts `ready` cards whose assignee has a free slot (default 1 run per agent, configurable).
- **No hidden guards.** If a `ready` card isn't starting, the card shows why, in plain words (agent busy with t_x,
  credential cooling down until 14:05, model unreachable). Every reason is computed from the tables, not from a
  side cache.
- `blocked` means **needs the user** (#131): kinds `needs_input` (a question, options, recommended first) and
  `capability` (missing access). What clears without the user waits in `todo` instead: `task_block dependency` takes
  `waits_on` (task numbers), adds them as parents and the card starts by itself once they are done (with a system note
  saying so); `transient` (429/5xx, plan paused until a reset, or an agent's « retry later ») keeps its time in the
  block columns of the `todo` card (`card.retry`, « retrying at 14:05 · why ») and the dispatcher moves it to `ready`
  then. Both are read from the tables, so a restart keeps them. Old `blocked/dependency` cards stay as they were. Answering a question from the UI or a reply on Telegram
  writes an `answer` event and puts the card back to `ready`.
- Review (#189): `review` = **In review, waiting for QA**, never for the user (no Inbox item, not in « Needs you »).
  See §7.1.
- Failure limit: 2 failed attempts in a row → `blocked/capability` with both errors. Interruptions and provider
  outages don't count.
- Comments on a running card are delivered to the agent at its next turn.
- No automatic decomposition: only an agent or the user creates cards.
- Notifications: only `needs_input`, `capability` blocks and cards the user subscribed to. Not every status change.

### 7.1 Tasks linked to their pull requests (#189, built 18 Nov 2026, `engine/src/prs.ts`)
- **Link.** The builder ends its run with `task_request_review({summary, prs: [url…]})`: rows in `card_prs` (repo,
  number, url, branch, head, state open / merged / closed, CI `test`, `qa/validated` + its description, when read, the
  last read error), the card goes `review` and gets `cards.reviewer`: the review agent (Settings → Board & triage),
  or the triage agent when the builder is the review agent (zurich's own PRs → atlas). Work with no PR ends with
  `task_complete`; `task_complete` is refused while a linked PR is open.
- **Read.** `Prs` polls every 60 s (and right after a link or a reviewer run ends) with `gh api`, the user's own gh
  login with the login shell's PATH: no token anywhere in Atlas. Only tasks `review` are read; one poll at a time.
- **Move** (no agent run, by `github`):
  - every PR merged → `done` (« PR #N merged into main (sha) » is the summary: Inbox update, report to the origin chat);
  - CI red, a conflict with the base, `qa/validated` = failure (its description is the reason), or every PR closed
    unmerged → `ready` for the builder, the reason as a system note in the thread (once per head: `failed_sha`);
  - CI green, not validated, not yet reviewed on this head → the reviewer's run starts **in the task's own thread**
    (kind `work`, agent = reviewer, kick « You review this task's pull request… », prompt: review, don't fix). One run
    per head (`reviewed_sha`); a new `task_request_review` clears it. The reviewer validates and merges with
    the `pr_validate` tool (#216: `scripts/pr/validate.mjs` run in-process with the gate of the task's project: repo,
    CI job, changelog rule); the merge then moves the card. The reviewer must be a member of the task's project. Retry on an In review card starts the reviewer again.
    The kick is always appended (`kickAlways`, #221), even when the builder's last tool result leaves a turn owed:
    without it the reviewer got the builder's thread ending on « in review: PR #N waits for @zurich » and carried on
    as the builder.
  - **A review run that ends without a verdict** (#221: done or failed, the PR still open on the same head, no
    `qa/validated` success or failure) is not a review: `reviewed_sha` is cleared and the reviewer starts once more,
    told why (`review_retry` event; `REVIEW_TRIES` = 2 runs per head, counted from `review_started` events, which
    carry the run id). After the second, the card's why-line says « review by @zurich ended without a verdict on
    abc1234 (2 runs): Retry starts it again » and one Inbox item (`review.stalled`, once per run: `review_stalled`
    event); the task stays In review. Retry runs it again; a new head is a new review.
- **GitHub unreadable** (gh missing, logged out, offline): nothing moves on old data; the card's why-line and the task
  view's banner say « can't read PR #N from GitHub since 10:42: gh: not logged in »; after 15 min one Inbox item
  (`github.unreadable`), archived by itself when a read works again.
- **Restart:** everything is in `card_prs` and `cards`; the first poll after a start resumes (a PR merged while Atlas
  was down → done; a head already reviewed is not reviewed twice).
- Any GitHub repo the gh login can read; no other forge.

## 8. Context management
- **Several agents in one thread** (#221). The provider knows only « user » and « assistant », so another agent's turns
  replayed as assistant turns read as the running agent's own (zurich, reviewing in munih's thread, said « I built it…
  I won't validate my own work »). The view is built for the running agent (`othersAsContext`, context.ts): an
  assistant message by another agent becomes user context opening with « [@munih, another agent, wrote this in the
  thread (not you):] », its tool calls one line each (input ≤ 600 chars), their results « ← @munih's shell: … »
  (≤ 2000 chars), its thinking left out; the running agent's own turns, the user's and system notes are unchanged.
  The transcript itself is not changed. The thread's todo list is re-injected only for its assignee; the summarizer
  is told to say which agent did what. Where two agents share a thread today: the reviewer in the builder's task
  (§7.1), atlas reviewing zurich's PRs (same path), a task note or `agent_message` delivered into a thread (already a
  user message naming its sender). Workflow agent steps « in the same task thread » (workflows v2) get the same view
  for free: whatever runs there sees the others as named context.
- The full transcript is never deleted. What's sent to the model is a **view**: system prompt + memory + card + the
  conversation summary (if any) + the most recent messages that fit.
- Compaction when the view passes 70 % of the context window: a summary call over the oldest part, stored in
  `conversations.summary` with `summary_upto_seq`. If the summary call fails: drop the oldest tool **outputs** first
  (replace with « output omitted, n chars, see tool_call #id »), then older assistant text; never drop user messages
  or the card. Retry the summary on the next turn.
- Built 12 Nov 2026 (card #31): the size is the provider's real input count of the last turn (`last_input_tokens`,
  `last_input_upto`) + chars/4 of only the messages since; chars/4 alone when there's no reading (new conversation,
  view just changed). Past 70 % the runner first **prunes** (no model call): outside a protected tail of 25 % of the
  window, big tool outputs/inputs become « omitted … history_search can read it (seq n) » stubs and identical outputs
  are deduped (`prune_upto_seq`, view only). A prune breaks the prompt cache, so it happens only if it reclaims ≥ 5 % of
  the window; if the view is then under 50 % no summary is made, else the summary runs as above.
- Provider web searches (#144): Anthropic can answer a client tool + a web search in one turn and put the search's
  result at the start of the next answer, after the tool_result. On the view (pruned, folded or degraded), every
  `web_search_tool_result` goes right after its `server_tool_use` in one assistant message (the request is moved to
  it); a half whose other half was pruned or folded becomes its line of text; a request with no result stays only in
  the last assistant message (a turn the provider continues). A view still invalid stops the run with the message and
  block (rule 3) instead of a 400 on every retry.
- Prompt caching (Anthropic): the system prompt is a stable prefix (role, rules, workspace, team, project files) with a
  breakpoint, then a volatile tail (memory, card, date); breakpoints on the last two user messages too (3 of 4). None
  on one-shot calls (title, summary, model test).
- `todo_write(todos)`: the agent's full todo list each call, stored on the conversation; when its last call is folded
  into the summary, the current list is re-injected after the summary. The UI shows the call as a checklist.
- A tool `history_search(query)` lets the agent read omitted parts of its own transcript.
- **Memory v2** (card #81, 17 Nov 2026; spec canvas cv_ae0bb676). One row per memory in `memories`, one idea
  (≤ 500 chars), scope `shared` or `agent:<id>` (an agent has one workdir, so agent scope = its project). Kinds:
  `rule` (how to work), `preference` (the user's), `fact` (where things are, how they work), `project` (about one card:
  `card_id` = the work card it was saved on). Never deleted: forget = `archived`, restorable.
  - **Always on** (volatile tail, « # Memory »): active pinned rows + every active rule/preference in the agent's
    scopes, each labelled `[m12 · rule]`, with the usage `n/3000`. Budget **3000 chars per agent, own + shared**,
    enforced on every write (add, edit, pin, kind change, restore, undo): a write that pushes any agent over is refused
    with an error asking to merge/shorten/forget or save as a fact. A write that doesn't grow the total is allowed
    (v1 rows migrated over the limit can still be trimmed); a text over 500 can be kept but not rewritten long.
  - **Recall**: top 8 FTS matches (bm25, any keyword of 3+ letters, stop words dropped) among active, unpinned facts
    and project notes, on the card's title + body, or a direct chat's first user message; labelled with id, kind and
    `confirmed_at` date (+ `shared`). Recomputed each turn but stable for a conversation, so the cached prefix is untouched.
  - **Staleness**: when a card goes `done` or `closed`, its active project memories go `stale` in the same transaction
    (`Kanban.update`): out of recall, still found by `memory_search` and shown dimmed in the Library.
  - **Dedup**: `memory_add` looks for active memories in the agent's scopes with the same text or ≥ half of the shorter
    text's keywords (≥ 2) in common; if any, nothing is saved and they are listed: the agent calls again with
    `update: <id>` or `new: true`. Re-saving the same text (memory_update) only moves `confirmed_at`.
  - Every change goes to `memory_changes` (before-image): `GET /api/memories/changes?since=` feeds the daily Inbox
    digest (#82), `POST /api/memories/changes/:id/undo` reverts the latest change of a memory (an add is archived).
  - API: `GET /api/memories?scope&kind&status&q`, `POST /api/memories`, `GET|PATCH /api/memories/:id` (text, kind,
    pinned, status = edit/pin/archive/restore), `GET /api/agents/:id/memory-budget`; WS `memory.updated`.
    Deleting an agent archives its memories. Migration 0033 turned each non-empty line of the v1 text into a rule.
  - **UI** (#82, `MemoryPage.tsx`, `MemoryDigest.tsx`, pure rules in `memoryView.ts`):
    - **Settings → Memory** (Team group, #87; it was a Library tab until then: `#/settings/memory`,
      `…/memory/<scope>` filters a scope, `…/memory/m12` shows one memory; old `#/library/memory…` links are
      rewritten to the same place): chips by kind (All/Rules/Preferences/Facts/Projects, archived excluded) plus
      Stale and Archived, with counts; a scope filter; search (FTS through `q`); inline edit (text + kind, Enter
      saves, Esc cancels); pin, archive, restore; the source link: a chat opens `#/chat/<id>?msg=<seq>`, a board card
      its ticket `?card=<id>&msg=<seq>` — the conversation scrolls to that message and flashes it. A scope of one
      agent shows its always-on budget (used/3000). Engine refusals (409 over budget) show as the app's error.
      Stale and archived rows are dimmed.
    - **Daily digest**: one Inbox update (synthetic id −1, key `n-1`) built in the UI from the last 24 h of
      changes by agents and stale project notes (not your own edits, not confirms/undos); one line per change with
      Undo (only the latest change of each memory; older ones are off, a 409 shows its reason). Read/archive marks are
      per browser (localStorage `atlas.memory.digest`); a newer change brings it back. It counts in the badge while unread.
    - Each agent card in Settings → Agents (count + budget) links to its scope (`…/memory/agent:<id>`); the old editors are gone.

### Slash commands: /clear and /compact (card #99, built 17 Nov 2026, `engine/src/slash.ts`, `ui/src/slashCommands.ts`)
- The composer opens a popup when `/` is the first character (↑/↓, Enter/Tab runs, Esc closes); an exact command is
  never sent as a message. `POST /api/cards/:id/command {command, arg?}`. A running agent is stopped first (as Stop,
  not a rewind), then the command acts.
- `/compact [focus]`: `Runner.compactNow` folds every message the model sees into `conversations.summary` now (several
  calls if it doesn't fit), the focus as an extra instruction; a `compacted` card event with `by: user` makes the
  timeline say « Compacted by you ».
- `/clear`: a `context_clears` row (migration 0039) at the last seq. The model's view (`Runner.transcript`) starts after
  the latest clear in effect; summary, prune point and todos are reset in the same transaction, their old values kept
  in `before` for Undo (`POST /api/clears/:id/undo`, only while no message came after it). Nothing is deleted: the chat
  folds the earlier messages behind « Context cleared by you · N earlier messages » (expandable); history_search
  still finds them. A rewind to a message before a clear sets its `rewind_id` (it no longer counts); undoing the rewind
  brings it back. The old « /clear = new main chat » is gone (the API route stays).

## 9. Workflows (replaced the scheduler, #170, 18 Nov 2026, `engine/src/workflows.ts`, `workflowTime.ts`)
A workflow is a small graph: one **trigger** wired to **steps**. Mockup: paris's #165.
- **UI** (#171, `ui/src/WorkflowsView.tsx`, `WorkflowCanvas.tsx`, `WorkflowStepPanel.tsx`, pure helpers in
  `workflowView.ts`): the Workflows page (G W; `#/schedules` redirects) lists them with their step chain and last run.
  `#/workflows/<id>` is the canvas: nodes are absolutely positioned divs (x/y saved), edges are SVG paths drawn by
  `edgePath` (bezier forward, orthogonal lane backward or down), no graph library. Edit: drag nodes, drag an exit's dot
  onto a step to wire, click an edge to remove it, Add step, Undo, zoom by buttons (CSS scale), the right panel edits
  the selected step; every change is saved (debounced) with the revision, a refused save shows the engine's reason
  with Reload. `#/workflows/<id>/runs[/<run>]`: the same graph with each node's latest state in the run (earlier rounds
  listed inside), the path taken in green, the run list and its step log, Stop run. Under 640 px: no canvas, the steps
  as an ordered list with « exit → target », runs, Run now, on/off; no editing. `lastRun` (list) is the latest run
  that ran (not a skipped firing), with its steps; every run change re-emits `workflow.updated`.
- **Tables** (migration 0044): `workflows` (name, enabled, origin `'schedules'` when migrated, revision, next_run_at,
  last_fired_at, last_error), `workflow_nodes` (kind trigger | agent | approval | condition, x, y, config JSON,
  `own_card_id` = an agent step's kept task, runtime state outside the revision), `workflow_edges` (from node + named
  exit → to node, one edge per exit), `workflow_runs` (number, state running | waiting | done | failed | stopped |
  skipped, trigger time | manual, reason, times), `workflow_run_steps` (node, kind, round, state, exit, task, summary,
  times). Every change is one transaction; `workflow.updated` / `workflow.deleted` / `workflow.run` go on the WebSocket
  after commit.
- **Graph rules** (checked on every save, refused with the reason): exactly one trigger, which can't be deleted; every
  edge leaves from an existing node by one of its exits and goes to an existing node; each exit wired at most once;
  agent steps name an existing agent; a cron and a time zone that parse; a one-shot date not in the past. Exits: trigger
  `start`; agent `done` / `failed`; approval `approved` / `rejected`; condition `yes` / `no`. A graph save carries the
  revision it was read at: a stale one is refused (409).
- **Triggers** (v1): *time*, a cron in a time zone or once at a date (what schedules were), and *manual*. Run now works
  on any workflow, even off. GitHub events and webhooks: later.
- **Agent step**: the prompt goes to the agent as a new dated task each run, or onto the step's own task, reopened each
  run so it keeps the history (done/todo/closed → ready; running: read at the next turn). Variables: `{{run.id}}`,
  `{{previous.summary}}` (the handoff of the last agent step that ended), `{{previous.task}}`. The task's state picks
  the exit: done → `done` (summary: the agent's task_complete / request_review text); closed, archived, deleted, or
  blocked with kind `capability` (the agent can't do it; the task is then closed) → `failed`. Blocked on Master or in
  review: the run is *waiting*.
- **Approval**: a task blocked on Master (needs_input, options Approve / Reject) in the Inbox. The answer picks the
  exit; anything else asks again. Closing the task rejects.
- **Condition**, two tests, nothing judged by a model: « step X ran fewer than N times in this run » (a loop guard)
  and « the previous step's summary contains <text> ».
- **Ends**: an unwired exit ends the run. done / approved / yes / no end it Done; failed / rejected end it Failed with
  the reason. A run reaching a deleted agent or a missing node fails with the reason (it never crashes the tick).
- **One run at a time**: a trigger firing (time or Run now) while a run is open records a *skipped* run with the reason.
  Stop run closes the run's open tasks and ends it Stopped. Deleting a workflow stops its open run; tasks stay.
- **Durability**: the tick (every 15 s, and right after card or message events) fires due triggers, then moves every
  open run from the stored state of its current step's task. A firing claims its slot (compare-and-set on
  `next_run_at`) in the same transaction as the run and its first task: no double fire across restarts. Missed slots
  fire once at start, noted in the run. Killing the engine mid-run loses nothing: at restart the next tick reads the
  task and goes on.
- **Schedules migrated**: each schedule became « trigger → one agent step » with its id, prompt, cron or date, zone,
  task mode, on/off, next and last run, last error and its task; a schedule that had fired has run 1 (done) pointing at
  its last task. Agents keep `schedule_create` / `schedule_list` / `schedule_delete` (same inputs), now on one-step
  workflows (`schedule_delete` refuses a multi-step one). Task `created_by` is `workflow:<id>`.
- **API**: `GET/POST /api/workflows`, `GET/PATCH/DELETE /api/workflows/:id` (PATCH: name, enabled),
  `PUT /api/workflows/:id/graph` (revision check), `POST /api/workflows/:id/run`, `GET /api/workflows/:id/runs`,
  `GET /api/workflow-runs/:id` (with steps), `POST /api/workflow-runs/:id/stop`, `POST /api/workflows/preview` (next
  firings of a draft time trigger).

## 10. Tools (v1)
| Tool | Notes |
|---|---|
| `read_file`, `write_file`, `edit_file`, `list_files` | read: the agent's workdir and the OS temp folders (`/tmp`, `/private/tmp`, `os.tmpdir()`), read-only, checked after resolving links (a link in /tmp to a path elsewhere is refused); write: the workdir only. Refusals state the rule (« read: workdir and temp folders; write: workdir only »). grep and glob follow the read rule. read_file: `N\|text` lines, `offset`/`limit` (2000 lines), ≤100k chars cut on a line boundary with a « use offset= » footer, binary refused, except png/jpeg/gif/webp (≤10 MB, by their bytes): returned as a picture (§10a). Edits (edit_file, write_file over an existing file) need a read_file of the file in this conversation and refuse if it changed on disk since (mtime+size per conversation, in memory). edit_file: `replace_all`; on 0 exact hits, line-trimmed then whitespace-normalized matching (reported). Writes to one file run one at a time |
| `grep`, `glob` | ripgrep when `rg` is installed (PATH, Homebrew), else JS; skip node_modules/.git. glob newest first |
| `shell` | runs in the workdir, timeout; output over 30k chars: the tail + full output saved under `<data>/outputs/<agent>/` (pruned after 7 days, readable with read_file/grep by absolute path). `background: true` → id, log file, row in `background_processes` (migration 0024, leased like runs: a dead engine's processes are killed and marked `lost` at start); `shell_output(id, offset?)`, `shell_kill(id)`; when one ends by itself (or is lost) a system note with exit code + output tail is posted and the agent woken |
| `web_fetch` | HTML → light markdown, 15k chars head+tail by default, full text saved to outputs. An image URL (png/jpeg/gif/webp) is saved to outputs and returned as a picture |
| `screenshot` | #133. A picture of the running UI (`#/route`) or a workspace page (`pages/x.html`, `/api/files/<agent>/…`; other sites refused), width 320–2560 (default 1440×900), theme dark/light (`?theme=` + prefers-color-scheme), scale 2, phone mode (mobile + touch) under 500 px, `full_page` (≤ 6000 px), `clip` (selector), `wait_for` (selector), `actions` (click / type / press, ≤ 20). A fresh headless Chrome per call (`ATLAS_CHROME` or the usual paths; missing = clear error, no fallback) on this engine's own address (+ a session cookie in server mode). Read-only: every request but GET/HEAD/OPTIONS (and POST /api/auth/check) is refused and listed; POST /api/agents/x/main-chat gets the existing chat, never a new one. Waits for load + fonts + 500 ms network quiet, 15 s at most, else fails naming what was missing. Saved to `screenshots/<date>-<slug>-<w>-<theme>.png`, returned as a picture (§10a downscale) with URL, viewport, mode, page errors / console.error lines and refused writes |
| `web_search` | provider-native only: Anthropic's server tool `web_search_20250305` (API key and Claude plan, only against api.anthropic.com); `server_tool_use` / `web_search_tool_result` blocks are stored verbatim, replayed, shown in the UI; `pause_turn` continues the answer. ChatGPT plan and local models: none offered (ChatGPT's Responses web_search not verified on the plan route) |
| `card_*` | create, comment, block, complete, request_review, list, show |
| `message_agent` | posts into the other agent's chat; the reply arrives as a message later |
| `artifact_create`, `artifact_update`, `artifact_list`, `artifact_read` | artifacts (§11) |
| `schedule_create`, `schedule_list`, `schedule_delete` | one-step workflows (§9) |
| `memory_add`, `memory_update`, `memory_forget`, `memory_search` | Memory v2 (§8). add(kind, scope self/shared, text, update?/new?): refused with the similar ones listed unless `update: id` or `new: true`; over the always-on budget → refused, asking to merge. update(id, text, kind?) and forget(id) on own and shared memories only; forget archives. search(query): own + shared, stale included. Replaced `memory_edit` (old transcripts still render it) |
| `ask_user` | in chat runs only; on cards use `card_block(needs_input)` |

### 10a. Images (#103)
- Block `image` (packages/shared): `path` (absolute), `media_type`, `width`, `height`, `bytes`, `sha256`; a tool
  result may carry `images: ImageBlock[]`. The bytes stay in the file, never in SQLite: `data` (base64) is only filled
  in the view sent to a provider (`withPictures`, images.ts) and stripped by `appendMessage`.
- Sending: only the newest 6 pictures of the view go as pictures; older ones, a missing file, or a file whose hash
  changed become a text line `[image: path …]` (read_file it again). Long side downscaled to ≤1568 px (and re-encoded
  under ~3.6 MB). The token estimate counts ~1600 per picture; summaries and history_search show the text line.
- Providers: Anthropic / Claude plan: `image` blocks with a base64 source, inside `tool_result` content too. ChatGPT
  plan: `input_image` data URLs, in the user item and in `function_call_output` (an array output). OpenAI-compatible:
  `image_url` parts; a tool's pictures follow in a user message (tool messages are text). A local model without
  vision (Ollama `capabilities`) or a 4xx on a request with pictures → « this model can't see images », no silent drop.
- Composer (every chat: main, direct, thread, modal): paste, drop, attach button; ≤5 per message, png/jpeg/gif/webp,
  10 MB, a refused file says why. Each one is staged at once (`POST /api/cards/:id/uploads`, raw body, checked on its
  bytes, kept in `<data>/uploads/up_<uuid>--<name>.<ext>`; unsent ones pruned after a day). `POST …/messages` with
  `uploads: [ids]` (text may be empty) copies each into the agent's workspace `uploads/<date>-<name>.<ext>`, writes the
  message row (image block + an `[attached: uploads/…]` line for the agent), then drops the staged file; a failed row
  write removes the copies, so sending again works and a restart in between loses nothing.
- Transcript: thumbnails (`GET /api/cards/:id/image?path=`, only paths the conversation references), click = full size.
- **A task's own images (#119).** The New task dialog and a task's description (CardView: modal and thread panel)
  take paste, drop and the attach button; same types and 10 MB, ≤5 per task (`IMAGE_MAX_PER_TASK`). Pasting text
  stays text (a paste is an image only when it carries no text). Shown as thumbnails under the description, click =
  full size, × removes. Storage: `cards.images` (migration 0040, JSON image blocks), files in `<data>/task-images/`
  (`<date>-<name>.<ext>`), never bytes in SQLite.
  - New task: images are staged with no task yet (`POST /api/uploads`), `POST /api/cards` with `uploads: [ids]` copies
    them and writes the row in its transaction (a failed write removes the copies). Cancel / Esc / × deletes the staged
    files (`DELETE /api/uploads/:id`); anything missed is pruned after a day. No card exists before Create.
  - Existing task: each staged image is added at once (`POST /api/cards/:id/images`, refused past 5 with the count),
    removed by `DELETE /api/cards/:id/images?path=` (row first, then the file). Deleting the task deletes its files;
    files no task lists (a crash between copy and row) are swept at engine start.
  - Agent side: not stored in the transcript. At every turn of a run on the task, the view opens with « Images
    attached to task #N (k): », each picture and its `[attached: uploads/task-N-<file>]` line; the file is copied
    into the running agent's workspace on first use. So a later assignee (or a reassigned one, or triage) sees them,
    and a removed image is gone from the next turn. They count in the 6 newest pictures and the token estimate; the
    system prompt's « # Current task » lists their workspace paths. A model without vision fails loudly, as above.

Project instructions: `AGENTS.md` and `CLAUDE.md` at the root of the agent's workdir go in the system prompt
(« # Project instructions », each labelled with its path, capped at 20k chars with a note), before the card and the date.

MCP client support (stdio and HTTP) comes after v1, so existing servers (PlanetScale, Stripe, Cloudflare) plug in
without new code.

Permissions per agent: allowed tools, allowed paths, shell on/off, network on/off. Dangerous shell patterns
(`rm -rf` outside the workdir, `git push --force`, writing to `~/.ssh`) require the user's approval in the UI.

### 10b. Secrets (#206, 18 Nov 2026, `engine/src/secrets.ts`)
API keys, tokens and RPC URLs agents use in shell commands as `$NAME`, and the model keys Atlas itself uses. Design:
the diagram « Secrets in Atlas: flow » and the mockup « Settings → Secrets (#205) » (Library → Secrets).
- **Values only in the secret store** (`SecretStore`: desktop = OS keychain via Electron safeStorage, `secrets.json`).
  SQLite holds the metadata, table `secrets` (migration 0046): name (PK, `A-Z0-9_`, fixed once created), description,
  kind `model_key` | `agent`, grant `none` | `agents` | `all` (+ the agents), project (null = global; projects are not built yet), created by (`user` or an agent id) and
  in which task, updated at/by, last used at/by. Model keys are never granted (a CHECK and the API refuse it); plan
  sign-in tokens (`isTokenEntry`) have no row and are never listed.
- **Two writes, ordered so a crash is harmless** (rule 2): create = row, then value (a store write that fails removes
  the row; a crash in between leaves a row shown as « no value »); delete = value, then row. At start (and on each list)
  `sync()` gives a `model_key` row to every stored name without one (before #206 the store held only model keys, and
  every agent secret gets its row before its value, so an orphan value is never taken for an agent secret) and drops
  model-key rows whose value is gone (API keys page).
- **API** `GET /api/secrets` → `{ store, names, secrets: SecretInfo[] }` (metadata + `hasValue`), `POST` (create an
  agent secret), `PATCH /:name` (description, grant), `PUT /:name` (new value; a new name there is a model key, as
  before), `DELETE /:name`. No response ever holds a value; `secrets.updated` events tell the UI to reload.
- **Shell env**: every command (foreground and `background: true`) gets the agent's base env (#136) minus every model
  key, plan token and engine password (server mode keeps them in its own environment), plus the agent's granted
  secrets read from the store at that command (a rotation applies to the next command). A command that mentions
  (`$NAME`/`${NAME}`) a secret not granted to it, or a granted one with no value, does not run and says why; an
  unreadable store stops the command. `last_used` is set when a command mentions the name.
- **Instructions**: a « # Secrets » block lists the granted names and descriptions (never values), says to use `$NAME`
  and never to print them.
- **Redactor** (best effort: an encoded or split value slips through): one choke point in the runner, after every
  tool (shell, background output and exit notes, read_file, grep, web_fetch, card and team tools…) and before the
  result is stored or sent to the model; also the live shell tail and full outputs saved to `outputs/`. Every stored
  value of 8 chars or more (all agent secrets, not only this agent's, model keys, the tokens inside plan sign-ins, and
  the model keys and passwords of the engine environment) becomes `[secret NAME]`, longest first; the count goes in
  `tool_calls.secrets_hidden` (`ToolCallTiming.secretsHidden`, the chat's « 1 secret hidden »). A store that can't be
  read withholds the output with the reason. Background log files on disk are not rewritten (reads of them are).
  End-to-end tests, the leak audit (canary values searched in SQLite+WAL, files, logs, API, events, model requests,
  snapshots) and the full list of known limits: `docs/qa/210-secrets-leak-audit.md`.
- **Server store** (#208, `engine/src/secretFile.ts`): `<dataDir>/secrets.enc`, one JSON file: a header in the clear
  (version, scrypt cost N=2^15 r=8 p=1 and its random salt, the stored names, a key check) and the values encrypted
  with AES-256-GCM (random IV per write, the header as additional data). Key = scrypt(secrets password), 64 bytes: AES
  key + HMAC key for the check (a wrong password is told apart from a changed file). node:crypto only. The password
  and the key are never written to disk, SQLite or logs; the key stays in memory from the unlock to Lock now or the end
  of the process. Every write replaces the file atomically (temp file 0600, fsync, rename, fsync of the folder; a temp
  file left by a kill is removed at the next start), so a kill leaves the old file or the new one (SIGKILL test).
  - **Unlock**: `ATLAS_SECRETS_PASSWORD` at start (unattended restart, rule 2: interrupted runs resume with their
    secrets; the first start with it creates the file), or typed in Settings → Secrets. A wrong env password does not
    stop the engine: it starts locked, the error is printed and in the status. A wrong password answers 403 after 1 s,
    attempts one at a time. A tampered file (data, tag, IV, names) is refused with « secrets.enc was changed ».
  - **Locked** (names still readable, values not): a command that mentions a granted secret, a model whose key is
    only in the store (not in the engine env; checked in `Models.provider`, so the dispatcher shows it on the card and
    starts the run after the unlock), and every write (`secret_set`, API keys page, PUT/POST/DELETE) stop with
    « secret store locked: unlock it in Settings → Secrets ». Everything else keeps working, env-var keys included.
    Stored values are copied into the engine env at the unlock and removed at the lock. A command started before
    Lock now keeps its env, and its later output is no longer redacted for store values (the key is gone).
  - **API**: `GET /api/secrets/status` → `SecretStoreStatus` (kind `keychain` | `file` | `env`, exists, locked, since,
    source `env` | `ui`, error; also in `GET /api/secrets` as `status`, and a `secrets.status` event for the sidebar
    badge), `POST /api/secrets/unlock {password}`, `POST /api/secrets/lock`, `POST /api/secrets/password {current?,
    next}` (no file yet: creates it; else checks `current`, re-encrypts with a new salt). Passwords: 8+ characters.
  - Plan sign-ins (ChatGPT, Claude) stay desktop-only: the server store does not take them. Desktop keeps the Keychain.
- **Agents write secrets** (#207, `engine/src/secretTools.ts`): `secret_set({name, description?, command | value})`.
  `command` runs in the agent's workdir with its shell env (60 s max); its trimmed stdout is the value and never goes
  to the model, the transcript or the logs (result: « stored NAME, N chars »; a non-zero exit or empty stdout stores
  nothing, the error shows only the redacted end of stderr). `value`: stored, and replaced by `[secret NAME]` in the
  tool call as stored (messages, `tool_calls.input`) before anything else sees it; the provider already saw it in its
  own answer, so the tool description says to prefer `command`. A new secret is created by the agent, from its task,
  granted to it only. An agent overwrites (`secret_set`) or deletes (`secret_delete`) only a secret it created, never
  the user's, another agent's, a model key or a shell basic (`PATH`…). No tool reads a value; names are in the
  instructions.
- **« Needs secret X »** (#207): `task_block({kind: capability | needs_input, secret: NAME, secret_description?})`
  creates (or reuses) a row without a value, granted to the agent, `created_card` = `waiting_card` = the task
  (migration 0047), then blocks; the block reason says which secret. When the value is there and granted to the
  task's agent (PUT value, PATCH grant, or an agent's `secret_set`), `Secrets.resume()` adds a note to the thread,
  moves the task to ready and clears `waiting_card`, in one transaction; it also runs at engine start, so a crash
  between the value's write and the move only delays it. Dismiss = `DELETE /api/secrets/:name`.
- Still to come (#205 series): the Settings → Secrets page (and its unlock form).

## 11. Artifacts (replaced canvases, #120, 18 Nov 2026)
- An artifact is a file in an agent's workspace: markdown (`docs/*.md`), html (`pages/*.html`), svg (`diagrams/*.svg`)
  or url (`*.url`, one address). Each is a row in `documents`, versioned in `document_versions` (last 50 kept).
- Tools: `artifact_create`, `artifact_update` (whole content or one replacement; one new version each), `artifact_list`,
  `artifact_read`, `panel_open`. A created or updated artifact shows in the chat as a card that stays on its version.
- Library folders are flat (`folders`, `documents.folder_id`; null = Unfiled). Pinned artifacts stay on top in their
  folder. Deleting a folder moves its artifacts to Unfiled. Search covers titles and content across folders.
- Migration 0041 deleted whiteboard documents; the `canvases` table stays as an archive. At startup each archived
  canvas is converted once to `pages/canvases/<slug>.html` in the « Canvases » folder (`documents.from_canvas`).

## 12. UI and API
- Screens: **Chat** (agent list + conversation, streaming, tool calls collapsible), **Board** (columns, card detail with
  events, runs, transcript link, « why not running »), **Library**, **Schedules**, **Settings**, **Logs**.
- Settings (restructured 12 Nov 2026): one plain « Settings » item at the bottom of the sidebar opens `#/settings/<page>`
  (the last one visited). Inside the sheet a second navigation (200px, same nav-item style, small group titles,
  counts on the right) lists the pages; under 900px it collapses to a select at the top. Top bar: « Settings » + page.
  - Team: **Agents** (`agents`, count) · **Memory** (`memory`, every memory, design §8) · **Board & triage** (`board`, triage agent).
  - Models: **Subscriptions** (`subscriptions`: Claude plan and ChatGPT plan accounts with quota bars; drag the grip,
    or arrow keys on it, to set the failover order via `PUT /api/plan-accounts/order`) · **API keys** (`api-keys`,
    Anthropic accounts) · **Local** (`local`, Ollama server, installed models, download) · **Model list**
    (`model-list`, the models agents can pick).
  - Insight: **Usage** (`usage`, 30 days, per model). App: **Appearance** (`appearance`, theme) · **Voice**
    (`voice`, desktop Mac app only, shown when `About.voice`: on/off, voice + Test voice, wake sensitivity; turning on
    downloads the models resumably into userData/voice-models and asks for the mic; `engine/src/voice.ts`,
    `GET/PATCH /api/voice`, settings keys `voice_*`) · **About & data**
    (`about`: version, desktop or server, data folder, from `GET /api/about`).
  Old hashes are rewritten in place: `#/agents` → agents, `#/models` and `#/settings/models` → subscriptions,
  `#/settings/canvas` → appearance, unknown → agents (`packages/ui/src/settingsPages.ts`). Engine error messages
  point to « Settings → <page> ».
- Side panel beside a direct chat (documents in tabs, §16 « Side panel »); `#/library/<id>` shows one document in the Library viewer (old `#/doc/<id>` and `#/canvas/<id>` links redirect there).
  Documents API: `GET /api/documents[?card=]`, `GET /api/documents/:id[?version=]`, `GET …/:id/versions`,
  `POST …/:id/restore/:version`; per chat `GET /api/chats/:id/panel`, `POST …/panel/{open,close,focus,seen}`;
  `POST /api/cards/:id/messages` takes an optional `ref {docId, version, section}`. Events `document.updated`,
  `panel.updated`.
- API: REST for reads and commands (`/api/cards`, `/api/agents`, `/api/runs`…), one WebSocket for events
  (`run.delta`, `run.status`, `card.updated`, `canvas.patch`, `notification`). Types and zod schemas in
  `packages/shared`.
- Server mode auth: one user, a passkey or a long random token set at install, cookie session; listen on
  localhost behind Caddy/Tailscale. Never expose the engine port directly.
- Direct chat (built 10 Nov 2026, « Chat » page): the user talks to any agent without a card. One chat per agent, stored
  as a card on the `direct` board (`cards.board`, unused until then) so runs, leases, streaming and recovery are the
  card machinery unchanged; it stays `done`, never shows on the board or in `card_list`, and refuses status/assignee/
  parent changes and blocks. The agent's system prompt says it's a direct chat; work to track becomes cards via
  `card_create`. Deleting an agent archives its chat.
- Look (built 10 Nov 2026; **superseded by « Design refresh: Linear direction » in §16**, `packages/ui/src/styles.css`): a "framed sheet" — sidebar and 48px top bar on one tinted
  frame, the work on a sheet inset 8px with a 1px edge and 16px corners, no shadows at rest, no gradients. One accent,
  sea teal, on running work, focus and the mark; status colours only on status. IBM Plex Sans/Mono bundled with the
  app (no font CDN). Three themes — **light**, **gray** (soft neutral greys for long sessions) and **dark** (true
  black) — differ only in CSS tokens on `html[data-theme]`; "Auto" follows the OS between light and dark. The choice
  is per device (localStorage), applied before first paint by `index.html`; `?theme=gray` previews one without
  saving. Chat follows the AI-chat convention: assistant text
  unboxed, the user's messages in a bubble, tool calls as one quiet line each, a rounded composer.

## 13. After v1
Telegram bot (notifications + answering `needs_input`), MCP client, browser automation tool, git worktree per card,
image input, cost dashboards, export/import of agents.

## 14. Build order
Each step ends with something the user can use.
1. **Skeleton**: monorepo, engine with SQLite + migrations, UI shell, Electron wrapper, `npm run dev` and `desktop`.
2. **One agent, chat**: Anthropic provider, agent loop, file + shell tools, streaming chat in the UI, transcript
   stored. Fake provider for tests.
3. **Durability**: leases, resume, the kill-and-restart test (§6). Do this before adding features.
4. **Models and credentials**: local OpenAI-compatible provider, model validation, credential pool, OAuth refresh,
   Settings screen.
5. **Kanban**: cards, dispatcher, card tools, board UI, blocks and answers, review, « why not running ».
6. **Multi-agent**: several agents, `message_agent`, memory, per-agent permissions.
7. **Scheduler**: schedules, schedule tools, UI (became Workflows, §9, #170).
8. **Context management** (§8) with the summary fallback.
9. **Artifacts** (§11).
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
| Telegram pinged the user on every status change. | Notify only on questions, hard blocks and subscriptions (§7). |
| Rate limits (429) across shared accounts stalled agents. | Credential pool with cooldowns and visible reset times (§5). |
| ~80 state modules for sessions, locks and repairs. | Keep the store small; one transaction per change; delete code rather than add repair paths (CLAUDE.md rule 1). |

## 16. Decisions (9 Nov 2026)
These override the sections above where they differ.
- **Triage agent.** The user drops raw ideas in `triage`. A designated triage agent (setting, default atlas) picks every
  `triage` card, rewrites title/body, splits it into cards if needed, sets assignee, priority and parents, then moves
  each to `todo` (has an open blocker/parent) or `ready`. This is the only « decomposition », and it's done by an
  agent through `card_*` tools (§7 stays true: no hidden automatic splitting).
- **The card chat is the agent's conversation.** Each card has one `conversation`; its transcript (assistant text,
  tool calls, results) streams live in the card panel. The user types in the same panel: the message is appended as a
  `user` message and delivered at the agent's next turn (or starts a run if the card is idle). No separate
  « comments » channel for the user.
- **Canvas = whiteboard + live renders, one surface.** A canvas holds nodes of pluggable kinds, each a small
  renderer module registered in the UI (`packages/ui/src/canvas/renderers/*`):
  - `html`: an HTML string rendered in a sandboxed iframe,
  - `url`: any running app (Vite/React/Next dev server, a built `dist/`) in an iframe,
  - `markdown`: an explanation block.
  Nodes are placed and resized on an infinite board. Agents use `canvas_read` / `canvas_write` on the node list.
  Adding a kind = one renderer file + one entry in the shared zod union; nothing else (the one place where a
  registry is warranted, since the user asked for it).
- **Name**: the app is **Atlas** (repo `csoylu/atlas`, folder `~/Desktop/perso/atlas`, env prefix `ATLAS_`).
  The lead agent is also called atlas; in the UI agents always show as `@atlas`.
- **How runs end** (built in step 5): run kinds `triage` / `work` / `chat`. A work run that stops without
  `card_complete` / `card_request_review` / `card_block` blocks the card (`needs_input`, its last message as the
  question) instead of retrying in a loop. A failed run waits in `todo` with a retry time for 429/5xx
  (#131), else blocks it `capability`. A failed triage waits until the user writes or presses Retry. The user's message on a blocked or
  review card puts it back to `ready`; elsewhere the agent replies in chat. Every start writes a `system` note
  in the chat saying why the agent started.
- **Canvas details** (built in step 9): one versioned JSON document per canvas (last 50 versions, restorable).
  The UI saves with optimistic versions and, on conflict, merges (server nodes + the user's changed nodes − their deleted
  ones); agents apply node ops on the latest version (no conflicts). A node of a kind the UI doesn't know is skipped,
  never a crash. HTML runs in an opaque-origin sandbox; agent workspace files are served at
  `/api/files/<agent>/<path>` with a CSP sandbox header, so a built app or page can be shown in a `url` node.
- **Context management** (built in step 8): each model has a `context_window` (default 200k Anthropic, 32k local;
  a model test reads the real value from Ollama `/api/ps` or llama.cpp `/props`, since local servers run far below
  the model's maximum and Ollama silently cuts prompts that overflow). Token counts are estimated (~4 chars/token).
  Past 70 % the runner folds the oldest messages into `conversations.summary` with the agent's own model, cutting only
  before an assistant message so tool calls and results stay paired, folding enough to leave about half the budget
  free, a bounded chunk per call. If the summary call fails, the view drops old tool outputs, then old tool inputs,
  then old assistant text, never the user's words or the newest two turns, and the summary is retried at the next turn
  (event `compaction_failed` on the card). Agents read anything left out with `history_search` (query or `#seq`).
- **Schedules** (built in step 7, rebuilt in 10): a schedule gives an agent a prompt on a cron (in its time zone,
  default the engine's) or once at a time. Each run either creates a new dated card (ready, assigned), or posts the
  prompt on the schedule's own card and reopens it (done/todo → ready; running: read at the next turn; blocked or in
  review: waits for the user), so a recurring job keeps its history in one conversation. A firing claims its slot
  (compare-and-set on `next_run_at`) in the same transaction as the card it touches: no double fire across restarts;
  missed slots fire once at start with a note. A failing schedule records `last_error` and moves to its next slot.
  Agents have `schedule_list` / `schedule_create` / `schedule_delete`. UI: presets (weekdays/day/week/hour) or raw
  cron, live preview of the next runs, Run now, pause.
- **Server mode auth** (rebuilt in 10; the first version accepted forged cookies): login exists only when the engine
  gets `ATLAS_PASSWORD` (env, ≥ 12 chars, never stored). Session = stateless token with expiry (30 days), HMAC-signed
  with a key derived from the password, cookie HttpOnly + SameSite=Strict (+ Secure behind HTTPS via the proxy).
  5 wrong passwords lock the client out for a minute, doubling. Without a password the engine refuses non-loopback
  hosts. In every mode, browser requests from another site (Origin) and non-loopback Host names (DNS rebinding) are
  refused: localhost is reachable from any page the user opens. Desktop and `npm run dev` have no login.

- **Design before code** (11 Nov 2026): the harness prompt tells every agent to ask the open questions, show a
  canvas design (html mockup / drawing) and wait for the user's OK before non-trivial work. `canvas_write` takes
  `show: [node ids]`; the chat renders those nodes inline (`ui/src/canvas/InlineCanvas.tsx`): view only, live,
  click to expand (~80 % height), drag to pan, ctrl/⌘ + wheel to zoom, « Open canvas » for the full page.
  The model/effort/context/tokens menu is one button on the right above the composer (`RunMenu` in `Usage.tsx`).

- **Atlas will be public** (10 Nov 2026): the repo becomes open source. Keep secrets out of it (they already are:
  keychain/env only) and write docs for someone who isn't the original author.
- **The user, not « Can »** (12 Nov 2026, for the open-source release): the human's id is `user` (messages, actors;
  migration 0021 renamed `can`). First launch asks their **name** and a required one-sentence **description** (≤ 200
  chars: age, job, background), stored in `settings` (`user_name`, `user_about`), editable in Settings → About you,
  never by agents. Every system prompt names the user (no pronouns) and gives the description so agents adapt their
  level. Tool descriptions say « the user ».
- **System prompt layout** (`runner.ts systemPrompt`, 12 Nov 2026): identity and role · the user · this conversation
  (direct chat / card chat / work / triage) · how to work · workspace · team · memory · current card · today's date
  (date only, so the prompt stays cacheable all day).
- **Chat names** (12 Nov 2026): a direct chat is named from the user's first message, then renamed once by its model at
  the user's 3rd message (3-6 words, in the background; the UI shows « Generating chat name… »).

- **Card lifecycle from a chat** (12 Nov 2026, mockup `mockups/workflow.html` scenarios 1–3): a card created with
  `card_create` in a direct chat remembers it (`cards.origin_card`, migration 0022). When such a card becomes `done`,
  `review`, `closed`, is stopped, or blocks with `needs_input` / `capability`, a `system` message is posted in that chat
  (« ✓ Card “X” (c_x) finished: <summary> », « … closed by @atlas », « You stopped “X” », « … needs your OK: <question> »)
  together with a `card_reports` row, in the same transaction as the status change: exactly once per transition, crash
  or not. Since #143 (18 Nov 2026) the note wakes nobody: it is information the agent reads on its next turn (a
  transcript ending on task notes owes no turn), Master sees one compact row linking to the task's Inbox entry
  (`#/inbox/task:<id>`; a closed task opens the task), and a long summary or question is shortened on a sentence with
  « full summary: task_show #N ». Waiting on tasks and retries are not reported.
  **Stop** (`POST /api/cards/:id/stop`, no confirmation) aborts the run at once: the model call and every running
  command's process group are killed, open tool calls end `error`, and the next run gets the usual synthetic
  « interrupted » result. A stopped work card blocks (`needs_input`, « Stopped by you ») and writing on it resumes it.

- **Ticket modal** (12 Nov 2026, mockup `mockups/workflow.html` scenario 3): every card opens in one centred
  `CardModal` (min(680px, 94vw) × min(88vh, 980px), full screen under 760px) over whatever view is showing, from the
  Board, schedules, canvases and card ids in chat system lines. It lives in the hash (`?card=<id>` on any route), so
  reloads keep it. Header: live status pill (« stopped by you » after Stop), assignee, origin chat (clickable), editable
  title; body: description, parents/children, activity (tool calls as quiet lines, dangerous shell commands and
  ssh/system-path writes in red, `cardModal.ts isDangerous`); then block/review notices, the composer, and the footer
  ■ Stop (while running, no confirm) · Close card · Delete. Esc / scrim click close; focus is trapped inside.
  Direct chats keep their full-height chat pane (`CardPanel`).

- **Chat pins** (12 Nov 2026, same mockup, scenarios 1–3): the cards a chat created (`originCard`) are pinned at its
  top-left (`ChatPins`, pure rules in `chatPins.ts`): status dot (pulsing while running), title, live state
  (« running · 2:14 » from the run's start, « needs your OK », « stopped by you », « done », « closed », « deleted »).
  Click opens the ticket modal. Done / closed / deleted pins fade out 30 s after finishing (hover or focus pauses the
  timer); stopped / blocked / review pins stay; any non-running pin can be unpinned (×) until its card changes state.
  Pins are UI state only: on reopening a chat, only open cards and those finished under 30 s ago are pinned. Layout: a
  row in the chat's top band (beside the delete button) below 1240px of chat width, a floating 220px column in the left
  gutter from 1240px (container query) — never over messages or the composer. Report-back system lines
  (« ✓ Card “X” finished · open ») open their card when clicked.

- **Side panel** (12 Nov 2026, mockup `mockups/workflow.html` scenario 4; like Claude Artifacts / ChatGPT Canvas /
  Gemini Canvas): agents show their outputs at real size beside the chat instead of pasting long text.
  - *Documents are files in the agent's workspace* — `docs/*.md` (markdown), `pages/*.html` (html page),
    `diagrams/*.svg` (diagram) — plus canvases as *whiteboards*. Atlas indexes them (`documents`, migration 0023,
    `engine/src/documents.ts`) and versions them (`document_versions`, the last 50; whiteboards use the canvas's own
    versions). The file is the truth: after every `write_file` / `edit_file` / `shell` call the runner re-syncs the
    agent's doc folders (and indexed files elsewhere); reading the latest version re-syncs too, so edits from outside
    Atlas show up. Restoring an old version writes it back to the file as a new version. Title: first `# heading`, or
    `<title>`, or the file name.
  - *Attached to cards*: a document written or opened during a card's run gets `card_id` (first one wins); the
    ticket modal lists them under « Documents » with « open on the right » (into the chat the card came from, else the
    chat on screen, else full size).
  - *Panel tabs are per direct chat* (`panel_tabs`, at most 8, oldest dropped): who opened it, the section to scroll
    to, when focused (a newer focus wins the active tab and re-scrolls), and the version the user last saw.
  - *Agent tools* (`engine/src/docTools.ts`): `panel_open({path | canvas, section?})` — indexes, attaches, opens in
    the chat's panel (a card's panel = its origin chat; a card without one only indexes and attaches), scrolls to a
    markdown heading (id or text; unknown → error listing the sections) or an html element id; `panel_close({path |
    canvas}?)` closes a tab or the panel. The system prompt explains documents when the tools are available.
  - *UI* (`DocPanel.tsx`, pure rules in `docPanel.ts`): tabs (green dot = changed since seen), version menu (view an
    old version, restore it), open full, close; « Opened by @atlas · attached to card “X” » (the card opens).
    Viewers: markdown in a 720px reading column split into sections (h1–h3); html in a sandboxed iframe at real size
    (served from `/api/files`, old versions via `srcdoc`); svg as an image fit to the width but never with text under
    11px (then it scrolls sideways); whiteboard = the live inline canvas.
  - *Ask about this*: hovering a markdown section shows « Ask about this » (always visible on touch); other kinds have
    one for the whole document. It puts a quote chip « ❝ Doc › Section » in the composer; the message is sent with
    `ref`, and the engine stores a first text block `❝ Doc › Section` + `(path, doc id vN, section #id)` + the quoted
    section text, so the agent knows exactly what is meant (this is all the agent sees; no markers are placed on the
    document). The chat shows that block as a quote line that reopens the section. Sections an agent changed since
    the user last saw the doc get a « changed » mark (click = seen).
  - *Responsive*: side by side above 960px (the sidebar shrinks to icons at 901–1280px while the panel is open); an
    overlay over the chat at 761–960px; full screen at ≤760px. In overlay/full, « ‹ Chat » or « Ask » returns to the
    chat, and a « Documents · N » button brings the panel back; an agent opening a tab shows it again.

- **Design refresh: Linear direction** (approved 13 Nov 2026, mockup `mockups/linear.html`, `?screen=chat|board|
  library|inbox|palette`, `&theme=light`). Overrides « Look » in §12 and the Canvas screen of §12/§16.
  - *Shell*: the sidebar sits on the app background, no border; the work sits on one inset panel (8px margin, 1px
    hairline, 10px radius). No global top bar: each screen has a 44px header (breadcrumb, view tabs, its actions).
  - *Type & colour*: Inter (bundled, no CDN) 13px, weights 450/500/600, three text greys, hairline borders as
    rgba of the text colour. The accent stays sea teal (dark #6cc0d2 on #0b2a31 text, light #1b6c80 on white) on
    focus, selection, primary buttons, unread and « done ». Status colours only on status icons. Themes: **dark**
    and **light** (+ Auto); **gray is dropped** (a stored « gray » choice falls back to dark).
  - *Status icons*: Linear-style circles, one per card status: triage dashed, todo/ready empty, running half-filled
    yellow, blocked orange with « ! », review half-filled green, done teal with a check, failed/closed red/grey.
    Cards keep their `#41` numbers (no prefix).
  - *Sidebar*: workspace row (name, search, new chat) → **Inbox** (badge) · Board · Library · Schedules → **Agents**
    (spinner while one runs; click = new chat with it) → **Chats** → footer: user, engine dot, settings.
  - *Board*: columns with status icon + count + « + », dense cards (number, agent avatar, status icon, title,
    labels, « why blocked » line), header tabs All cards / Needs you / Running, Filter, Display, New card (C).
  - *Inbox*: list left (380px), detail right. « Needs you » (blocked questions, reviews) pinned on top, answered in
    place: options as buttons (1–4, recommended highlighted), free reply (R), approve / request changes; the item
    leaves by itself when the card moves on. « Updates »: card done, run failed (error + Retry), schedule ran,
    system (plan limit…), unread until opened, E archives, « archive all read ». Badge = unread + needs you.
    Built on the `notifications` table (+ an archived flag), the engine writes a row on block, review, done, fail.
    No snooze in v1.
  - *Library* replaces the Canvas screen: every document (md, html, svg, whiteboard) in one grouped list (pinned,
    this week, earlier) with type tabs, filters by agent/card/chat, « New whiteboard ». Opening one uses the
    **shared viewer**, the same component as the chat side panel and the card: tabs, then Preview / Source /
    History. `#/canvas/<id>` redirects to the Library viewer.
  - *Chat*: artifacts an agent opens appear as chips in the thread (click = open in panel); card references as
    status-icon chips; composer with model pill and teal send button.
  - *Keyboard*: ⌘K palette (artifacts, chats, cards, navigation, actions, scoped to the current screen), C new
    card, ⌘N new chat, ⌘\ toggle panel, G then B/L/I/S to jump, J/K move in lists, E archive in Inbox.
  - Build order (one card each, in order): tokens + shell → Board → Inbox → Library + shared viewer → ⌘K + keys.
  - *Built, step 1 (tokens + shell, 13 Nov 2026)*: tokens and the inset panel in `styles.css` (dark / light only;
    `theme.ts` `parseTheme` maps « gray » to dark, index.html too); Inter Variable bundled
    (`@fontsource-variable/inter`), IBM Plex Mono kept for code. Each screen's 44px header is `ScreenHeader.tsx`
    (App renders breadcrumb + title; a screen portals its own actions in with `<HeaderActions>`: the chat's
    « Documents · N » and delete live there now, no longer floating over the thread, so chat pins are a plain row
    above the messages, or the left-gutter column ≥1240px). `StatusIcon.tsx` draws the status circles (used by chat
    card-reference chips now; Board and pins switch in step 2). Artifacts: a successful `panel_open` tool line renders
    as a chip (`artifactOf` in `cardModal.ts` reads its result). Not yet: the sidebar's Inbox and Library entries
    (Canvas stays until step 4), the search button (disabled until ⌘K, step 5).
    `scripts/ui-check/check.mjs --theme dark|light` previews a theme for the responsive check.
  - *Built, step 2 (Board, 13 Nov 2026)*: `Board.tsx` + pure helpers in `boardView.ts`. Header (via
    `<HeaderActions>`): tabs All cards / Needs you (blocked + review) / Running with counts, Filter (agent incl.
    unassigned, priority), Display (Board | List, « Show empty columns »), New card (C, when no field or modal has the
    keyboard). Tab, filter and layout persist in localStorage `atlas.board.view`. Columns are 280px; an empty column
    is a 40px rail (still a drop target), Done and Closed start folded. « + » on Triage / Todo / Ready opens the
    New card composer (title, description, status, agent, priority → `POST /cards` with all of them). Cards: `#n`,
    avatar, status icon, title, one « why » line (`whyLine`: block kind + first line of the question, else
    `waiting`), labels = priority dot and « after #n » (no free labels yet). List layout = grouped rows. Drag between
    columns (and list groups) moves the card as before. The card modal uses the same tokens: `#n`, status-icon pill,
    avatar + assignee pill, status pill; chat pins use `StatusIcon` too.
  - *Built, step 5 (⌘K + keys, 13 Nov 2026)*: `Palette.tsx` (palette + « ? » cheat sheet), pure rules in
    `palette.ts` (fuzzy matcher: every query word must match, substring > letters in order within a short span;
    `#12`/`12` jumps to the card; keywords such as path, agent and status match by substring only; sections ordered by
    best match with a head start for the current screen's sections, `sectionOrder(view)`) and `keys.ts` (`globalKey`:
    one place for app-wide keys; `isTyping` ignores letters in fields and on a whiteboard; ⌘K works everywhere, other
    keys not while a modal or the palette is open). App owns one keydown listener: ⌘K, ⌘N, ⌘\ (window event
    `atlas:toggle-panel`, the chat on screen toggles its panel; a header button hides it too), ?, C (on any screen:
    goes to the Board and opens New card), G then B/L/I/S (1.5 s), J/K focus the next `[data-row]` in `main` (board
    cards and list rows, Library rows; ↵ opens). The Inbox keeps its own J/K/E/R/1–4. Palette rows: artifacts (open in
    the current chat's panel, else in the Library; the chat's own docs first), chats, cards (open the modal), Go to …,
    Settings pages, New card / chat / chat with @agent, panel, theme, shortcuts. Hints: sidebar search « ⌘K », nav
    items « G then … », New chat « ⌘N », panel « ⌘\ », kbd on rows. ui-check gained `palette` and `shortcuts` screens.
- **Menu bar / tray orb** (card #54, 14 Nov 2026, `apps/desktop/src/tray/`). An Electron `Tray` (macOS menu bar,
  Windows tray), only with the in-process engine (not in `npm run dev`). Icon drawn in code (`icons.ts`, BGRA at 1×/2×,
  no image files): ring = voice off/starting, ring + pause = listening paused, solid orb = ready, and while awake the
  orb is sea-teal and animated at 8 fps (halo = listening, turning arc = thinking, bars = speaking); at rest a template
  image (macOS picks black/white) and no timer. Cards that need Master: the count as menu bar text (macOS) / an orange
  dot on the icon (Windows). A click opens a menu rebuilt from live state (`model.ts`, pure, tested): status line,
  Start talking (`VoiceLoop.wakeNow()`: a bare « Hi Atlas »), Voice mode ✓, Pause listening › 1 hour / until
  tomorrow 8:00 / until I resume (or Resume), Needs you · N (rows → `#/inbox/<card>`: the question or review, max 5 +
  « All N in the Inbox… »), Running · N (› Open = the ticket, › Stop = `runner.stop`), Open Atlas, Quit. Pause = the
  setting `voice_paused_until` ('resume' or an ISO time; `VoiceStatus.paused`, `PATCH /api/voice {pause}`): not ready,
  so the microphone closes and the orb hides; a timer ends a timed pause (re-armed at engine start); turning voice
  mode on/off clears it. No CPU indicator (Master, 14 Nov 2026).

## 17. Projects (#213, #214, 18 Nov 2026, `engine/src/projects.ts`, migrations 0048, 0051, 0052)

A project is a repo the team works on: a name, a GitHub repo `owner/name` (fixed once set), a lead, members, a colour
(a hue Atlas picks from `PROJECT_HUES`, editable), active or archived. Model: diagram « Projects in Atlas: model »
(@atlas `diagrams/projects-in-atlas-model.svg`); UI: paris's mockup (#212).

- **Global**: agents (one identity each), You, global memory. **Per project**: tasks and direct chats
  (`cards.project_id`), artifacts and folders (folder names unique per project), workflows (`project_id` null =
  global: its tasks go to the default project), memories (levels come with #215), secrets (`secrets.project`, #206).
- **Migration 0048**: everything that existed becomes « Atlas » (csoylu/atlas). Every agent is a member with
  `workspace` null = its own `agents.workdir` (nothing cloned or moved); the `triage_agent` setting becomes the lead
  and is removed (Settings → Board's triage agent now reads and writes the default project's lead). New agents join
  the default project.
- **Default project**: the oldest active one. What a task, chat, artifact or folder gets when none is given; the last
  active project can't be archived. With one project nothing behaves differently.
- **Scoping**: a task's project is set at creation and never changes (`UpdateCard` has no project). A task made by a
  run gets the run's project (task_create, schedule_create, workflow steps: the workflow's). Its assignee must be a
  member. Agent tools (task_list/show/update, schedule_*, artifact_*) act on the run's project; `project` may name
  another one only for a lead (of either project), anyone else gets « only a project's lead can act on another
  project ». agent_message / task_message: members of the same project; crossing is for a lead.
- **Triage**: a project's new tasks go to its lead. The review agent stays one global setting (workflows v2).
- **System prompt**: « # This conversation » names the project, its repo and lead; « # Team (project X) » lists its
  members only.
- **API**: `GET/POST /api/projects`, `GET/PATCH /api/projects/:id` (name, lead, members, colour; repo only while
  none), `POST /api/projects/:id/archive|restore`, `GET /api/projects/repo-check?repo=` (gh with the login-shell env:
  found, private, default branch, CLAUDE.md / AGENTS.md). Lists (`/api/cards`, `/api/chats`, `/api/documents`,
  `/api/documents/search`, `/api/folders`, `/api/workflows`) take `?project=` (id or name); without it they show
  active projects, `?archived=1` adds archived ones. The Inbox stays one list; each row carries its `projectId`.
  Task numbers stay global.
- **Archive**: nothing is deleted. Its workflows turn off (in the same transaction), its runs stop, every write
  (card edits, messages, retries, new tasks/chats/folders/artifacts, turning a workflow on) is refused with « project X
  is archived: … read-only », and it is hidden unless asked. Restore brings it back; workflows stay off.
- **Workspaces (#214, migration 0051)**: one per agent per project. `project_members.home` = 1 for the agent's
  first project (the members 0048 made): its own `agents.workdir`, untouched. In any other project a member gets a
  clone in `data/workspaces/<agent>/<project>/` (`gh repo clone` with the login-shell env, i.e. Master's gh login;
  a project without a repo gets an empty folder). `clone_state`: pending → cloning → ready | failed (`clone_error`
  in words for Master). git writes into `<dir>.cloning`, renamed when done, so a folder is never half-ready: a stopped
  or killed engine leaves the row `cloning`, the next start throws the partial folder away and clones again (or marks
  it ready if the rename had happened). Progress (git's « Receiving objects » %) goes out in `project.updated`
  events (`cloneProgress`, not stored). `POST /api/projects/:id/members/:agent/retry` = « Try again »; PATCH `repo`
  is allowed while no member has a workspace of it (« Fix the repo name »), and retries the failed ones.
- **A run's workdir** is the member workspace of (agent, card's project), `workspaceOf()`: file tools, shell,
  background processes, screenshots, uploads, artifacts and the project instructions (CLAUDE.md / AGENTS.md at its
  root only). Not a member, not ready or failed: the run fails with that reason on the card. Never another project's.
- **Served files**: `/api/files/<agent>/…` stays the home workspace (every link made before stays valid);
  `/api/files/<agent>@<project>/…` is the agent's workspace in another project (agent ids have no `@`). Documents
  carry `filesRoot`; the system prompt gives the run's own root.
- **Main chats**: `project_members.main_chat` (moved from `agents.main_chat`: the home project keeps the same chat,
  same id and history). `POST /api/agents/:id/main-chat?project=` (and `/new`); without `project`, the default
  project. Another project's main chat is « @agent · Project ». agent_message lands in the target's main chat of the
  sender's project when it is a member there. The cached system-prompt prefix depends only on (agent, project).
- **Removing a member**: in one transaction its open tasks there go to triage for the lead (unassigned), its chats
  there are archived (read-only, searchable); then its runs there stop. Its workspace stays on disk, listed in
  `Project.kept` and still served; re-adding the agent takes it back as is. `DELETE /api/projects/:id/kept/:agent`
  deletes a kept clone (Master's explicit action, never automatic; an agent's own workdir is never deleted).
- **Memory levels (#215, migration 0052)**: `global` (the user's own rules and preferences, who the user is:
  `project_id` null), a project's (`shared` + `project_id`) and an agent's in a project (`agent:<id>` + `project_id`).
  A run sees global + its project's + its own there, in the always-on block, recall, memory_search, memory_update,
  the [memory] change notes, the background review and the weekly cleanup; another project's memory never. Tool
  scopes: `self` = you in this project, `shared` = this project, `global` = the user's own rules. Migration 0052 rebuilds
  `memories` (CHECK: global ⇔ no project) and keeps everything in « Atlas »; the lead moves the user's general
  preferences to global by hand (`PATCH /api/memories/:id {"scope":"global"}`). Budget: 3000 always-on chars per run
  (global + project + own), of which global at most 2000 (`MEMORY_BUDGET_GLOBAL`), so each project keeps ≥ 1000. The
  kind `project` is shown as « task notes ».
- **Secrets per project (#215)**: `secrets.project` null = global. A run's env and instructions hold global + its
  project's secrets (still per agent grant); `secret_set` and « needs secret » create in the run's project. The
  redactor masks every stored value, whatever the project. `GET /api/secrets?project=<id|name|global>` filters.
- **Next**: the UI (Projects page, switcher).

## 18. Open questions
- Import Hermes data (agents' prompts, memory, open cards) at step 6, or start clean?
- Does the VPS run the only engine (desktop app connects to it), or does each machine run its own?
