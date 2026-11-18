# Secrets: end-to-end tests and leak audit (#210, 18 Nov 2026)

Tests: `e2e/tests/secrets.spec.ts` (desktop mode), `secrets-server.spec.ts` (server mode, locked → unlock → Lock now),
`secrets-leaks.spec.ts` (audit controls, every print road, known limits). Harness: `e2e/harness/leaks.ts` (the audit),
`e2e/harness/secrets.ts` (helpers and the `w` fixture). Run: `npm run build`, then in `e2e/`:
`E2E_CHANNEL=chrome npx playwright test secrets`.

## What the audit checks

Every test registers its canary values (`leaks.watch`); after each passing test the `w` fixture looks for each value,
in plain text, base64 and hex, in:

| Place | How it is read |
|---|---|
| SQLite file, WAL, SHM, `secrets.enc`, outputs, workspaces, every other file in the data dir | every file under the data dir, raw bytes |
| Rewind snapshots (`checkpoints/`, a git store, objects compressed) | `git cat-file --batch-all-objects`, decompressed |
| Engine logs | the process's stdout and stderr, captured for the whole test |
| API responses | everything the page fetched, plus a sweep of every GET route (lists, each card, chat, document, memory, workflow) |
| WebSocket events | the page's frames, a second client on `/api/events`, and the in-process bus |
| What the model was sent | every request the scripted provider recorded (system prompt, tools, whole history) |

There is no export to audit: `api.ts` has no export or backup route (the only database copy is `db.backup`, used by the
tests' own throwaway engines). The data folder sweep above covers every file such a copy would contain; the rewind
snapshots are the only « export » of workspace files, and they are read too.

A control test plants a value in a file (base64), the logs, a chat message and checks that the audit reports each place:
an audit that finds nothing is not proof until it can find something.

Scenarios: add and grant; granted vs not granted agent; `echo $NAME` → `[secret NAME]` and the pill in the chat; replace
(live) and delete; `secret_set` by an agent (command form); a task blocked on a missing secret resumed by the value;
server: first password, restart locked, command stopped, wrong password, unlock, command works, Lock now. Print roads:
stdout, stderr, a failing command, background process + `shell_output` + its exit note, an output over 30000
characters saved to a file and read back with `read_file`, a rotation, `/compact`, and the chat open in the browser.

**Result: the value is outside the store nowhere the redactor reaches.** The two findings below were found by the audit.

## Known limits (pinned by tests in `secrets-leaks.spec.ts`, « known limits »)

The redactor replaces the exact stored value (8 characters or more) in a tool's output. It does not catch:

1. **A changed value**: base64, hex, reversed, cut in pieces over several lines or commands, one character at a time.
   The redactor cannot know what a program did to the value. The agent's instructions say never to print it.
2. **A value under 8 characters**: never hidden (it would match everywhere). The UI says so.
3. **An old value after a rotation or a delete**: only stored values are hidden, and the store forgets the old one.
   A log line or an old config file that still holds it comes out in the clear.
4. **A value the user types** in a chat (or in a task body, a comment): it is stored and sent to the model as typed;
   the redactor reads tool outputs only. Same for a `secret_set` with `value`: the provider saw the call (the
   transcript stores `[secret NAME]`), which is why `command` is the form to use.
5. **What the agent writes** from a command: `echo "$KEY" > file` leaves the value in the file (hidden only when the file
   is read through a tool). That file is then in: the files API (`/api/files/<agent>/…`), the rewind snapshot, and, for
   a markdown/html/svg file in `docs/`, `pages/`, `diagrams/`, **a Library artifact: its versions are rows of SQLite
   `document_versions`**, shown in the Library. → #226.
6. **Background process logs** (`outputs/<agent>/bg_*.log`) keep the raw value on disk. Reads and the exit note are
   redacted (tested), the file is not rewritten. Already in design §10b.
7. **A value split by the 30000-character cut** of a shell output: the tool keeps the last 30000 characters, then the
   runner hides values, so a value that straddles the cut is half there: its tail shows, unhidden. → #227.
   (The same shape exists in the live tail, which keeps the last 8000 characters before hiding: read in the code, not tested.)
8. **A command already running when Lock now is pressed** keeps its env, and its later output is no longer redacted
   for store values (design §10b).
9. **What the program does with the value**: a command can send it anywhere (a request to a server, a file outside the
   workdir). Granting a secret to an agent means trusting that agent with it.

Not covered by this task: model keys in the engine's environment (server mode), voice, plan sign-in tokens.
