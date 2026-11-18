import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/events.ts';
import { openDb, type Db } from '../src/store/db.ts';
import { HELPER, Updater, zipName, type UpdaterOptions } from '../src/updater.ts';
import { FakeGitHub, fakeApp, sha, zipOf } from './updaterKit.ts';

/**
 * QA of the app updater (#124): the cases the build task's own tests (src/updater.test.ts) do not cover. Everything runs
 * against a fake release server and fake Atlas.app bundles in temp folders: never the installed app or the live database.
 * Cases still done by hand are listed in docs/qa/124-updater-report.md.
 */
const mac = process.platform === 'darwin';
const wait = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const versionOf = (app: string): string | null => {
  try {
    return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
};

let gh: FakeGitHub;
const procs: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) p.kill('SIGKILL');
  for (const d of dirs.splice(0)) {
    try { chmodSync(d, 0o755); } catch { /* gone */ }
    rmSync(d, { recursive: true, force: true });
  }
  await gh?.close();
});
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), name));
  dirs.push(d);
  return d;
};

/** An Updater on a fake "installed app" at version `version`. Paths contain spaces on purpose (« Application Support »). */
function setup(version: string, extra: Partial<UpdaterOptions> = {}, o: { file?: boolean; quit?: 'kill' | 'sigkill' | 'none' } = {}) {
  const root = tmp('atlas qa upd-');
  const dataDir = join(root, 'Application Support', 'data');
  const apps = join(root, 'Applications dir');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(apps, { recursive: true });
  const installed = fakeApp(apps, version);
  const db: Db = openDb(o.file === false ? ':memory:' : join(dataDir, 'atlas.db'));
  const bus = new Bus();
  const atlas = spawn('sleep', ['60']); // « Atlas »: what the helper waits for
  procs.push(atlas);
  let quits = 0;
  const opts: UpdaterOptions = {
    version,
    dataDir,
    host: {
      appPath: installed,
      arch: 'arm64',
      quit: () => {
        quits++;
        if (o.quit === 'none') return;
        atlas.kill(o.quit === 'sigkill' ? 'SIGKILL' : 'SIGTERM');
      },
    },
    backup: (file) => db.backup(file),
    api: gh.url,
    intervalMs: false,
    pid: atlas.pid,
    openCommand: 'true',
    ...extra,
  };
  const u = new Updater(db, bus, opts);
  return { u, db, bus, dataDir, installed, opts, atlas, root, quits: () => quits };
}
const start = async () => {
  gh = new FakeGitHub();
  await gh.listen();
};

describe.skipIf(!mac)('update check: the failure modes (#124)', () => {
  it('a failed check keeps the update found before, shows the error, and the next good check clears it', async () => {
    await start();
    gh.publish('0.5.0', { zip: false });
    const { u } = setup('0.4.0');
    expect((await u.check()).releases.map((r) => r.version)).toEqual(['0.5.0']);
    gh.status = 500;
    let s = await u.check();
    expect(s.checkError).toBe('GitHub answered 500 Internal Server Error');
    expect(s.releases.map((r) => r.version)).toEqual(['0.5.0']);
    gh.status = 429;
    s = await u.check();
    expect(s.checkError).toMatch(/^GitHub answered 429/);
    gh.status = 200;
    s = await u.check();
    expect(s.checkError).toBeNull();
    expect(s.releases).toHaveLength(1);
  });

  // KNOWN (low): the check error shows the JSON parser message. `it.fails`: goes red when fixed, then remove it.
  it.fails('GitHub answering something that is not JSON (a captive portal page) gives a readable error, not a parser message', async () => {
    await start();
    gh.rawList = '<html><body>Please log in to the café wifi</body></html>';
    const s = await setup('0.4.0').u.check();
    expect(s.checkError).toBeTruthy();
    expect(s.checkError).not.toMatch(/Unexpected token|JSON/i);
    expect(s.releases).toEqual([]);
  });

  it('GitHub answering JSON that is not a list (an error object with status 200) is an error', async () => {
    await start();
    gh.rawList = JSON.stringify({ message: 'Not Found' });
    const s = await setup('0.4.0').u.check();
    expect(s.checkError).toBe('GitHub answered something that is not a list of releases');
  });

  it('no release yet, odd tags and a release without notes: no update, no crash', async () => {
    await start();
    const { u } = setup('0.4.0');
    expect((await u.check()).releases).toEqual([]);
    gh.releases = [
      { tag_name: 'nightly', draft: false, prerelease: false, assets: [] },
      { tag_name: 'v1.2', draft: false, prerelease: false, assets: [] },
      { tag_name: 'v0.9.0-rc.1', draft: false, prerelease: false, assets: [] },
      { tag_name: 'v0.9.0', draft: false, prerelease: false, body: null, published_at: null },
    ];
    const s = await u.check();
    expect(s.checkError).toBeNull();
    expect(s.releases).toEqual([{ version: '0.9.0', notes: '', publishedAt: '' }]);
  });

  it('two checks at once make one request', async () => {
    await start();
    gh.publish('0.5.0', { zip: false });
    const { u } = setup('0.4.0');
    await Promise.all([u.check(), u.check(), u.check()]);
    expect(gh.log.filter((l) => l.startsWith('GET /repos/')).length).toBe(1);
  });

  it('the check sends no credentials (public repo, no token)', async () => {
    await start();
    gh.publish('0.5.0', { zip: false });
    const seen: Record<string, string>[] = [];
    const { u } = setup('0.4.0', { fetch: async (url, init) => (seen.push(init?.headers as Record<string, string>), fetch(url, init)) });
    await u.check();
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0]!).map((k) => k.toLowerCase())).not.toContain('authorization');
  });
});

describe.skipIf(!mac)('download and verification: the failure modes (#124)', () => {
  /** Whatever fails, the installed app is the old one, nothing is left in update/, Atlas was not asked to quit. */
  const untouched = (t: ReturnType<typeof setup>) => {
    expect(versionOf(t.installed)).toBe('0.4.0');
    expect(t.quits()).toBe(0);
    expect(readdirSync(join(t.dataDir, 'update')).filter((f) => f !== 'install.log')).toEqual([]);
    expect(t.u.status().phase).toBe('failed');
  };

  it('download cut halfway (connection closed after announcing the full length): clear error, partial file removed, retry works', async () => {
    await start();
    gh.publish('0.5.0');
    gh.cutAfter = 100_000;
    const t = setup('0.4.0');
    await t.u.check();
    await expect(t.u.install()).rejects.toThrow(/^The download of 0\.5\.0 failed: .+Nothing was changed: try again\.$/);
    expect(t.u.status().error).toMatch(/^The download of 0\.5\.0 failed/);
    untouched(t);
    gh.cutAfter = null;
    expect((await t.u.install()).phase).toBe('installing');
    await wait(() => versionOf(t.installed) === '0.5.0');
  });

  it('download ending early without a length (clean end of a chunked answer): caught by the checksum', async () => {
    await start();
    gh.publish('0.5.0');
    gh.endEarlyAfter = 100_000;
    const t = setup('0.4.0');
    await t.u.check();
    await expect(t.u.install()).rejects.toThrow(/is broken \(SHA-256/);
    untouched(t);
  });

  it('a checksum file with no line for this zip, or an empty one: not installed, says which', async () => {
    await start();
    gh.publish('0.5.0', { sums: `${'a'.repeat(64)}  Atlas-0.5.0-x64.zip\n` });
    const t = setup('0.4.0');
    await t.u.check();
    await expect(t.u.install()).rejects.toThrow(/SHA256SUMS\.txt of 0\.5\.0 has no line for Atlas-0\.5\.0-arm64\.zip: not installed\./);
    untouched(t);
    gh.files.set('dl/0.5.0/SHA256SUMS.txt', Buffer.from(''));
    await expect(t.u.install()).rejects.toThrow(/has no line for/);
    gh.files.set('dl/0.5.0/SHA256SUMS.txt', Buffer.from('<html>404</html>'));
    await expect(t.u.install()).rejects.toThrow(/has no line for/);
    untouched(t);
  });

  it('checksum written upper-case, with CRLF line ends and a « * » binary marker is accepted', async () => {
    await start();
    const zip = zipOf('0.5.0');
    gh.publish('0.5.0', { zipBytes: zip, sums: `${sha(zip).toUpperCase()} *${zipName('0.5.0', 'arm64')}\r\n` });
    const t = setup('0.4.0');
    await t.u.check();
    expect((await t.u.install()).phase).toBe('installing');
    await wait(() => versionOf(t.installed) === '0.5.0');
  });

  it('a zip that matches its checksum but is not a zip: could not be unpacked, nothing changed', async () => {
    await start();
    gh.publish('0.5.0', { zipBytes: Buffer.from('this is not a zip file at all') });
    const t = setup('0.4.0');
    await t.u.check();
    await expect(t.u.install()).rejects.toThrow(/could not be unpacked/);
    untouched(t);
  });

  it('a zip holding another version than its tag, or no Atlas.app: not installed', async () => {
    await start();
    gh.publish('0.5.0', { appVersion: '0.4.9' });
    const t = setup('0.4.0');
    await t.u.check();
    await expect(t.u.install()).rejects.toThrow('The download of 0.5.0 holds Atlas 0.4.9: not installed.');
    untouched(t);
    // a zip of a folder that is not Atlas.app
    const dir = tmp('atlas-upd-src-');
    mkdirSync(join(dir, 'Other.app', 'Contents'), { recursive: true });
    writeFileSync(join(dir, 'Other.app', 'Contents', 'x'), 'x');
    execFileSync('ditto', ['-c', '-k', '--keepParent', join(dir, 'Other.app'), join(dir, 'o.zip')]);
    gh.releases = [];
    gh.publish('0.6.0', { zipBytes: readFileSync(join(dir, 'o.zip')) });
    await t.u.check();
    await expect(t.u.install()).rejects.toThrow(/holds no readable Atlas\.app/);
    untouched(t);
  });

  it('GitHub redirects the download (release assets are served from another host): followed', async () => {
    await start();
    gh.publish('0.5.0');
    for (const r of gh.releases as { assets: { browser_download_url: string }[] }[])
      for (const a of r.assets) a.browser_download_url = a.browser_download_url.replace(`${gh.url}/`, `${gh.url}/redirect/`);
    const t = setup('0.4.0');
    await t.u.check();
    expect((await t.u.install()).phase).toBe('installing');
    expect(gh.log.some((l) => l.startsWith('GET /redirect/dl/Atlas-0.5.0-arm64.zip'))).toBe(true);
    await wait(() => versionOf(t.installed) === '0.5.0');
  });

  it('the database backup failing stops the update before anything is swapped', async () => {
    await start();
    gh.publish('0.5.0');
    const t = setup('0.4.0', { backup: async () => { throw new Error('disk full'); } });
    await t.u.check();
    await expect(t.u.install()).rejects.toThrow('The database backup before updating failed: disk full. Nothing was changed.');
    untouched(t);
  });

  it('Update clicked twice at once: the second is refused, one download', async () => {
    await start();
    gh.publish('0.5.0');
    gh.slow = 64 * 1024;
    const t = setup('0.4.0');
    await t.u.check();
    const first = t.u.install();
    await wait(() => t.u.status().phase === 'downloading');
    await expect(t.u.install()).rejects.toThrow('an update is already being installed');
    gh.slow = 0;
    expect((await first).phase).toBe('installing');
    expect(gh.log.filter((l) => l.startsWith('GET /dl/Atlas-0.5.0-arm64.zip')).length).toBe(1);
  });

  it('several versions skipped: installs the latest, the dialog lists every note, the backup is named after the target', async () => {
    await start();
    for (const v of ['0.4.1', '0.5.0', '0.5.1', '0.6.0', '0.6.1']) gh.publish(v, { zip: v === '0.6.1' });
    const t = setup('0.4.0');
    const s = await t.u.check();
    expect(s.releases.map((r) => r.version)).toEqual(['0.6.1', '0.6.0', '0.5.1', '0.5.0', '0.4.1']);
    expect(s.releases.map((r) => r.notes)).toEqual(s.releases.map((r) => `## Fixed · notes of ${r.version}`));
    await t.u.install();
    expect(gh.log.filter((l) => l.includes('.zip')).map((l) => l.replace('GET /dl/', ''))).toEqual(['Atlas-0.6.1-arm64.zip']);
    await wait(() => versionOf(t.installed) === '0.6.1');
    expect(existsSync(join(t.dataDir, 'backups', 'atlas-0.4.0-before-0.6.1.db'))).toBe(true);
    t.db.close();
    const after = new Updater(openDb(join(t.dataDir, 'atlas.db')), new Bus(), { ...t.opts, version: '0.6.1' }).status();
    expect(after).toMatchObject({ phase: 'idle', releases: [], lastUpdate: { from: '0.4.0', to: '0.6.1' } });
  });

  it('releases published out of order (0.19.0 built before 0.18.2): the newest version wins, the late older one is never offered', async () => {
    await start();
    gh.publish('0.18.1', { zip: false });
    const t = setup('0.18.1');
    gh.publish('0.19.0', { zip: false }); // listed first, as GitHub orders by creation
    expect((await t.u.check()).releases.map((r) => r.version)).toEqual(['0.19.0']);
    gh.publish('0.18.2', { zip: false }); // the slower build of the earlier push finishes later
    expect((await t.u.check()).releases.map((r) => r.version)).toEqual(['0.19.0', '0.18.2']);
  });
});

describe.skipIf(!mac)('Atlas killed around the swap (#124)', () => {
  it('Atlas killed with SIGKILL (not a clean quit) right after Update: the helper still swaps and reopens, the new version starts', async () => {
    await start();
    gh.publish('0.5.0');
    const t = setup('0.4.0', {}, { quit: 'sigkill' });
    await t.u.check();
    await t.u.install();
    await wait(() => versionOf(t.installed) === '0.5.0');
    expect(versionOf(join(t.dataDir, 'Atlas.previous.app'))).toBe('0.4.0');
    expect(readFileSync(join(t.dataDir, 'update', 'install.log'), 'utf8')).toContain('installed 0.5.0');
  });

  it('Atlas never quits (quit cancelled): after the timeout the update shows failed with a reason and the app is untouched', async () => {
    await start();
    gh.publish('0.5.0');
    const t = setup('0.4.0', { quitTimeoutMs: 300 }, { quit: 'none' });
    await t.u.check();
    await t.u.install();
    await wait(() => t.u.status().phase === 'failed', 5000);
    expect(t.u.status().error).toBe('Atlas did not quit, so the update was not installed: click Update to try again.');
    expect(versionOf(t.installed)).toBe('0.4.0');
  });
});

/** The helper script run on its own, the way install() starts it, with `mv`, `sleep` and `open` replaced by shims when asked. */
describe.skipIf(!mac)('the swap helper on its own (#124)', () => {
  function rig() {
    const root = tmp('atlas qa swap-');
    const apps = join(root, 'Applications dir');
    const data = join(root, 'Application Support', 'data');
    mkdirSync(apps, { recursive: true });
    mkdirSync(join(data, 'update', 'staging'), { recursive: true });
    const app = fakeApp(apps, '0.4.0');
    const fresh = fakeApp(join(data, 'update', 'staging'), '0.5.0');
    const prev = join(data, 'Atlas.previous.app');
    const log = join(data, 'update', 'install.log');
    const shims = join(root, 'shims');
    mkdirSync(shims);
    // outside the spaced folders: the helper runs $ATLAS_UPDATE_OPEN unquoted (production value: « open »)
    const out = tmp('atlas-qa-open-');
    const opened = join(out, 'opened');
    const open = join(out, 'open.sh');
    writeFileSync(open, `#!/bin/sh\necho "$@" >> "${opened}"\n`, { mode: 0o755 });
    const script = join(root, 'install.sh');
    writeFileSync(script, HELPER, { mode: 0o755 });
    const atlas = spawn('sleep', ['120']);
    procs.push(atlas);
    const run = (env: Record<string, string> = {}, pid = atlas.pid!) => {
      const p = spawn('/bin/sh', [script, String(pid), fresh, app, prev, log], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ATLAS_UPDATE_OPEN: open, ...env, PATH: `${shims}:${process.env.PATH}` },
      });
      procs.push(p);
      const exited = new Promise<number | null>((r) => p.once('exit', (c) => r(c)));
      return { p, exited };
    };
    const shim = (name: string, body: string) => writeFileSync(join(shims, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { root, apps, data, app, fresh, prev, log, atlas, run, shim, opened, readLog: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
  }

  it('waits for Atlas to quit before touching anything, then swaps, keeps the previous app and reopens the installed path (paths with spaces)', async () => {
    const r = rig();
    const h = r.run();
    await new Promise((res) => setTimeout(res, 1200));
    expect(versionOf(r.app)).toBe('0.4.0'); // Atlas still running: untouched
    expect(r.readLog()).toContain('waiting for Atlas');
    r.atlas.kill();
    expect(await h.exited).toBe(0);
    expect(versionOf(r.app)).toBe('0.5.0');
    expect(versionOf(r.prev)).toBe('0.4.0');
    expect(readFileSync(r.opened, 'utf8').trim()).toBe(r.app);
  });

  it('helper killed (SIGKILL) while it waits: the installed app is the old one, intact; the next start reports the failed update', async () => {
    const r = rig();
    const h = r.run();
    await wait(() => r.readLog().includes('waiting'));
    process.kill(-h.p.pid!, 'SIGKILL');
    await h.exited;
    r.atlas.kill();
    await new Promise((res) => setTimeout(res, 300));
    expect(versionOf(r.app)).toBe('0.4.0');
    expect(existsSync(r.prev)).toBe(false);
    expect(existsSync(r.fresh)).toBe(true); // a retry cleans it
    // the old Atlas opens again and finds the update unfinished
    const db = openDb(join(r.data, 'atlas.db'));
    db.prepare("UPDATE app_update SET phase = 'installing', target = '0.5.0', from_version = '0.4.0' WHERE id = 1").run();
    const s = new Updater(db, new Bus(), { version: '0.4.0', dataDir: r.data, host: null, backup: async () => undefined, api: 'http://127.0.0.1:1', intervalMs: false }).status();
    expect(s.phase).toBe('failed');
  });

  it('Atlas that never quits: the helper gives up with a log line and does not touch the app', async () => {
    const r = rig();
    r.shim('sleep', 'exec /bin/sleep 0.001'); // 240 polls of 0.5 s → 240 polls of 1 ms
    const h = r.run();
    expect(await h.exited).toBe(1);
    expect(r.readLog()).toContain('did not quit within 2 minutes: update not installed');
    expect(versionOf(r.app)).toBe('0.4.0');
    expect(existsSync(r.prev)).toBe(false);
  }, 30_000);

  it('cannot move the installed app aside (folder not writable): the old app is reopened untouched, the log says why', async () => {
    const r = rig();
    r.atlas.kill();
    await new Promise((res) => setTimeout(res, 100));
    chmodSync(r.apps, 0o555);
    const h = r.run();
    expect(await h.exited).toBe(1);
    chmodSync(r.apps, 0o755);
    expect(r.readLog()).toContain('could not move');
    expect(versionOf(r.app)).toBe('0.4.0');
    expect(readFileSync(r.opened, 'utf8').trim()).toBe(r.app);
  });

  it('the new app has vanished (cleaned by a retry) when the helper wakes: the previous app is put back and reopened', async () => {
    const r = rig();
    r.atlas.kill();
    await new Promise((res) => setTimeout(res, 100));
    rmSync(r.fresh, { recursive: true });
    const h = r.run();
    await h.exited;
    expect(r.readLog()).toContain('putting the previous one back');
    expect(versionOf(r.app)).toBe('0.4.0');
    expect(readFileSync(r.opened, 'utf8').trim()).toBe(r.app);
  });

  it('a stale Atlas.previous.app from an older update is replaced, not merged into', async () => {
    const r = rig();
    mkdirSync(join(r.prev, 'Contents'), { recursive: true });
    writeFileSync(join(r.prev, 'Contents', 'stale-file'), 'x');
    r.atlas.kill();
    const h = r.run();
    await h.exited;
    expect(versionOf(r.prev)).toBe('0.4.0');
    expect(existsSync(join(r.prev, 'Contents', 'stale-file'))).toBe(false);
  });

  // KNOWN BUG, reported on #123 (QA #124): the swap is two renames (old → previous, new → installed). Between them
  // /Applications/Atlas.app does not exist. If the helper dies there (SIGKILL, logout, power loss) Atlas cannot be
  // opened until someone moves Atlas.previous.app back by hand. `it.fails`: goes red when this is fixed, then remove it.
  it.fails('helper killed between the two renames: an Atlas.app must still exist at the installed path (old or new, never none)', async () => {
    const r = rig();
    // the shim lets the first mv through, then freezes the helper in the gap
    r.shim('mv', `/bin/mv "$@"; rc=$?\nif [ ! -e "${r.root}/paused" ]; then touch "${r.root}/paused"; sleep 30; fi\nexit $rc`);
    r.atlas.kill();
    const h = r.run();
    await wait(() => existsSync(join(r.root, 'paused')));
    process.kill(-h.p.pid!, 'SIGKILL');
    await h.exited;
    expect(existsSync(r.app)).toBe(true);
  });
});
