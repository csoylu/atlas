# Projects: end-to-end tests and isolation audit (#218, 19 Nov 2026)

Build tested: `main` at 81370e3 (#213–#217, #236–#248 in); the regression and ui-check runs of §3 were made on 38588ee. Tests: `e2e/tests/projects-flow.spec.ts`, `projects-isolation.spec.ts`
(harness `e2e/harness/projects.ts`), `packages/engine/test/projects-crash.test.ts`, `packages/engine/src/projectRemovalRestart.test.ts`,
tools `e2e/tools/single-project-regression.ts` and `compare-shots.mjs`. Run: `npm run build`, then in `e2e/`:
`E2E_CHANNEL=chrome npx playwright test projects-`.

## 1. End to end (`projects-flow`, 3 tests, scripted model, local bare repos as GitHub, fake gh)
Create from a repo (check → cloning → ready), an Atlas agent joins and its second chat shows in the sidebar, a task created from the board
with the filter on the project runs in the new workspace, the PR flow on the second repo to Done, remove the member, archive.
Clone failures: a repo that can't be cloned says why, a run there fails loudly, « Try again » clones once reachable; a mistyped repo is fixed
(« Fix the repo name », check, Save) and every failed member clones the right one.

## 2. Isolation audit (`projects-isolation`, canaries in CLAUDE.md, a project memory, a secret, an artifact, a task; both directions)
Each direction has a positive control (the probe sees every canary of its own project, so « not found » elsewhere means « not reachable »).
- **No canary of the other project** in: provider requests (system prompt, tools, history; recorded by the fake provider), tool results,
  stored messages, the agent's env, memory / artifact / task tools (the other project's ids are refused), history search. **Pass, A→B and B→A.**
- **File tools**: B→A refused (« outside the workspace ») for read, write, edit; A→B **fails**: see bug 1.
- **Shell**: not confined, both ways (accepted limit below).

| # | Finding | Status |
|---|---|---|
| 1 | In the home project an agent's workdir `workspaces/<agent>` contains its clone `workspaces/<agent>/<project>`: file tools read and write the other project's clone | bug, **#245**, fixed (clones moved to `data/projects/<project>/<agent>`); the test is a plain test now |
| 2 | The shell reads and writes the other project's workspace by absolute path (both directions) | **accepted limit** (Master, 19 Nov, no sandbox for now), documented by #248; pinned as current behaviour: flips if a sandbox is built |
| 3 | Member removed, then a kill before its run ended: the next start resumes that run (« continue » kick on the lead's card, run fails « not a member ») | bug, **#246**, fixed (recover stops the run); the test is a plain test now |
| 4 | `shellEnv.test.ts` « a git commit … configured email » fails on main on this machine (global git config) | **#247**, fixed (test isolation), not projects |

## 3. Single-project regression
`npx tsx e2e/tools/single-project-regression.ts <copy of atlas.db>` on (a) a backup of the live database at 0055 and (b) the 0.43.1 backup at
migration 0050 (migrated by this build): integrity and foreign-key checks ok; no row lost in any table (messages, runs… may only grow: a start
closes what the last stop left open); one project, every task / chat / document / folder in it, every member home and ready; all 268 cards
with messages answer over the API with every message they showed; every agent keeps the same main chat (also via `POST /agents/:id/main-chat`);
the due workflow (`sch_memory_cleanup`, due time set in the past on the copy) starts a run, makes its task, moves `next_run_at` on, records no
error. **All checks pass on both.**

UI: ui-check of the pre-projects build (5da7ea1, `packages/ui/dist` built in a worktree) vs this build, same engine on a copy of the live
database, 264 screens vs 264 (+32 new `-2` and projects screens): both « no issues ». Pixel diff (tolerance 8/255 per channel):
105 screenshots identical, the rest < 0.5 % (anti-aliasing and live data such as « checked N min ago »). Above 0.5 %, all explained:
- `settings-*` at 1440 / 1100 (~1.3–2 %): the new « Projects » entry first under Team moves the nav list down one row (checked on About & data).
- `settings-projects`: new page. `task-list`, `task-chat`, `task-inbox`: the open task's chat scrolled to a slightly different point (the
  bottom « Interrupted » row is in one shot and not in the other; same content, a scroll race, not a layout change).
Nothing else moved. The single-project app looks as before.

**Safety (found in review, fixed):** a `.backup` of the live database carries the pids of the shells running at that moment, and an engine
started on the copy kills them as orphans once their copied lease expires. The tool now sets `pid = NULL` on every running tool call and
background process of the copy before the first start, and ends with a check: a live process planted in the copy (a tool call and a background
process) must survive both engines. Without the neutralising lines the check fails (the planted process is killed); with them it passes. The
runs of this report made before the fix used the same copies, so they may have signalled the pids of shells that were running in the live app then;
I can't tell which. Canvases the live app made after the last conversion are converted at start (one document and one version each): the tool
expects exactly those new rows.

## 4. Crash
- `projects-crash.test.ts` (slow project): random SIGKILL during a clone (partial folder on disk): the last engine clones each member once,
  whole, no `partial.txt`, no `.cloning` leftovers, state ready. Random SIGKILL around a member's removal: either still a member (nothing
  of the removal happened) or removed with the tasks in the lead's triage, chat archived, workspace kept; never in between. Default 20 kills per
  test (`CRASH_KILLS=n`), 4 and 20 run green.
- `npm run test:full`: fast project green (#247's test is fixed on main); slow project: `crash.test.ts` (50 kills), `projects-crash`,
  `screenshot.chrome` green; `voiceLoop.test.ts` « #52 a card report during a spoken turn… » fails, and it fails identically on main without
  these changes (stash test), so it is not from this PR (timing under load).
