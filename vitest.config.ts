import { defineConfig } from 'vitest/config';

// Two projects (QA, 17 Nov 2026):
//  - fast: everything except the slow suites. This is `npm test`; it runs in seconds and is what tasks should run.
//  - slow: real voice models (real-time audio, CPU-timing sensitive) and the 50-SIGKILL crash test. They run
//          one file at a time so they do not starve each other (parallel runs made the voice timing asserts flaky).
//          `npm run test:full` runs both; CI / before a release / when you touched voice or the store.
const include = ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'scripts/**/*.test.ts'];
const slow = [
  'packages/engine/test/crash.test.ts',
  'packages/voice/**/*.test.ts',
  'apps/desktop/src/voice.test.ts',
  'packages/engine/src/voiceLoop.test.ts',
  'packages/engine/src/voice.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'fast', include, exclude: [...slow, '**/node_modules/**'] } },
      { test: { name: 'slow', include: slow, fileParallelism: false, testTimeout: 120_000 } },
    ],
  },
});
