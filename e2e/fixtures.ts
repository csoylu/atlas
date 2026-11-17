import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import type { Browser } from 'playwright-core';
import { launchBrowser, startApp, type App } from './harness.ts';
import { openChat, type ChatPage } from './chat.ts';

/**
 * The lifecycle every E2E file shares: one Chrome per file, a fresh engine + a fresh direct chat per test, and every test
 * ends by asserting the page raised no error. Call it at the top of a file; read `t.chat` / `t.app` inside tests.
 */
export function useChat(): { readonly app: App; readonly chat: ChatPage } {
  let browser: Browser;
  const t = {} as { app: App; chat: ChatPage };
  beforeAll(async () => {
    browser = await launchBrowser();
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(async () => {
    t.app = await startApp(browser);
    t.chat = await openChat(t.app);
  });
  afterEach(async () => {
    const errors = t.app.errors;
    await t.app.stop();
    expect(errors).toEqual([]);
  });
  return t;
}
