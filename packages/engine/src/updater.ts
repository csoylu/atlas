import { spawn, execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { AppRelease, UpdatePhase, UpdateStatus } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { ConflictError } from './kanban.ts';

const execFile = promisify(execFileCb);

/**
 * App updates from GitHub releases (card #123, docs/updater.md). Every push to main is a release built by CI (zip of the
 * unsigned .app per chip + SHA256SUMS.txt). The app checks at start, every hour and on « Check now »; it installs only
 * when Master clicks Update: download the zip for this chip, verify its SHA-256, unpack it, back up the database, then
 * hand over to a detached helper (HELPER below) that waits for Atlas to quit, swaps /Applications/Atlas.app (keeping
 * the previous one once) and reopens it.
 *
 * State lives in SQLite (app_update, migration 0042; CLAUDE.md rule 2). Until the helper swaps the bundle, nothing
 * touches the installed app, so a kill at any moment leaves it intact: at the next start recover() drops an
 * interrupted download, and checks an install handed to the helper against the version that actually started.
 */

/** What the desktop app provides so an update can be installed (the packaged Mac app only). */
export interface UpdateHost {
  /** The running bundle, e.g. /Applications/Atlas.app. */
  appPath: string;
  arch: 'arm64' | 'x64';
  /** Quit the app (its engine stops cleanly; runs end 'interrupted' and resume at the next start). */
  quit(): void;
}

export interface UpdaterOptions {
  /** The running version (x.y.z; anything else, e.g. 'dev', never shows an update). */
  version: string;
  dataDir: string;
  /** Null: the reason this build cannot install (dev, server, Windows); checks still run. */
  host: UpdateHost | null;
  cannotInstall?: string;
  /** Back up the database to this file before installing (better-sqlite3 db.backup). */
  backup(file: string): Promise<unknown>;
  repo?: string;
  /** GitHub's API (tests: a fake release server). */
  api?: string;
  fetch?: typeof fetch;
  /** Check at start and every intervalMs (default 1 h); false = only on « Check now » (tests, dev). */
  intervalMs?: number | false;
  /** Tests: the pid the helper waits for (default this process). */
  pid?: number;
  /** Tests: what the helper runs to reopen the app (default `open`). */
  openCommand?: string;
  /** How long Atlas may take to quit after Update before the install counts as failed (default 150 s). */
  quitTimeoutMs?: number;
  now?: () => number;
}

interface Row {
  checked_at: string | null;
  check_error: string | null;
  releases: string;
  phase: UpdatePhase;
  target: string | null;
  from_version: string | null;
  received: number;
  total: number | null;
  error: string | null;
  phase_at: string | null;
  last_update: string | null;
}

/** A release as stored: AppRelease plus where its files are. */
interface StoredRelease extends AppRelease {
  zip: string | null;
  sums: string | null;
}

export const REPO = 'csoylu/atlas';
const HOUR = 3_600_000;
const SUMS = 'SHA256SUMS.txt';

/** x.y.z → [x, y, z]; null for anything else (pre-releases and 'dev' are not compared). */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a), y = parseSemver(b);
  if (!x || !y) throw new Error(`cannot compare versions ${a} and ${b}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/** The zip CI publishes for a chip (apps/desktop/package.json → build.mac.artifactName). */
export const zipName = (version: string, arch: string) => `Atlas-${version}-${arch}.zip`;

export class Updater {
  private checking = false;
  private timer: NodeJS.Timeout | undefined;
  private installing = false;
  private readonly dir: string;
  private readonly api: string;
  private readonly repo: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private db: Db, private bus: Bus, private opts: UpdaterOptions) {
    this.dir = join(opts.dataDir, 'update');
    this.api = opts.api ?? 'https://api.github.com';
    this.repo = opts.repo ?? REPO;
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.recover();
  }

  /** Checks at start and every hour (desktop). */
  start(): void {
    const every = this.opts.intervalMs ?? HOUR;
    if (every === false) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), every);
    this.timer.unref();
  }
  stop(): void {
    clearInterval(this.timer);
  }

  private row(): Row {
    return this.db.prepare('SELECT * FROM app_update WHERE id = 1').get() as Row;
  }
  private set(patch: Partial<Row>): void {
    const keys = Object.keys(patch);
    this.db.prepare(`UPDATE app_update SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = 1`).run(patch);
    this.emit();
  }
  private emit(): void {
    this.bus.emit({ type: 'update.updated', status: this.status() });
  }
  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  status(): UpdateStatus {
    const r = this.row();
    const releases = (JSON.parse(r.releases) as StoredRelease[]).map(({ version, notes, publishedAt }) => ({ version, notes, publishedAt }));
    const working = this.db
      .prepare(
        `SELECT r.agent_id AS agent, c.number AS card, c.title AS title FROM runs r JOIN cards c ON c.id = r.card_id
         WHERE r.status = 'running' ORDER BY r.started_at`,
      )
      .all() as UpdateStatus['working'];
    return {
      current: this.opts.version,
      cannotInstall: this.opts.host ? null : (this.opts.cannotInstall ?? 'This build cannot install updates by itself.'),
      checking: this.checking,
      checkedAt: r.checked_at,
      checkError: r.check_error,
      releases,
      phase: r.phase,
      target: r.target,
      received: r.received,
      total: r.total,
      error: r.error,
      lastUpdate: r.last_update ? (JSON.parse(r.last_update) as UpdateStatus['lastUpdate']) : null,
      working,
    };
  }

  /**
   * After a start: whatever a previous process left half done. Downloading or verifying: the installed app was never
   * touched, drop the partial files. Installing (handed to the helper): the update worked iff this is the target version.
   */
  private recover(): void {
    const r = this.row();
    if (r.phase === 'downloading' || r.phase === 'verifying') {
      this.cleanFiles();
      this.set({ phase: 'failed', error: `The download of ${r.target} was interrupted (Atlas stopped). Nothing was changed: click Update to try again.`, received: 0, phase_at: this.iso() });
    } else if (r.phase === 'installing') {
      if (r.target && this.opts.version === r.target) {
        this.cleanFiles();
        const releases = (JSON.parse(r.releases) as StoredRelease[]).filter((x) => parseSemver(x.version) && compareSemver(x.version, this.opts.version) > 0);
        this.set({
          phase: 'idle',
          error: null,
          received: 0,
          total: null,
          releases: JSON.stringify(releases),
          last_update: JSON.stringify({ from: r.from_version ?? '?', to: r.target, at: this.iso() }),
          phase_at: this.iso(),
        });
      } else {
        this.set({
          phase: 'failed',
          error: `The update to ${r.target} did not install: Atlas ${this.opts.version} is still the one running. Details in ${join(this.dir, 'install.log')}.`,
          phase_at: this.iso(),
        });
      }
    }
  }

  private cleanFiles(): void {
    if (!existsSync(this.dir)) return;
    for (const f of readdirSync(this.dir)) if (f !== 'install.log') rmSync(join(this.dir, f), { recursive: true, force: true });
  }

  /** Ask GitHub for the published releases (not drafts, not pre-releases) and keep those newer than this version. */
  async check(): Promise<UpdateStatus> {
    if (this.checking) return this.status();
    this.checking = true;
    this.emit();
    try {
      const res = await this.fetch(`${this.api}/repos/${this.repo}/releases?per_page=50`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Atlas-updater' },
        signal: AbortSignal.timeout(30_000),
      }).catch((e: unknown) => {
        throw new Error(`Could not reach GitHub: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}`);
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} ${res.statusText}${res.status === 403 ? ' (rate limit: try again later)' : ''}`);
      const body = await res.text();
      let list: GitHubRelease[];
      try {
        list = JSON.parse(body) as GitHubRelease[];
      } catch (e) {
        // A captive portal or a proxy answers 200 with a web page: Master gets a sentence, the engine log the cause.
        console.error(`update check: GitHub's answer is not JSON (${res.headers.get('content-type') ?? 'no content-type'}): ${body.slice(0, 200)}`, e);
        throw new Error('GitHub did not answer with a release list (a wifi login page or a proxy may be in the way)');
      }
      if (!Array.isArray(list)) throw new Error('GitHub answered something that is not a list of releases');
      const current = parseSemver(this.opts.version) ? this.opts.version : null;
      const arch = this.opts.host?.arch ?? (process.arch === 'arm64' ? 'arm64' : 'x64');
      const newer: StoredRelease[] = list
        .filter((x) => !x.draft && !x.prerelease && parseSemver(x.tag_name))
        .map((x) => {
          const version = x.tag_name.replace(/^v/, '');
          const asset = (name: string) => x.assets?.find((a) => a.name === name)?.browser_download_url ?? null;
          return { version, notes: x.body ?? '', publishedAt: x.published_at ?? '', zip: asset(zipName(version, arch)), sums: asset(SUMS) };
        })
        .filter((x) => current && compareSemver(x.version, current) > 0)
        .sort((a, b) => compareSemver(b.version, a.version));
      this.checking = false;
      this.set({ checked_at: this.iso(), check_error: null, releases: JSON.stringify(newer) });
    } catch (e) {
      this.checking = false;
      this.set({ checked_at: this.iso(), check_error: e instanceof Error ? e.message : String(e) });
    }
    return this.status();
  }

  /**
   * Master clicked Update: install the latest release. Resolves once the helper has been started and the app asked to
   * quit; a failure (download, checksum, unpack) is stored in phase 'failed' with a clear error and thrown.
   */
  async install(): Promise<UpdateStatus> {
    const host = this.opts.host;
    if (!host) throw new ConflictError(this.status().cannotInstall!);
    const r = this.row();
    if (this.installing || r.phase === 'downloading' || r.phase === 'verifying' || r.phase === 'installing') throw new ConflictError('an update is already being installed');
    const [latest] = JSON.parse(r.releases) as StoredRelease[];
    if (!latest) throw new ConflictError(`Atlas ${this.opts.version} is the latest version: nothing to install`);
    this.installing = true;
    const fail = (message: string) => {
      this.cleanFiles();
      this.set({ phase: 'failed', error: message, phase_at: this.iso() });
      return new Error(message);
    };
    try {
      if (!latest.zip) throw fail(`Release ${latest.version} has no ${zipName(latest.version, host.arch)} (its build may still be uploading): try again in a few minutes.`);
      if (!latest.sums) throw fail(`Release ${latest.version} has no ${SUMS}: it can't be checked, so it is not installed.`);
      this.cleanFiles();
      mkdirSync(this.dir, { recursive: true });
      this.set({ phase: 'downloading', target: latest.version, from_version: this.opts.version, received: 0, total: null, error: null, phase_at: this.iso() });

      const sums = await this.get(latest.sums, `the checksum file of ${latest.version}`);
      const expected = parseSums(await sums.text()).get(zipName(latest.version, host.arch));
      if (!expected) throw fail(`${SUMS} of ${latest.version} has no line for ${zipName(latest.version, host.arch)}: not installed.`);

      // Download, hashing as it goes; progress in SQLite at most twice a second.
      const zip = join(this.dir, zipName(latest.version, host.arch));
      const res = await this.get(latest.zip, zipName(latest.version, host.arch));
      const total = Number(res.headers.get('content-length')) || null;
      const hash = createHash('sha256');
      let received = 0;
      let last = 0;
      this.set({ total });
      const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
      body.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        received += chunk.length;
        if (this.now() - last > 500) {
          last = this.now();
          this.set({ received });
        }
      });
      try {
        await pipeline(body, createWriteStream(zip + '.part'));
      } catch (e) {
        throw fail(`The download of ${latest.version} failed: ${e instanceof Error ? e.message : String(e)}. Nothing was changed: try again.`);
      }
      this.set({ phase: 'verifying', received, phase_at: this.iso() });
      const got = hash.digest('hex');
      if (got !== expected) throw fail(`The download of ${latest.version} is broken (SHA-256 ${got.slice(0, 12)}…, expected ${expected.slice(0, 12)}…). Nothing was changed: try again.`);
      renameSync(zip + '.part', zip);

      // Unpack next to the data, check it is the version we expect.
      const staging = join(this.dir, 'staging');
      try {
        await execFile('ditto', ['-x', '-k', zip, staging]);
      } catch (e) {
        throw fail(`The download of ${latest.version} could not be unpacked: ${errText(e)}`);
      }
      const app = join(staging, 'Atlas.app');
      const version = await bundleVersion(app).catch((e: unknown) => {
        throw fail(`The download of ${latest.version} holds no readable Atlas.app: ${errText(e)}`);
      });
      if (version !== latest.version) throw fail(`The download of ${latest.version} holds Atlas ${version}: not installed.`);
      // A file downloaded by this process carries no quarantine flag; clear it anyway so Gatekeeper never blocks the swap.
      await execFile('xattr', ['-dr', 'com.apple.quarantine', app]).catch(() => undefined);

      // Back up the database: migrations go forward only, so this file is the way back.
      const backups = join(this.opts.dataDir, 'backups');
      mkdirSync(backups, { recursive: true });
      try {
        await this.opts.backup(join(backups, `atlas-${this.opts.version}-before-${latest.version}.db`));
      } catch (e) {
        throw fail(`The database backup before updating failed: ${errText(e)}. Nothing was changed.`);
      }
      pruneBackups(backups, 3);

      // Hand over to the helper, then quit. It swaps the app after this process has exited.
      this.set({ phase: 'installing', phase_at: this.iso() });
      const helper = join(this.dir, 'install.sh');
      writeFileSync(helper, HELPER, { mode: 0o755 });
      const previous = join(this.opts.dataDir, 'Atlas.previous.app');
      const child = spawn('/bin/sh', [helper, String(this.opts.pid ?? process.pid), app, host.appPath, previous, join(this.dir, 'install.log')], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ATLAS_UPDATE_OPEN: this.opts.openCommand ?? 'open' },
      });
      child.unref();
      // If Atlas is still running long after (the quit was cancelled), the helper has given up: say so.
      setTimeout(() => {
        if (this.db.open && this.row().phase === 'installing')
          this.set({ phase: 'failed', error: 'Atlas did not quit, so the update was not installed: click Update to try again.', phase_at: this.iso() });
      }, this.opts.quitTimeoutMs ?? 150_000).unref();
      host.quit();
      return this.status();
    } catch (e) {
      if (this.row().phase !== 'failed') throw fail(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      this.installing = false;
    }
  }

  private async get(url: string, what: string): Promise<Response> {
    const res = await this.fetch(url, { headers: { 'user-agent': 'Atlas-updater' }, redirect: 'follow' }).catch((e: unknown) => {
      throw new Error(`Could not download ${what}: ${e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e)}. Nothing was changed: try again.`);
    });
    if (!res.ok || !res.body) throw new Error(`Could not download ${what}: GitHub answered ${res.status}. Nothing was changed: try again.`);
    return res;
  }
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  body?: string | null;
  published_at?: string | null;
  assets?: { name: string; browser_download_url: string }[];
}

/** `shasum -a 256` output → file name → hex digest. */
export function parseSums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) map.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return map;
}

async function bundleVersion(app: string): Promise<string> {
  const { stdout } = await execFile('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')]);
  return stdout.trim();
}

function pruneBackups(dir: string, keep: number): void {
  const files = readdirSync(dir)
    .filter((f) => /^atlas-.+-before-.+\.db$/.test(f))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(keep)) rmSync(join(dir, f), { force: true });
}

const errText = (e: unknown) => (e instanceof Error ? (('stderr' in e && String(e.stderr).trim()) || e.message) : String(e));

/**
 * The detached helper: $1 pid to wait for, $2 the new Atlas.app, $3 the installed one, $4 where the previous one is
 * kept (once), $5 its log. It reopens Atlas in every case, so a failed swap still leaves Master with a running app.
 */
export const HELPER = `#!/bin/sh
pid="$1"; new="$2"; app="$3"; prev="$4"; log="$5"
exec >>"$log" 2>&1
echo "$(date '+%Y-%m-%d %H:%M:%S') update: waiting for Atlas (pid $pid) to quit"
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 240 ]; then echo "Atlas did not quit within 2 minutes: update not installed"; exit 1; fi
  sleep 0.5
done
rm -rf "$prev"
if [ -e "$app" ] && ! mv "$app" "$prev"; then echo "could not move $app aside: update not installed"; \${ATLAS_UPDATE_OPEN:-open} "$app"; exit 1; fi
if mv "$new" "$app"; then
  echo "installed $(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist" 2>/dev/null) at $app (previous app kept at $prev)"
else
  echo "could not move the new app into place: putting the previous one back"
  rm -rf "$app"; mv "$prev" "$app"
fi
\${ATLAS_UPDATE_OPEN:-open} "$app"
`;
