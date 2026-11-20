import { configDefaults, defineConfig } from 'vitest/config';
import RetryReporter from './scripts/test/retryReporter.ts';

// Two projects (QA, 17 Nov 2026):
//  - fast: everything except the slow suites. This is `npm test`; it runs in seconds and is what tasks should run.
//  - slow: real voice models (real-time audio, CPU-timing sensitive) and the 50-SIGKILL crash test. They run
//          one file at a time so they do not starve each other (parallel runs made the voice timing asserts flaky).
//          `npm run test:full` runs both. Where they run (#254):
//            - CI (job `test`, every PR and push to main): the fast project, then the crash test with CRASH_KILLS=30 and
//              the real-Chrome screenshot test (after a UI build).
//            - Local only: the voice suites. They need the local models, which CI does not download (they skip without
//              them). Anyone touching voice runs `npm run test:full` before asking for review and states the result in
//              the review request.
const include = ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'scripts/**/*.test.ts'];
const slow = [
  'packages/engine/test/crash.test.ts',
  'packages/engine/test/projects-crash.test.ts',
  'packages/engine/test/screenshot.chrome.test.ts',
  'packages/engine/test/sandbox.isolation.test.ts',
  'packages/voice/**/*.test.ts',
  'apps/desktop/src/voice.test.ts',
  'packages/engine/src/voiceLoop.test.ts',
  'packages/engine/src/voice.test.ts',
];

// A failed test runs again once (twice in CI) and vitest marks it as retried, so a flaky test is visible, not hidden. A test
// that needs its retry is a bug in the test: fix it (see packages/engine/test/kit). TEST_RETRY=0 turns it off.
// scripts/test/retryReporter.ts lists every test that passed on a retry by name (console + GitHub warning) (#178).
const retry = Number(process.env.TEST_RETRY ?? (process.env.CI ? 2 : 1));

export default defineConfig({
  test: {
    // vitest's own list (default or minimal for agents, + github-actions on CI: annotations and the job summary), plus ours.
    reporters: [...configDefaults.reporters, new RetryReporter()],
    projects: [
      { test: { name: 'fast', include, exclude: [...slow, '**/node_modules/**'], retry } },
      { test: { name: 'slow', include: slow, fileParallelism: false, testTimeout: 120_000 } },
    ],
  },
});
