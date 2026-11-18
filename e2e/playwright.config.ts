import { defineConfig } from '@playwright/test';

/**
 * Atlas end-to-end tests: a real engine (in this process, FakeProvider-style scripted model, temp data dir) serving the
 * built UI (`npm run build` at the repo root first), driven by headless Chromium. One engine per test: see harness/.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: 'results',
  use: {
    viewport: { width: 1280, height: 860 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    ...(process.env.E2E_CHANNEL ? { channel: process.env.E2E_CHANNEL } : {}),
  },
});
