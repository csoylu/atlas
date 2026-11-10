// Build the Mac app and install it in /Applications, replacing the previous version (npm -w @atlas/desktop run install:mac).
// Quits a running Atlas first (its engine stops cleanly; runs resume on the next start), then copies the fresh .app.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { arch } from 'node:os';
import { join } from 'node:path';

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const here = import.meta.dirname;
const root = join(here, '../..');

if (process.platform !== 'darwin') throw new Error('install:mac runs on macOS only');
run('npm', ['run', 'dist:mac'], { cwd: here });

const built = join(here, 'release', arch() === 'arm64' ? 'mac-arm64' : 'mac', 'Atlas.app');
if (!existsSync(built)) throw new Error(`no build at ${built}`);
const target = '/Applications/Atlas.app';

// Quit the running app and wait for it to exit (up to 15 s).
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
