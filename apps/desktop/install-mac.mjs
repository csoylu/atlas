// Build the Mac app and install it in /Applications, replacing the previous version (npm -w @atlas/desktop run install:mac).
// Quits a running Atlas first (its engine stops cleanly; runs resume on the next start), then copies the fresh .app.
// For a manual build from source only: agents never run it (CLAUDE.md « Releases »); Master's app updates itself from
// GitHub releases. The version comes from CHANGELOG.md, like CI's, so the updater compares it correctly.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { arch } from 'node:os';
import { join } from 'node:path';
import { versionOf } from '../../scripts/release/changelog.mjs';
import { readFileSync } from 'node:fs';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const here = import.meta.dirname;
const root = join(here, '../..');

if (process.platform !== 'darwin') throw new Error('install:mac runs on macOS only');
const version0 = versionOf(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'));
run('npm', ['-w', '@atlas/ui', 'run', 'build'], { cwd: root });
run('npm', ['run', 'build'], { cwd: here });
run('npx', ['electron-builder', '--mac', 'dir', `-c.extraMetadata.version=${version0}`], { cwd: here });

const built = join(here, 'release', arch() === 'arm64' ? 'mac-arm64' : 'mac', 'Atlas.app');
if (!existsSync(built)) throw new Error(`no build at ${built}`);
const target = '/Applications/Atlas.app';

// Quit the running app and wait for it to exit (up to 15 s); reopen it at the end if it was running.
let wasRunning = false;
try {
  execFileSync('pgrep', ['-f', `${target}/Contents/MacOS/Atlas`]);
  wasRunning = true;
} catch {}
try {
  execFileSync('osascript', ['-e', 'if application "Atlas" is running then tell application "Atlas" to quit']);
} catch {}
for (let i = 0; i < 30; i++) {
  try {
    execFileSync('pgrep', ['-f', `${target}/Contents/MacOS/Atlas`]);
  } catch {
    break; // not running
  }
  execFileSync('sleep', ['0.5']);
}

rmSync(target, { recursive: true, force: true });
run('ditto', [built, target]);
// A local build carries no quarantine flag, but clear it in case the build was downloaded.
try {
  execFileSync('xattr', ['-dr', 'com.apple.quarantine', target]);
} catch {}
const version = execFileSync('defaults', ['read', join(target, 'Contents/Info'), 'CFBundleShortVersionString']).toString().trim();
console.log(`installed ${target} (${version}, ${arch()})`);

// electron-builder rebuilt better-sqlite3 for Electron; put the Node build back so `npm test` keeps working.
run('npm', ['rebuild', 'better-sqlite3'], { cwd: root, stdio: 'ignore' });

// Reopen last: `open` launches through launchd, so the new app doesn't depend on this script (which may have been
// started by the app's own engine and is an orphan once it quit).
if (wasRunning || process.env.ATLAS_REOPEN === '1') {
  run('open', [target]);
  console.log('reopened Atlas');
}
