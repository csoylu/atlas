import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Bus } from './events.ts';
import { openDb, type Db } from './store/db.ts';
import { compareSemver, parseSums, QUIT_DONE, Updater, zipName, type UpdaterOptions } from './updater.ts';
import { startEngine } from './index.ts';
import { FakeGitHub, fakeApp, sha } from '../test/updaterKit.ts';
import { pgrepWorks, psBlocked, until } from '../test/kit/index.ts';

const mac = process.platform === 'darwin';
const wait = (ok: () => boolean, ms = 10_000) => until(ok, 'the condition', ms);

let gh: FakeGitHub;
const procs: ChildProcess[] = [];
afterEach(() => {
  for (const p of procs.splice(0)) p.kill('SIGKILL');
  gh?.server.close();
});

function setup(version: string, extra: Partial<UpdaterOptions> = {}, dbFile = ':memory:') {
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-upd-data-'));
  const apps = mkdtempSync(join(tmpdir(), 'atlas-upd-apps-'));
  const installed = fakeApp(apps, version);
  const db: Db = openDb(dbFile === ':memory:' ? ':memory:' : join(dataDir, dbFile));
  const bus = new Bus();
  // Atlas itself: a process the helper waits for; « quit » kills it.
  const atlas = spawn('sleep', ['60']);
  procs.push(atlas);
  let quits = 0;
  const opts: UpdaterOptions = {
    version,
    dataDir,
    host: { appPath: installed, arch: 'arm64', quit: () => (quits++, atlas.kill()) },
    backup: (file) => db.backup(file),
    api: gh.url,
    intervalMs: false,
    pid: atlas.pid,
    openCommand: 'true',
    ...extra,
  };
  const u = new Updater(db, bus, opts);
  return { u, db, bus, dataDir, installed, opts, quits: () => quits };
}
/** The app's version, or null while the helper has moved it aside and not yet put the new one in place. */
const installedVersion = (app: string): string | null => {
  try {
    return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
};

describe('versions', () => {
  it('compares x.y.z and reads shasum output', () => {
    expect(compareSemver('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('0.3.1', '0.3.2')).toBeLessThan(0);
    expect(() => compareSemver('dev', '0.3.0')).toThrow();
    expect(parseSums(`${'a'.repeat(64)}  Atlas-1.0.0-arm64.zip\n${'B'.repeat(64)} *x.dmg\n`)).toEqual(
      new Map([['Atlas-1.0.0-arm64.zip', 'a'.repeat(64)], ['x.dmg', 'b'.repeat(64)]]),
    );
  });
});

describe.skipIf(!mac)('updater (fake release server)', () => {
  const start = async () => {
    gh = new FakeGitHub();
    await gh.listen();
  };

  it('newer version: lists every published release since the running one, newest first (no drafts, no pre-releases)', async () => {
    await start();
    for (const v of ['0.3.9', '0.4.0', '0.4.1']) gh.publish(v, { zip: false });
    gh.publish('0.5.0', { zip: false });
    gh.publish('0.6.0-test.3', { prerelease: true, zip: false });
    gh.publish('0.7.0', { draft: true, zip: false });
    const { u } = setup('0.4.0');
    const s = await u.check();
    expect(s.checkError).toBeNull();
    expect(s.checkedAt).not.toBeNull();
    expect(s.releases.map((r) => r.version)).toEqual(['0.5.0', '0.4.1']);
    expect(s.releases[0]!.notes).toBe('## Fixed · notes of 0.5.0');
    expect(s.cannotInstall).toBeNull();
  });

  it('same or older version: up to date', async () => {
    await start();
    gh.publish('0.4.0', { zip: false });
    expect((await setup('0.4.0').u.check()).releases).toEqual([]);
    expect((await setup('0.5.2').u.check()).releases).toEqual([]);
    // a development build never shows an update
    expect((await setup('dev').u.check()).releases).toEqual([]);
  });

  it('no network, or GitHub refusing: a clear check error, nothing else changes', async () => {
    await start();
    gh.publish('0.5.0', { zip: false });
    const { u } = setup('0.4.0');
    await u.check();
    gh.server.close();
    const dead = setup('0.4.0', { api: 'http://127.0.0.1:1' });
    const s = await dead.u.check();
    expect(s.checkError).toMatch(/^Could not reach GitHub: /);
    expect(s.releases).toEqual([]);
    gh = new FakeGitHub();
    await gh.listen();
    gh.status = 403;
    const limited = setup('0.4.0', { api: gh.url });
    expect((await limited.u.check()).checkError).toBe('GitHub answered 403 Forbidden (rate limit: try again later)');
  });

  it('Update: downloads, verifies, backs up the database, the helper swaps the app after Atlas quits; the next start says updated', async () => {
    await start();
    gh.publish('0.5.0');
    const t = setup('0.4.0', {}, 'atlas.db');
    t.db.prepare("INSERT INTO settings (key, value) VALUES ('user_name', 'Master')").run();
    const events: string[] = [];
    t.bus.on((e) => e.type === 'update.updated' && events.push(e.status.phase));
    await t.u.check();
    const s = await t.u.install();
    expect(s.phase).toBe('installing');
    expect(t.quits()).toBe(1);
    expect(events).toEqual(expect.arrayContaining(['downloading', 'verifying', 'installing']));
    // the database backup holds the data
    const backup = join(t.dataDir, 'backups', 'atlas-0.4.0-before-0.5.0.db');
    const b = openDb(backup);
    expect(b.prepare("SELECT value FROM settings WHERE key = 'user_name'").get()).toEqual({ value: 'Master' });
    b.close();
    // the helper waits for the quit, then swaps
    const log = join(t.dataDir, 'update', 'install.log');
    await wait(() => existsSync(log) && readFileSync(log, 'utf8').includes('installed 0.5.0'));
    expect(installedVersion(t.installed)).toBe('0.5.0');
    expect(installedVersion(join(t.dataDir, 'Atlas.previous.app'))).toBe('0.4.0');
    t.db.close();
    // the new version starts on the same database
    const db = openDb(join(t.dataDir, 'atlas.db'));
    const after = new Updater(db, new Bus(), { ...t.opts, version: '0.5.0' }).status();
    expect(after).toMatchObject({ phase: 'idle', error: null, releases: [], lastUpdate: { from: '0.4.0', to: '0.5.0' } });
    expect(readdirSync(join(t.dataDir, 'update'))).toEqual(['install.log']);
  });

  it('a second update keeps only the latest previous app', async () => {
    await start();
    gh.publish('0.5.0');
    const t = setup('0.4.0');
    mkdirSync(join(t.dataDir, 'Atlas.previous.app', 'old'), { recursive: true });
    await t.u.check();
    await t.u.install();
    await wait(() => installedVersion(t.installed) === '0.5.0');
    expect(installedVersion(join(t.dataDir, 'Atlas.previous.app'))).toBe('0.4.0');
    expect(existsSync(join(t.dataDir, 'Atlas.previous.app', 'old'))).toBe(false);
  });

  it('bad checksum: a clear error, the installed app untouched, no download left, Atlas keeps running', async () => {
    await start();
    gh.publish('0.5.0', { sum: 'f'.repeat(64) });
    const t = setup('0.4.0');
    await t.u.check();
    await expect(t.u.install()).rejects.toThrow(/The download of 0.5.0 is broken \(SHA-256 .+, expected ffffffffffff…\)\. Nothing was changed: try again\./);
    const s = t.u.status();
    expect(s.phase).toBe('failed');
    expect(s.error).toMatch(/is broken/);
    expect(t.quits()).toBe(0);
    expect(installedVersion(t.installed)).toBe('0.4.0');
    expect(readdirSync(join(t.dataDir, 'update'))).toEqual([]);
    // fixed release: Update works again
    gh.files.set('dl/0.5.0/SHA256SUMS.txt', Buffer.from(`${sha(gh.files.get(`dl/${zipName('0.5.0', 'arm64')}`)!)}  ${zipName('0.5.0', 'arm64')}\n`));
    expect((await t.u.install()).phase).toBe('installing');
  });

  it('missing zip or no network during the download: failed with the reason, nothing changed', async () => {
    await start();
    gh.publish('0.5.0', { zip: false });
    const t = setup('0.4.0');
    await t.u.check();
    await expect(t.u.install()).rejects.toThrow(/Release 0.5.0 has no Atlas-0.5.0-arm64.zip/);
    gh.releases = [];
    gh.publish('0.6.0');
    await t.u.check();
    gh.server.close();
    gh.server.closeAllConnections();
    await expect(t.u.install()).rejects.toThrow(/Could not download the checksum file of 0.6.0: .+Nothing was changed/);
    expect(t.u.status().phase).toBe('failed');
    expect(installedVersion(t.installed)).toBe('0.4.0');
  });

  it('refused without a host (dev, server), when up to date, and while an install runs', async () => {
    await start();
    const t = setup('0.4.0', { host: null, cannotInstall: 'not here' });
    expect(t.u.status().cannotInstall).toBe('not here');
    await expect(t.u.install()).rejects.toThrow('not here');
    const up = setup('0.4.0');
    await up.u.check();
    await expect(up.u.install()).rejects.toThrow('Atlas 0.4.0 is the latest version: nothing to install');
  });

  it('killed during the download (SIGKILL): the next start drops the partial file, the app is untouched, Update works', async () => {
    await start();
    gh.publish('0.5.0');
    gh.slow = 16 * 1024;
    const t = setup('0.4.0', {}, 'atlas.db');
    await t.u.check();
    t.db.close();
    // A separate engine process downloads; it is killed mid-way.
    const script = join(t.dataDir, 'run.mts');
    writeFileSync(
      script,
      `import { openDb } from ${JSON.stringify(join(import.meta.dirname, 'store/db.ts'))};
       import { Bus } from ${JSON.stringify(join(import.meta.dirname, 'events.ts'))};
       import { Updater } from ${JSON.stringify(join(import.meta.dirname, 'updater.ts'))};
       const db = openDb(${JSON.stringify(join(t.dataDir, 'atlas.db'))});
       const u = new Updater(db, new Bus(), { version: '0.4.0', dataDir: ${JSON.stringify(t.dataDir)}, api: ${JSON.stringify(gh.url)}, intervalMs: false,
         host: { appPath: ${JSON.stringify(t.installed)}, arch: 'arm64', quit() {} }, backup: (f) => db.backup(f), openCommand: 'true' });
       await u.install();`,
    );
    const child = spawn(process.execPath, ['--import', 'tsx', script], { stdio: ['ignore', 'ignore', 'pipe'], cwd: import.meta.dirname });
    procs.push(child);
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
    const peek = () => {
      const db = openDb(join(t.dataDir, 'atlas.db'));
      const r = db.prepare('SELECT phase, received FROM app_update').get() as { phase: string; received: number };
      db.close();
      return r;
    };
    await wait(() => peek().phase === 'downloading' && peek().received > 0, 20_000).catch((e: Error) => {
      throw new Error(`${e.message}: ${JSON.stringify(peek())} ${stderr}`);
    });
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(readdirSync(join(t.dataDir, 'update')).some((f) => f.endsWith('.part'))).toBe(true);
    // restart
    gh.slow = 0;
    const db = openDb(join(t.dataDir, 'atlas.db'));
    const u = new Updater(db, new Bus(), { ...t.opts, backup: (f) => db.backup(f) });
    const s = u.status();
    expect(s.phase).toBe('failed');
    expect(s.error).toBe('The download of 0.5.0 was interrupted (Atlas stopped). Nothing was changed: click Update to try again.');
    expect(readdirSync(join(t.dataDir, 'update'))).toEqual([]);
    expect(installedVersion(t.installed)).toBe('0.4.0');
    expect((await u.install()).phase).toBe('installing');
    await wait(() => installedVersion(t.installed) === '0.5.0');
  }, 40_000);

  it('handed to the helper but the old version started again: failed, with the log', async () => {
    await start();
    const t = setup('0.4.0', {}, 'atlas.db');
    t.db.prepare("UPDATE app_update SET phase = 'installing', target = '0.5.0', from_version = '0.4.0'").run();
    t.db.close();
    const db = openDb(join(t.dataDir, 'atlas.db'));
    const s = new Updater(db, new Bus(), t.opts).status();
    expect(s.phase).toBe('failed');
    expect(s.error).toMatch(/^The update to 0.5.0 did not install: Atlas 0.4.0 is still the one running\. Details in .+install\.log\.$/);
  });

  // #324: on 20 Nov 2026 0.78.0 stopped its engine and closed the database after Update, then hung in its process exit
  // for 6 minutes; the helper gave up after 2 minutes with only « did not quit ».
  it('Atlas stuck in its exit after the engine stopped: the helper samples it, ends it with SIGKILL and installs', async () => {
    await start();
    gh.publish('0.5.0');
    const apps = mkdtempSync(join(tmpdir(), 'atlas-upd-apps-'));
    const installed = fakeApp(apps, '0.4.0');
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-upd-e-'));
    // the Atlas process: it ignores everything but SIGKILL, like a process stuck in exit()
    const atlas = spawn('/bin/sh', ['-c', 'trap "" TERM INT HUP; while :; do sleep 0.2; done']);
    procs.push(atlas);
    const sampler = join(dataDir, 'fake-sample.sh');
    writeFileSync(sampler, '#!/bin/sh\necho "stacks of $1" > "$4"\n', { mode: 0o755 });
    let stopped: Promise<void> | undefined;
    const e = await startEngine({
      dbFile: ':memory:', dataDir, port: 0, dispatch: false, version: '0.4.0', memoryReview: false,
      updates: { host: { appPath: installed, arch: 'arm64', quit: () => void (stopped = e.stop()) }, api: gh.url, intervalMs: false, pid: atlas.pid, openCommand: 'true', sampleCommand: sampler, helperTicks: { quit: 240, exit: 2 } },
    });
    await e.updater.check();
    await e.updater.install();
    await stopped;
    // the engine wrote each step of its stop, the last one once the database was closed
    const steps = readFileSync(join(dataDir, 'update', 'quit.log'), 'utf8').trim().split('\n').map((l) => l.replace(/^\S+ /, ''));
    expect(steps[0]).toBe('asked the app to quit (the window closes, then the engine stops)');
    expect(steps).toContain('stopping agent runs and their commands');
    expect(steps.at(-1)).toBe(QUIT_DONE);
    const log = join(dataDir, 'update', 'install.log');
    await wait(() => existsSync(log) && readFileSync(log, 'utf8').includes('installed 0.5.0'), 20_000);
    expect(readFileSync(log, 'utf8')).toMatch(/Atlas stopped its engine and closed the database \(\S+\), but its process \(pid \d+\) was still alive 10 s later, stuck in its exit: ended it with SIGKILL \(stacks in \S+quit-sample\.txt\)\n/);
    expect(readFileSync(join(dataDir, 'update', 'quit-sample.txt'), 'utf8')).toBe(`stacks of ${atlas.pid}\n`);
    await wait(() => atlas.signalCode === 'SIGKILL');
    expect(installedVersion(installed)).toBe('0.5.0');
  }, 30_000);

  // the helper lists the child processes with pgrep and ps, which the agent sandbox refuses (#314, #322)
  it.skipIf(psBlocked || !pgrepWorks())('the engine never finishes stopping: nothing is killed, the helper names the step and the child processes, the next start shows it', async () => {
    await start();
    gh.publish('0.5.0');
    // Atlas with a child process that keeps running (an agent's command, a test engine…)
    const atlas = spawn('/bin/sh', ['-c', 'sleep 61 & wait']);
    procs.push(atlas);
    const t = setup('0.4.0', { pid: atlas.pid, helperTicks: { quit: 4, exit: 2 } }, 'atlas.db');
    t.opts.host!.quit = () => t.u.quitStep('stopping agent runs and their commands');
    await t.u.check();
    await t.u.install();
    const log = join(t.dataDir, 'update', 'install.log');
    await wait(() => existsSync(log) && readFileSync(log, 'utf8').includes('update not installed'));
    const last = readFileSync(log, 'utf8').trim().split('\n').at(-1)!;
    expect(last).toMatch(/^Atlas did not quit within 2 minutes, its engine was still at: stopping agent runs and their commands; child processes: \d+ +[\d:]+ sleep 61; update not installed$/);
    expect(atlas.exitCode).toBeNull();
    expect(atlas.signalCode).toBeNull();
    expect(installedVersion(t.installed)).toBe('0.4.0');
    // the old version starts again: the reason is on the card, not only « did not quit »
    t.db.close();
    const db = openDb(join(t.dataDir, 'atlas.db'));
    const s = new Updater(db, new Bus(), t.opts).status();
    expect(s.phase).toBe('failed');
    expect(s.error).toContain('The update to 0.5.0 did not install: Atlas did not quit within 2 minutes, its engine was still at: stopping agent runs and their commands; child processes: ');
    execFileSync('pkill', ['-P', String(atlas.pid)]);
  }, 30_000);

  it('API: GET /api/update, « Check now », Update refused in dev; the agents working now are listed', async () => {
    await start();
    gh.publish('9.0.0', { zip: false });
    const e = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-upd-e-')), port: 0, dispatch: false, version: '0.4.0', updates: { host: null, api: gh.url, intervalMs: false } });
    try {
      const card = e.kanban.create({ title: 'Build the thing', assignee: null }, 'user');
      e.agents.create({ id: 'munih', modelId: 'sonnet' });
      e.db.prepare("INSERT INTO runs (id, card_id, agent_id, status, started_at) VALUES ('r1', ?, 'munih', 'running', ?)").run(card.id, new Date().toISOString());
      const get = async (path: string, method = 'GET') => {
        const r = await fetch(e.url + path, { method, headers: { 'content-type': 'application/json' } });
        return { status: r.status, body: (await r.json()) as Record<string, unknown> };
      };
      expect((await get('/api/update')).body).toMatchObject({ current: '0.4.0', releases: [], checkedAt: null });
      const c = await get('/api/update/check', 'POST');
      expect(c.body).toMatchObject({ releases: [{ version: '9.0.0' }] });
      const i = await get('/api/update/install', 'POST');
      expect(i.status).toBe(409);
      expect(i.body.error).toMatch(/Mac app only/);
      const working = c.body.working as unknown[];
      expect(working).toEqual([{ agent: 'munih', card: card.number, title: 'Build the thing' }]);
    } finally {
      await e.stop();
    }
  });
});
