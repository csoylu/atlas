import { defineConfig } from '@playwright/test';
import { findBrowser } from '../scripts/ui-check/tooling.mjs';

// Headless Chromium that needs no window and no LaunchServices, so the suite runs in an agent's sandbox (#314): ATLAS_CHROME,
// else Playwright's chrome-headless-shell wherever it is installed (the real home's cache too: HOME is the workspace in the
// sandbox); none found = Playwright's own lookup (and its « run playwright install » error). E2E_CHANNEL=chrome: Chrome.app.
const executablePath = process.env.E2E_CHANNEL ? undefined : (findBrowser({ install: false }) ?? undefined);

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
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
