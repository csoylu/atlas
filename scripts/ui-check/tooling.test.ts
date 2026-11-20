import { describe, expect, it, onTestFinished } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventually } from '../../packages/engine/test/kit/index.ts';
import { browserArgs, findBrowser, startThrowawayEngine } from './tooling.mjs';

/** A fake Playwright cache with the given revisions of chromium_headless_shell. */
function cache(...revs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-tooling-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  for (const r of revs) {
    const inner = join(dir, `chromium_headless_shell-${r}`, 'chrome-headless-shell-mac-arm64');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'chrome-headless-shell'), '#!/bin/sh\n');
    chmodSync(join(inner, 'chrome-headless-shell'), 0o755);
  }
  return dir;
}

describe('findBrowser (#314)', () => {
  it('ATLAS_CHROME wins; a missing one is an error, never a fallback', () => {
    const dir = cache('1200');
    const own = join(dir, 'my-chrome');
    writeFileSync(own, '');
    expect(findBrowser({ env: { ATLAS_CHROME: own, PLAYWRIGHT_BROWSERS_PATH: dir } })).toBe(own);
    expect(() => findBrowser({ env: { ATLAS_CHROME: join(dir, 'nope'), PLAYWRIGHT_BROWSERS_PATH: dir } })).toThrow(/ATLAS_CHROME is set to .*nope.*does not exist/);
  });

  it("takes the newest chrome-headless-shell of Playwright's cache (PLAYWRIGHT_BROWSERS_PATH first)", () => {
    const dir = cache('999', '1255', '1100');
    expect(findBrowser({ env: { PLAYWRIGHT_BROWSERS_PATH: dir }, install: false })).toBe(join(dir, 'chromium_headless_shell-1255', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'));
  });

  it('a revision folder without the binary is not a browser', () => {
    const dir = cache();
    mkdirSync(join(dir, 'chromium_headless_shell-1300'));
    const found = findBrowser({ env: { PLAYWRIGHT_BROWSERS_PATH: dir }, install: false });
    expect(found === null || !found.startsWith(dir)).toBe(true);
  });
});

describe('browserArgs (#314)', () => {
  it('the headless shell gets --no-sandbox and no --headless; a real Chrome gets both', () => {
    const o = { port: 9333, profile: '/p' };
    const shell = browserArgs('/c/chrome-headless-shell', o);
    expect(shell).toContain('--no-sandbox');
    expect(shell).not.toContain('--headless=new');
    expect(shell).toContain('--remote-debugging-port=9333');
    expect(shell).toContain('--user-data-dir=/p');
    expect(browserArgs('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', o)).toEqual(expect.arrayContaining(['--headless=new', '--no-sandbox']));
  });
});

describe('the throwaway engine (#314)', () => {
  it('starts on a seeded database, serves the UI it is given, and removes its data when stopped', async () => {
    const ui = mkdtempSync(join(tmpdir(), 'atlas-tooling-ui-'));
    onTestFinished(() => rmSync(ui, { recursive: true, force: true }));
    writeFileSync(join(ui, 'index.html'), '<!doctype html><title>seeded</title>');
    const before = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith('atlas-ui-check-data-')));
    const { base, stop } = await startThrowawayEngine({ ui });
    try {
      expect(await (await fetch(base + '/')).text()).toContain('seeded');
      const chats = (await (await fetch(base + '/api/chats')).json()) as unknown[];
      const cards = (await (await fetch(base + '/api/cards')).json()) as { status: string }[];
      const docs = (await (await fetch(base + '/api/documents')).json()) as { kind: string }[];
      expect(chats.length).toBeGreaterThanOrEqual(2);
      expect([...new Set(cards.map((c) => c.status))]).toEqual(expect.arrayContaining(['triage', 'todo', 'ready', 'done']));
      expect(new Set(docs.map((d) => d.kind))).toEqual(new Set(['markdown', 'html', 'diagram', 'url']));
      const agents = (await (await fetch(base + '/api/agents')).json()) as { id: string }[];
      expect(agents.map((a) => a.id)).toEqual(['atlas', 'munih', 'paris', 'zurich']);
    } finally {
      stop();
    }
    // stop() asks the engine process to go; it removes its data dir on the way out.
    await eventually(() => {
      const left = readdirSync(tmpdir()).filter((d) => d.startsWith('atlas-ui-check-data-') && !before.has(d));
      expect(left).toEqual([]);
    }, { timeout: 30_000, what: 'the throwaway engine removed its data dir' });
  }, 120_000);
});
