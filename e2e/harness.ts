import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { Card } from '@atlas/shared';
import { startEngine, type Engine } from '../packages/engine/src/index.ts';
import { E2EProvider } from './provider.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const UI_DIST = join(ROOT, 'packages/ui/dist');

const CHROMES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((p): p is string => !!p);

/** One headless Chrome for a test file. Fails loudly when there is none (set CHROME_PATH). */
export async function launchBrowser(): Promise<Browser> {
  const executablePath = CHROMES.find((p) => existsSync(p));
  if (!executablePath) throw new Error('E2E needs Google Chrome or Chromium: install it or set CHROME_PATH');
  return chromium.launch({ executablePath, headless: true });
}

export interface App {
  engine: Engine;
  provider: E2EProvider;
  page: Page;
  /** Engine + UI on one origin (the engine serves packages/ui/dist). */
  url: string;
  /** A fresh direct chat with the default agent, opened in the page. */
  newChat(): Promise<Card>;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  /** Page errors seen so far (uncaught exceptions, console errors): a test ends by asserting there are none. */
  errors: string[];
  stop(): Promise<void>;
}

/**
 * A real engine (in-memory SQLite, scripted model) serving the built UI, and a page on it. Nothing is mocked between
 * the browser and the engine: the page talks to the real HTTP API and WebSocket.
 */
export async function startApp(browser: Browser): Promise<App> {
  if (!existsSync(join(UI_DIST, 'index.html'))) throw new Error('packages/ui/dist is missing: run `npm -w @atlas/ui run build` (the e2e project does it in its global setup)');
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-e2e-'));
  const provider = new E2EProvider();
  const engine = await startEngine({ dbFile: ':memory:', dataDir, port: 0, uiDir: UI_DIST, providers: () => provider, manageLocal: false, memoryReview: false });
  mkdirSync(join(dataDir, 'workspaces', 'atlas'), { recursive: true });
  // The user is introduced (else the « Welcome to Atlas » form covers the page).
  await fetch(engine.url + '/api/settings', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userName: 'Tester', userAbout: 'QA engineer running the E2E suite' }) });
  const context: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  const api = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(engine.url + '/api' + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return (r.status === 204 ? undefined : await r.json()) as T;
  };
  return {
    engine,
    provider,
    page,
    url: engine.url,
    errors,
    api,
    async newChat() {
      const card = await api<Card>('POST', '/agents/atlas/chats');
      await page.goto(`${engine.url}/#/chat/${card.id}`);
      await page.locator('.composer textarea').waitFor();
      return card;
    },
    async stop() {
      await context.close();
      await engine.stop().catch(() => {});
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
