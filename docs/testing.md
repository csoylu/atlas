# Testing

Moved out of `CLAUDE.md` (#295) so it is read when needed, not sent with every model request. CLAUDE.md points here.

## Tests (rule 6, in full)
6. **Tests:** `vitest`. Every engine module has tests; the restart test (rule 2) and the agent-loop test with a fake
   provider must stay green. `npm run typecheck && npm test` before every commit (`npm test` = fast project, ~10 s; `npm run test:full` also runs the slow project: real voice models + the 50-SIGKILL crash test + the real-Chrome screenshot test, `CRASH_KILLS=n` shortens the crash test. Run it when you touch voice, the store, runs or leases).
   **What runs where** (#254): CI's `test` job runs the fast project, the crash test (`CRASH_KILLS=30`) and the
   real-Chrome screenshot test on every PR and push to main. The voice suites run **only locally** (CI has no voice
   models; they skip without them): anyone touching voice runs `npm run test:full` before asking for review and states
   the result in the `task_request_review` summary.

## Writing tests
**Writing tests** (`packages/engine/test/kit`): never write your own sleep loop. `eventually(fn, {timeout, what})` waits for
the thing you need (a returned value, or an assertion that stops throwing); `retry(fn, {times, retryIf})` re-runs a flaky
operation; `launch({ script | provider, ...startEngineOptions })` gives a throwaway engine with every dependency injected
(the model, `updates.fetch`, `dbFile`, `leaseMs`…) that stops itself after the test. To order two things, make the first
signal the second (a marker file, an event), never `sleep(1500)`. A failed test is retried once and shown as retried: a
test that needs it is broken, fix it. Reproduce a timing flake under load: `yes > /dev/null &` ×8 and loop the test.

## Testing without installing
  - UI: `npm run build`, then `npm run ui:check -- --ui packages/ui/dist` (the local build against the running engine,
    read-only), or screenshots of a second engine (below).
  - Engine: a second engine on a copy of the database, never the live one: `sqlite3 <data>/atlas.db ".backup /tmp/x/atlas.db"`,
    then `startEngine({ dbFile: '/tmp/x/atlas.db', dataDir: '/tmp/x', port: 4388, dispatch: false, env: {}, uiDir: 'packages/ui/dist' })`
    (`dispatch: false` so it starts no runs and no schedules).
  - E2E: `e2e/` (Playwright, scripted model) on a local build.

## Test how-tos
- Under load (several agents, load average ~30) `npm test` fails at random (changelog, dispatcher, lifecycle, rewind,
  runner). Rerun the failing files alone (`npx vitest run --project fast <files>`, `--project slow` for voice) before
  calling it a regression.
- **Voice tests (`voiceLoop.test.ts`, slow project) run real Whisper and Supertonic, so their input is not repeatable**
  (#255): Supertonic draws new noise on every synthesis (two renders of « Yes, Master? » are never the same samples), and
  Whisper then writes « Yesta. », « Yes, Moss. » or « Yeter. Y » for what was said in ~1 run in 10 (not load: it happens
  at load 1; the barge-in itself never missed a stop word in ~75 runs, cut after 150–700 ms). Never assert one exact
  transcript of a model's reading of audio the test did not fix: assert what the loop does with it. A loop that
  mishandles a mis-heard transcript is a product bug: report it to atlas with the repro, and the test keeps failing
  until it is fixed (#257 did it for both above): no retry on a reading the loop should handle. A retry is only for a
  reading the scenario cannot use at all (the echo « yes do it » is a command, not an ack): check it with `heard` (the
  `onHeard` log), use the kit's `retry` with `retryIf` on a dedicated error and the reading in the log line, never a
  bare retry. Where the audio is the same and only the spelling varies, widen the regex (« kart ?a[çşc] »). Recipe: 20
  runs, one at a time (`for i in $(seq 20); do npx vitest run --project slow packages/engine/src/voiceLoop.test.ts;
  done`, ~2.5 min each; a second run on the machine is load).
- Engine tests with a scripted FakeProvider call `startEngine({ memoryReview: false, … })`, or the background memory
  review eats the script.
- E2E: `npm run build`, then in `e2e/`: `E2E_CHANNEL=chrome npx playwright test --reporter=line` (~20–50 s).
