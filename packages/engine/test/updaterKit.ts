import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipName } from '../src/updater.ts';

/**
 * Test kit for the app updater (#123, QA #124): a fake GitHub (release list + release files) that can misbehave
 * (rate limit, HTML instead of JSON, connection cut halfway, stalled, redirect), and fake Atlas.app bundles.
 * Used by src/updater.test.ts, test/updater.qa.test.ts and e2e/tests/updater.spec.ts.
 */

export const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A fake Atlas.app (just an Info.plist with its version). */
export function fakeApp(dir: string, version: string): string {
  const app = join(dir, 'Atlas.app');
  mkdirSync(join(app, 'Contents'), { recursive: true });
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`,
  );
  return app;
}

/** A zip of a fake Atlas.app, made the way CI's electron-builder zip is (ditto, parent kept). `bytes`: incompressible payload. */
export function zipOf(version: string, bytes = 512 * 1024): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-upd-src-'));
  const app = fakeApp(dir, version);
  writeFileSync(join(app, 'Contents', 'payload'), randomBytes(bytes));
  const zip = join(dir, 'a.zip');
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, zip]);
  return readFileSync(zip);
}

export interface PublishOptions {
  prerelease?: boolean;
  draft?: boolean;
  /** Overrides the checksum written in SHA256SUMS.txt. */
  sum?: string;
  /** false: a release without the zip and the checksum file (its build may still be uploading). */
  zip?: boolean;
  /** The bytes of the zip (default: a fake app of this version). The checksum is computed from them unless `sum`. */
  zipBytes?: Buffer;
  /** The version written in the app inside the zip (default: the release's). */
  appVersion?: string;
  /** Replaces the whole text of SHA256SUMS.txt. */
  sums?: string;
  body?: string;
}

export class FakeGitHub {
  server: Server;
  releases: unknown[] = [];
  files = new Map<string, Buffer>();
  /** Status of the release list; anything but 200 answers a JSON error body. */
  status = 200;
  /** When set, the release list answers 200 with this raw text (e.g. an HTML captive portal). */
  rawList: string | null = null;
  /** Bytes per 50 ms for the zip (0 = all at once); lets a test kill the process mid-download. */
  slow = 0;
  /** The zip's headers announce the full length but the connection is cut after this many bytes. */
  cutAfter: number | null = null;
  /** The zip is sent chunked (no content-length) and the stream ends cleanly after this many bytes. */
  endEarlyAfter: number | null = null;
  /** The zip stops after this many bytes and the connection stays open (a stalled download). */
  stallAfter: number | null = null;
  /** Requests received: `GET /path`. */
  log: string[] = [];
  url = '';
  constructor() {
    this.server = createServer((req, res) => {
      this.log.push(`${req.method} ${req.url}`);
      if (req.url?.startsWith('/repos/csoylu/atlas/releases')) {
        if (this.rawList !== null) return void res.writeHead(200, { 'content-type': 'text/html' }).end(this.rawList);
        res.writeHead(this.status, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify(this.status === 200 ? this.releases : { message: 'API rate limit exceeded' }));
      }
      const path = req.url!.slice(1);
      if (path.startsWith('redirect/')) return void res.writeHead(302, { location: `${this.url}/${path.slice('redirect/'.length)}` }).end();
      const f = this.files.get(path);
      if (!f) return void res.writeHead(404).end();
      const isZip = path.endsWith('.zip');
      if (isZip && this.endEarlyAfter !== null) {
        res.writeHead(200, { 'transfer-encoding': 'chunked' });
        return void res.end(f.subarray(0, this.endEarlyAfter));
      }
      res.writeHead(200, { 'content-length': f.length });
      if (isZip && this.cutAfter !== null) {
        res.write(f.subarray(0, this.cutAfter));
        return void setTimeout(() => res.destroy(), 50);
      }
      if (isZip && this.stallAfter !== null) return void res.write(f.subarray(0, this.stallAfter));
      if (!this.slow || !isZip) return void res.end(f);
      let at = 0;
      const t = setInterval(() => {
        if (res.destroyed) return clearInterval(t);
        res.write(f.subarray(at, (at += this.slow)));
        if (at >= f.length) {
          clearInterval(t);
          res.end();
        }
      }, 50);
    });
  }
  async listen() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
  /** A published release with its zip (arm64) and SHA256SUMS.txt. */
  publish(version: string, o: PublishOptions = {}) {
    const assets: { name: string; browser_download_url: string }[] = [];
    if (o.zip !== false) {
      const zip = o.zipBytes ?? zipOf(o.appVersion ?? version);
      const name = zipName(version, 'arm64');
      this.files.set(`dl/${name}`, zip);
      this.files.set(`dl/${version}/SHA256SUMS.txt`, Buffer.from(o.sums ?? `${o.sum ?? sha(zip)}  ${name}\n${'0'.repeat(64)}  Atlas-${version}-arm64.dmg\n`));
      assets.push({ name, browser_download_url: `${this.url}/dl/${name}` }, { name: 'SHA256SUMS.txt', browser_download_url: `${this.url}/dl/${version}/SHA256SUMS.txt` });
    }
    this.releases.unshift({ tag_name: `v${version}`, draft: !!o.draft, prerelease: !!o.prerelease, body: o.body ?? `## Fixed · notes of ${version}`, published_at: '2026-11-18T10:00:00Z', assets });
  }
}
