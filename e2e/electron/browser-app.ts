// The Electron app of e2e/tests/browser-electron.spec.ts (#298 S6): the real engine in-process with the desktop's
// ElectronBrowser, on the data dir in ATLAS_E2E_DIR, no model, no dispatch. Bundled by the spec (esbuild) and started
// with Playwright's `_electron.launch`. The spec reaches the engine through its HTTP API (globalThis.__atlas.url) and
// the views through globalThis.__atlas.host.
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { startEngine } from '../../packages/engine/src/index.ts';
import { ElectronBrowser } from '../../apps/desktop/src/browser.ts';

const dataDir = process.env.ATLAS_E2E_DIR!;
let win: BrowserWindow | null = null;
// Browser profiles (partitions) in the test's own dir, never the user's Electron data.
app.setPath('userData', join(dataDir, 'electron'));

app.whenReady().then(async () => {
  const host = new ElectronBrowser(() => win);
  const events: unknown[] = [];
  const engine = await startEngine({
    dbFile: join(dataDir, 'atlas.db'),
    dataDir,
    port: 0,
    dispatch: false,
    manageLocal: false,
    memoryReview: false,
    env: {},
    browser: host,
    prs: { read: async () => { throw new Error('no GitHub in e2e'); }, intervalMs: false },
  });
  engine.bus.on((e) => events.push(e));
  win = new BrowserWindow({ width: 1200, height: 800, show: process.env.E2E_SHOW === '1', webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('data:text/html,<title>Atlas (e2e)</title><body>Atlas window</body>');
  (globalThis as Record<string, unknown>).__atlas = { url: engine.url, host, engine, events, win };
  app.on('before-quit', () => void engine.stop());
});
