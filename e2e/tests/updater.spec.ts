import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect } from '../harness/fixtures.ts';
import { TestAtlas } from '../harness/engine.ts';
import { text, shell } from '../harness/scripted.ts';
import { FakeGitHub, fakeApp } from '../../packages/engine/test/updaterKit.ts';

/**
 * QA of the app updater (#124, #123, docs/updater.md): the UI (badge, dialog, Settings → About) at 1440 and 390 px in both
 * themes, with screenshots in shots/updater/ (gitignored); and an update clicked while agents are working. A fake GitHub and a fake
 * Atlas.app in a temp folder: never the installed app or the live database. Mac only (the installer swaps a .app).
 */
test.skip(process.platform !== 'darwin', 'the updater installs a Mac .app bundle');

// screenshots land in e2e/shots/updater (gitignored)
const SHOTS = join(import.meta.dirname, '..', 'shots', 'updater');
mkdirSync(SHOTS, { recursive: true });

const NOTES = {
  '0.5.0': '## Fixed · #101 · Chats no longer lose the last message when the window is closed during a reply\n\nThe reply is saved before the window closes. No migration.',
  '0.5.1': '## Added · #102 · Agents can take a screenshot of Atlas or of a mockup in one step and see it\n\nNew `screenshot` tool.\n\n| option | meaning |\n|---|---|\n| `width` | page width in px |\n| `theme` | `dark` or `light` |\n\nUnder 500 px it shoots as a phone.',
  '0.6.0': '## Changed · #103 · Settings → About says when Atlas last looked for an update and why a check failed, with a deliberately long sentence to test wrapping on a phone screen',
  '0.6.1': '## Fixed · #104 · A very_long_unbroken_token_that_could_overflow_the_dialog_on_a_phone_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n\nSee packages/ui/src/components/very/deeply/nested/folder/with/a/long_file_name_that_never_breaks.tsx and `https://github.com/csoylu/atlas/blob/main/packages/engine/src/updater/apply_update_and_restart.ts`.',
  '0.7.0': '## Breaking · #105 · Settings are stored in a new place\n\nOpen Atlas once, nothing to do.',
};

interface Rig {
  atlas: TestAtlas;
  gh: FakeGitHub;
  apps: string;
  installed: string;
  quits: { n: number; onQuit: () => void };
  /** « Atlas » for the swap helper to wait for: quitting kills it, as the real app ending does. */
  proc: ChildProcess;
}

/** A `sleep` duration no other test, worker or copy of the suite uses: a test counts or finds its own commands by it (pgrep) without matching anyone else's. */
const uniqueSleep = () => 100_000 + Math.floor(Math.random() * 900_000);

async function rig(version = '0.4.0', releases: string[] = Object.keys(NOTES), install = true): Promise<Rig> {
  const gh = new FakeGitHub();
  await gh.listen();
  for (const v of releases) gh.publish(v, { body: NOTES[v as keyof typeof NOTES] ?? `## Fixed · notes of ${v}`, zip: v === releases.at(-1) });
  const apps = mkdtempSync(join(tmpdir(), 'atlas e2e upd-'));
  const installed = fakeApp(apps, version);
  const quits = { n: 0, onQuit: () => {} };
  const proc = spawn('sleep', ['300']);
  const atlas = await TestAtlas.start({
    version,
    updates: {
      host: install ? { appPath: installed, arch: 'arm64', quit: () => (quits.n++, quits.onQuit(), proc.kill()) } : null,
      cannotInstall: install ? undefined : 'Atlas runs from /tmp/x: updates install in /Applications/Atlas.app only.',
      api: gh.url,
      intervalMs: false,
      openCommand: 'true',
      pid: proc.pid,
    },
  });
  return { atlas, gh, apps, installed, quits, proc };
}
const versionOf = (app: string) => execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]).toString().trim();

/** WCAG contrast of an element's text colour on its effective background (nearest opaque ancestor). */
async function contrast(page: Page, selector: string): Promise<{ sel: string; ratio: number; text: string }[]> {
  return page.evaluate((sel) => {
    const parse = (c: string) => (/rgba?\(([^)]+)\)/.exec(c)?.[1] ?? '0,0,0,0').split(/[ ,/]+/).filter(Boolean).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
    };
    const bgOf = (el: Element): number[] => {
      let acc: number[] = [0, 0, 0, 0];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const [r, g, b, a = 1] = parse(getComputedStyle(e).backgroundColor);
        if (a > 0) {
          // composite over what is below
          const below = e.parentElement ? bgOf(e.parentElement) : [255, 255, 255];
          return [r! * a + below[0]! * (1 - a), g! * a + below[1]! * (1 - a), b! * a + below[2]! * (1 - a)];
        }
      }
      return acc.length === 3 ? acc : [255, 255, 255];
    };
    const out: { sel: string; ratio: number; text: string }[] = [];
    for (const el of document.querySelectorAll(sel)) {
      if (!(el as HTMLElement).offsetParent && getComputedStyle(el).position !== 'fixed') continue;
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
      if (!own) continue;
      const [r, g, b, a = 1] = parse(getComputedStyle(el).color);
      const bg = bgOf(el);
      const fg = [r! * a + bg[0]! * (1 - a), g! * a + bg[1]! * (1 - a), b! * a + bg[2]! * (1 - a)];
      const l1 = lum(fg), l2 = lum(bg);
      out.push({ sel, ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05), text: (el.textContent ?? '').trim().slice(0, 40) });
    }
    return out;
  }, selector);
}

const TEXT = ['.update-badge-label', '.update-badge-v', '.update-dialog h2', '.update-dialog p', '.update-v', '.update-kind', '.update-task', '.update-note-title', '.update-note-body p', '.update-note-body td', '.update-note-body th', '.update-agent', '.update-work-title', '.update-dialog .state-err', '.update-fine', '.update-progress span', '.update-actions button', '.update-about-line', '.update-about-acts button'];

async function layoutOk(page: Page, dialog: boolean) {
  const m = await page.evaluate(() => {
    const d = document.querySelector('.update-dialog')?.getBoundingClientRect();
    return { scroll: document.documentElement.scrollWidth, w: innerWidth, h: innerHeight, dialog: d ? { l: d.left, r: d.right, t: d.top, b: d.bottom } : null };
  });
  expect(m.scroll, 'page scrolls sideways').toBeLessThanOrEqual(m.w);
  if (dialog) {
    expect(m.dialog, 'dialog is open').not.toBeNull();
    expect(m.dialog!.l).toBeGreaterThanOrEqual(0);
    expect(m.dialog!.r).toBeLessThanOrEqual(m.w);
    expect(m.dialog!.t).toBeGreaterThanOrEqual(0);
    expect(m.dialog!.b).toBeLessThanOrEqual(m.h);
    // the buttons are reachable without scrolling the page
    await expect(page.locator('.update-actions button').last()).toBeInViewport();
  }
  // nothing inside the dialog wider than the dialog
  if (dialog) {
    const wide = await page.evaluate(() => {
      const d = document.querySelector('.update-dialog')!;
      return [...d.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > d.getBoundingClientRect().right + 1).map((e) => e.className || e.tagName).slice(0, 5);
    });
    expect(wide, 'children overflow the dialog').toEqual([]);
  }
}
async function readable(page: Page) {
  const bad: string[] = [];
  for (const sel of TEXT) for (const c of await contrast(page, sel)) if (c.ratio < 4.5) bad.push(`${sel} "${c.text}" ${c.ratio.toFixed(2)}`);
  expect(bad, 'text under 4.5:1').toEqual([]);
}

const VIEWS = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
] as const;
const THEMES = ['dark', 'light'] as const;

for (const theme of THEMES)
  for (const v of VIEWS)
    test(`UI · ${v.w}px ${theme}: badge, notes dialog with agents working, downloading, failed, About`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: v.w, height: v.h });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      const r = await rig();
      try {
        const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}-${v.w}-${theme}.png`) });
        // two agents working, so the dialog lists them
        const uniq = uniqueSleep();
        r.atlas.model.next(shell(`sleep ${uniq}`, 't1'), shell(`sleep ${uniq}`, 't2'));
        r.atlas.engine.agents.create({ id: 'munih', modelId: 'sonnet' });
        await r.atlas.task('Fix the sidebar contrast on a deliberately long task title to see the ellipsis', 'atlas');
        await r.atlas.task('Build the thing', 'munih');
        await expect.poll(() => r.atlas.model.of('main').length).toBeGreaterThanOrEqual(2);
        await r.atlas.engine.updater.check();

        // badge
        await page.goto(r.atlas.url + '/#/inbox');
        if (v.w < 500) await page.getByRole('button', { name: 'More', exact: true }).click();
        const badge = page.locator('.update-badge');
        await expect(badge).toBeVisible();
        await expect(badge).toContainText('Update available');
        await expect(badge).toContainText('0.7.0');
        await expect(badge).toHaveAttribute('title', /0\.7\.0/);
        await layoutOk(page, false);
        await readable(page);
        await shot('1-badge');

        // dialog
        await badge.click();
        const dialog = page.getByRole('dialog', { name: /Update to Atlas 0\.7\.0/ });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('You have Atlas 0.4.0');
        await expect(dialog).toContainText('5 versions came out since; updating installs the latest.');
        await expect(dialog.locator('.update-note')).toHaveCount(5);
        expect(await dialog.locator('.update-v').allTextContents()).toEqual(['0.7.0', '0.6.1', '0.6.0', '0.5.1', '0.5.0']); // newest first
        await expect(dialog.locator('.update-kind').first()).toHaveText('Breaking');
        await expect(dialog.locator('table')).toBeVisible(); // markdown in the notes renders
        await expect(dialog).toContainText('2 agents are working now: they stop for the restart and resume after it.');
        await expect(dialog.locator('.update-working li')).toHaveCount(2);
        await expect(dialog.getByRole('button', { name: 'Update and restart' })).toBeEnabled();
        await layoutOk(page, true);
        await readable(page);
        await shot('2-dialog');
        await dialog.locator('.update-notes').evaluate((e) => (e.scrollTop = e.scrollHeight)); // the oldest notes at the bottom
        await shot('2b-dialog-scrolled');
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0); // Esc closes it, nothing was installed
        expect(r.quits.n).toBe(0);

        // About
        await page.goto(r.atlas.url + '/#/settings/about');
        await expect(page.locator('.update-about-line')).toContainText('Atlas 0.7.0 is available');
        await expect(page.getByRole('button', { name: "See what's new" })).toBeVisible();
        await layoutOk(page, false);
        await readable(page);
        await shot('3-about-available');

        // a failed check: the error is said, the update found before is kept
        r.gh.status = 429;
        await page.getByRole('button', { name: 'Check now' }).click();
        await expect(page.locator('.update-about-line.bad')).toContainText('The last check failed');
        await expect(page.locator('.update-about-line.bad')).toContainText('GitHub answered 429');
        await expect(page.getByRole('button', { name: "See what's new" })).toBeVisible();
        await layoutOk(page, false);
        await readable(page);
        await shot('4-about-check-failed');
        r.gh.status = 200;
        await page.getByRole('button', { name: 'Check now' }).click();
        await expect(page.locator('.update-about-line.bad')).toHaveCount(0);

        // downloading: progress, Later/Esc disabled while busy
        r.gh.stallAfter = 200_000; // the zip stops at 200 kB and the connection stays open
        await page.goto(r.atlas.url + '/#/inbox');
        if (v.w < 500) await page.getByRole('button', { name: 'More', exact: true }).click();
        await page.locator('.update-badge').click();
        await page.getByRole('button', { name: 'Update and restart' }).click();
        await expect(page.locator('.update-progress')).toContainText(/Downloading/);
        await expect(page.getByRole('button', { name: 'Later' })).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Update and restart' })).toBeDisabled();
        await layoutOk(page, true);
        await readable(page);
        await shot('5-downloading');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: /Update to/ })).toBeVisible(); // busy: Esc does not close
        // cut the download: the dialog says so, offers Try again, nothing is installed
        r.gh.stallAfter = null;
        r.gh.server.closeAllConnections();
        await expect.poll(async () => (await fetch(r.atlas.url + '/api/update').then((x) => x.json())).phase, { timeout: 30_000 }).toBe('failed');
        await expect(page.locator('.modal .state-err')).toContainText(/The download of 0\.7\.0 failed/);
        await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
        await expect(page.getByRole('button', { name: 'Later' })).toBeEnabled();
        await layoutOk(page, true);
        await readable(page);
        await shot('6-failed');
        expect(versionOf(r.installed)).toBe('0.4.0');
        expect(r.quits.n).toBe(0);
        await page.getByRole('button', { name: 'Later' }).click();
        await page.goto(r.atlas.url + '/#/inbox');
        if (v.w < 500) await page.getByRole('button', { name: 'More', exact: true }).click();
        await expect(page.locator('.update-badge')).toContainText('Update failed');
        await readable(page);
        await shot('7-badge-failed');
      } finally {
        r.proc.kill();
        await r.atlas.stop();
        await r.gh.close();
      }
    });

test('UI · up to date, a newer version installed than the release (older release), and an app that cannot install by itself', async ({ page }) => {
  for (const [name, version, releases, install] of [
    ['uptodate', '0.5.0', ['0.5.0'], true],
    ['older', '0.9.0', ['0.5.0', '0.6.0'], true],
    ['cannot', '0.4.0', ['0.5.0'], false],
  ] as const) {
    const r = await rig(version, [...releases], install);
    try {
      await r.atlas.engine.updater.check();
      await page.goto(r.atlas.url + '/#/inbox');
      if (name === 'cannot') {
        await expect(page.locator('.update-badge')).toContainText('Update available');
        await page.locator('.update-badge').click();
        await expect(page.getByRole('button', { name: 'Update and restart' })).toBeDisabled();
        await expect(page.locator('.update-fine')).toContainText('updates install in /Applications/Atlas.app only');
      } else {
        await expect(page.locator('.update-badge')).toHaveCount(0); // no badge when there is nothing to install
        await page.goto(r.atlas.url + '/#/settings/about');
        await expect(page.locator('.update-about-line')).toContainText(/^Up to date/);
        await expect(page.getByRole('button', { name: "See what's new" })).toHaveCount(0);
      }
    } finally {
      r.proc.kill();
      await r.atlas.stop();
      await r.gh.close();
    }
  }
});

test('an update clicked while two agents are working: they stop with Atlas, resume after the restart, nothing is lost', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const r = await rig('0.4.0', ['0.5.0']);
  try {
    const uniq = uniqueSleep();
    const running = () => { try { return execFileSync('pgrep', ['-f', `sleep ${uniq}$`]).toString().trim().split('\n').length; } catch { return 0; } };
    const sleeping = (req: { messages: unknown[] }) => JSON.stringify(req.messages).includes('"tool_use"');
    // first answer of each run: a long command; after the restart the run is asked again and finishes
    const reply = (id: string) => (req: { messages: unknown[] }) => (sleeping(req) ? text('Finished after the update') : shell(`sleep ${uniq}`, id));
    r.atlas.model.next(reply('t1'), reply('t2'), reply('t3'), reply('t4'));
    r.atlas.engine.agents.create({ id: 'munih', modelId: 'sonnet' });
    const a = await r.atlas.task('Task for atlas', 'atlas');
    const m = await r.atlas.task('Task for munih', 'munih');
    await expect.poll(() => r.atlas.model.of('main').length).toBe(2);
    // both commands are running
    await expect.poll(running, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    const before = {
      a: (await r.atlas.messages(a.id)).length,
      m: (await r.atlas.messages(m.id)).length,
    };
    expect(before.a).toBeGreaterThanOrEqual(2); // the task text and the tool call are saved
    await r.atlas.engine.updater.check();

    // Master clicks Update and restart. The desktop app's quit → engine.stop() (main.ts before-quit); here the same.
    const stopped = new Promise<void>((res) => (r.quits.onQuit = () => void r.atlas.engine.stop().finally(res)));
    await page.goto(r.atlas.url + '/#/inbox');
    await page.locator('.update-badge').click();
    const dialog = page.getByRole('dialog', { name: /Update to Atlas 0\.5\.0/ });
    await expect(dialog.locator('.update-working li')).toHaveText([/@atlas.*#\d+.*Task for atlas/, /@munih.*#\d+.*Task for munih/], { timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Update and restart' }).click();
    await stopped;
    expect(r.quits.n).toBe(1);

    // the helper replaces the app once Atlas has gone, and opens the new one
    await expect.poll(() => versionOf(r.installed), { timeout: 15_000 }).toBe('0.5.0');
    // the old runs are interrupted, not failed (the database is closed: read it through the new engine)
    await r.atlas.restart({ version: '0.5.0' });
    await expect.poll(async () => (await r.atlas.card(a.id)).status, { timeout: 30_000 }).toBe('blocked');
    await expect.poll(async () => (await r.atlas.card(m.id)).status, { timeout: 30_000 }).toBe('blocked');
    const runs = r.atlas.db('SELECT card_id, status, error FROM runs ORDER BY started_at') as { card_id: string; status: string; error: string | null }[];
    for (const id of [a.id, m.id]) {
      const mine = runs.filter((x) => x.card_id === id).map((x) => x.status);
      expect(mine, `runs of ${id}`).toEqual(['interrupted', 'done']);
    }
    // nothing lost: every earlier message is still there, in order, and the new answer follows
    for (const [id, n, done] of [[a.id, before.a, 'Finished after the update'], [m.id, before.m, 'Finished after the update']] as const) {
      const msgs = await r.atlas.messages(id);
      expect(msgs.length).toBeGreaterThan(n);
      expect(JSON.stringify(await (await fetch(r.atlas.url + `/api/cards/${id}/messages`)).json())).toContain(done);
    }
    // the resumed model call saw the task and its own earlier tool call
    const resumed = r.atlas.model.of('main').slice(2);
    expect(resumed).toHaveLength(2);
    for (const c of resumed) {
      expect(c.text).toMatch(/Task for (atlas|munih)/);
      expect(c.text).toContain(`sleep ${uniq}`);
      expect(c.text).toContain('interrupted by a restart');
    }
    // no command left running from before the restart (the old engine's stop() kills them: ~1 s, not instant)
    await expect.poll(running, { timeout: 20_000, message: 'commands from before the restart still running' }).toBe(0);
    // the new engine says it was updated
    await page.goto(r.atlas.url + '/#/settings/about');
    await expect(page.locator('.update-fine')).toContainText('Updated from 0.4.0 to 0.5.0');
    expect(r.atlas.db('SELECT 1 FROM app_update')).toBeTruthy();
  } finally {
    r.proc.kill();
    await r.atlas.stop();
    await r.gh.close();
  }
});

// Found by the screenshots of #124 (#163): a release title or note with a long unbroken token (a path, a URL) was clipped
// and the notes box scrolled sideways, at 1440 and at 390 px. Title and notes now wrap anywhere.
for (const width of [1440, 390]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`UI · a long unbroken word in the release notes wraps instead of scrolling sideways (${width} px, ${theme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
      const r = await rig('0.4.0', ['0.6.1']);
      try {
        await r.atlas.engine.updater.check();
        await page.goto(r.atlas.url + '/#/inbox');
        if (width < 500) await page.getByRole('button', { name: 'More', exact: true }).click();
        await page.locator('.update-badge').click();
        const notes = page.locator('.update-notes');
        await expect(notes).toContainText('long_file_name_that_never_breaks');
        const over = await notes.evaluate((e) => e.scrollWidth - e.clientWidth);
        expect(over, 'px of sideways scroll in the notes box').toBeLessThanOrEqual(0);
        for (const sel of ['.update-note-title', '.update-note-body p']) {
          const clipped = await page.locator(sel).first().evaluate((e) => e.scrollWidth - e.clientWidth);
          expect(clipped, `px clipped in ${sel}`).toBeLessThanOrEqual(0);
        }
        await page.screenshot({ path: join(SHOTS, `long-word-${width}-${theme}.png`) });
      } finally {
        r.proc.kill();
        await r.atlas.stop();
        await r.gh.close();
      }
    });
  }
}
