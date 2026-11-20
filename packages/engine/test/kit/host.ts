import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * What the machine running the tests lets them do (#314). Inside the agent sandbox (docs/howtos.md « Sandbox ») a test
 * cannot run `ps`, `osascript` or `open`, write the shared /tmp, or bind a unix socket under the long private TMPDIR
 * (macOS: 104 characters). A test of something that needs one of these skips there, by name, and still runs on CI and on
 * a developer's own shell; it is never made to pass by faking the host.
 */
const cannotRun = (file: string, args: string[]) => !!spawnSync(file, args, { stdio: 'ignore' }).error;

/** `ps` is refused (Seatbelt: Operation not permitted). */
export const psBlocked = cannotRun('ps', ['-p', String(process.pid)]);
/** `osascript` is refused: the app swap falls back to two renames. */
export const osascriptBlocked = process.platform === 'darwin' && cannotRun('/usr/bin/osascript', ['-e', '1']);
/** The shared /tmp is not writable (or absent). */
export const sharedTmpBlocked = (() => {
  try {
    rmSync(mkdtempSync('/tmp/atlas-probe-'), { recursive: true });
    return false;
  } catch {
    return true;
  }
})();
/** A unix socket in a folder of the temp dir does not fit in sockaddr_un (104 on macOS, 108 on Linux), with room for a name. */
export const socketPathTooLong = tmpdir().length + '/atlas-net-XXXXXX/proxy.sock'.length >= 104;
