import { markdownToPlainText, systemTitle, type NotifierStatus, type ServerEvent } from '@atlas/shared';

/**
 * System notifications from the main process (#350), driven by the engine bus, so they show with the window open, in
 * the background or closed (Atlas in the menu bar). No Electron here: main.ts passes the real exec and Electron poster.
 *
 * macOS: the app is unsigned (ad-hoc), and since Electron 42 its own notifications need a signed app (they only emit
 * `failed`). So a Mac posts the banner with `osascript` (it shows under « Script Editor »; a click doesn't open the
 * chat). Title and body are agent text: they reach AppleScript only as `argv` of `on run argv`, never inside the script.
 * Elsewhere: Electron's Notification, its `failed` event reported the same way.
 */

export interface Notice {
  title: string;
  body: string;
  /** The in-app place a click opens (#/chat/<id>), where clicks work (not osascript banners). */
  hash?: string;
}

/** Which engine event makes a notification, and its text (the same text the page showed before #350). */
export function noticeOf(ev: ServerEvent, o: { notifyReplies: boolean; projectName(id: string): string }): Notice | null {
  if (ev.type === 'notification.created') return { title: systemTitle(ev.notification), body: ev.notification.body };
  // The engine sends it only when no window has that chat on screen and focused (#338).
  if (ev.type === 'chat.replied' && o.notifyReplies) return { title: `${ev.agentId} · ${o.projectName(ev.projectId)}`, body: ev.text, hash: `#/chat/${ev.chatId}` };
  return null;
}

/** The fixed script: the text is the last two arguments (whether osascript passes the « -- » on or not). */
const SCRIPT = ['on run argv', 'display notification (item -1 of argv) with title (item -2 of argv)', 'end run'];

/** osascript's arguments for one banner: the script as -e lines, then title and body as plain arguments. */
export function osascriptArgs(n: Notice): string[] {
  // A NUL byte can't be passed as an argument (execFile throws): dropped. Nothing else is touched.
  const arg = (s: string) => s.replaceAll('\0', '');
  return [...SCRIPT.flatMap((line) => ['-e', line]), '--', arg(n.title), arg(n.body)];
}

/** The subset of node's execFile the notifier uses (tests pass a fake). */
export type Exec = (
  file: string,
  args: string[],
  opts: { timeout: number },
  done: (err: (Error & { code?: number | string | null; killed?: boolean; signal?: string | null }) | null, stdout: string, stderr: string) => void,
) => void;

/** Shows one notification with Electron's Notification; calls `failed` if it can't. */
export type ElectronPoster = (n: Notice, on: { failed(reason: string): void; click(): void }) => void;

export const OSASCRIPT_TIMEOUT_MS = 10_000;

export class DesktopNotifier {
  private error: string | null = null;

  constructor(
    private o: {
      platform: NodeJS.Platform;
      exec: Exec;
      electron: ElectronPoster;
      /** The log line of a failure (main.ts: console and data/logs/notify.log). */
      log(line: string): void;
      /** A click on a notification that supports it. */
      open(hash: string): void;
    },
  ) {}

  status(): NotifierStatus {
    return { by: this.o.platform === 'darwin' ? 'osascript' : 'electron', error: this.error };
  }

  /** Posts it; a failure is logged and kept for Settings, never thrown (it runs from a bus listener). */
  show(notice: Notice): void {
    // Banners don't render markdown: agent text arrives as plain words (#363).
    const n = { ...notice, title: markdownToPlainText(notice.title), body: markdownToPlainText(notice.body) };
    if (this.o.platform !== 'darwin') {
      this.o.electron(n, { failed: (reason) => this.failed(reason), click: () => n.hash && this.o.open(n.hash) });
      return;
    }
    this.o.exec('/usr/bin/osascript', osascriptArgs(n), { timeout: OSASCRIPT_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (!err) {
        this.error = null;
        return;
      }
      const why = err.killed
        ? `osascript did not answer within ${OSASCRIPT_TIMEOUT_MS / 1000} s`
        : typeof err.code === 'number'
          ? `osascript exited with code ${err.code}`
          : `osascript could not run (${err.message})`;
      this.failed(stderr.trim() ? `${why}: ${stderr.trim().slice(0, 300)}` : why);
    });
  }

  private failed(reason: string): void {
    this.error = reason;
    this.o.log(`notification not shown: ${reason}`);
  }
}
