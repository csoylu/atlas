/**
 * The Atlas window's open and quit rules, without Electron (#340), so they run in unit tests.
 *
 * One rule opens Atlas from every door: the Dock icon (`activate`), the tray's « Open Atlas », a notification's link
 * and a second launch (Finder, Spotlight). Before #340 the Dock had its own rule (create only when no window) and the
 * second launch did nothing without a window, while the tray created, restored and showed.
 */

/** The Atlas window as the doors see it. `none`: closed (or never made). */
export type WindowState = 'none' | 'visible' | 'hidden' | 'minimized';

/** The quit in progress: `pending` while the window closes for a quit, `stopping` once the engine stops. */
export type QuitState = { pending: boolean; stopping: boolean };

/** What a door does: make a new window, bring the existing one back (restore if minimized), or nothing. */
export type OpenDecision = { action: 'create' } | { action: 'show'; restore: boolean } | { action: 'none'; why: string };

export function openDecision(s: { window: WindowState; quit: QuitState; ready: boolean }): OpenDecision {
  // No window on an engine that is stopping (#324): the quit ends the app, a window would show a dying engine.
  if (s.quit.stopping) return { action: 'none', why: 'quitting: the engine is stopping' };
  if (s.quit.pending) return { action: 'none', why: 'quitting: the window is closing for a quit' };
  if (!s.ready) return { action: 'none', why: 'the engine has not started yet' };
  if (s.window === 'none') return { action: 'create' };
  return { action: 'show', restore: s.window === 'minimized' };
}

/** What `closeForQuit` needs of a BrowserWindow (a fake in tests). */
export interface QuitWindow {
  once(event: 'closed', cb: () => void): unknown;
  off(event: 'closed', cb: () => void): unknown;
  close(): void;
  webContents: {
    once(event: 'will-prevent-unload', cb: () => void): unknown;
    off(event: 'will-prevent-unload', cb: () => void): unknown;
  };
}

/**
 * Closes the window for a quit: `closed` when it is gone (then the engine stops), `cancelled` when the page refused to
 * unload (unsaved file edits, FilesPane's beforeunload). Electron cancels both the close and its own quit then, and
 * tells the app nothing else: without this, the quit stayed « pending » for good and the Dock icon never opened Atlas
 * again (#340). Exactly one of the two is called.
 */
export function closeForQuit(win: QuitWindow, on: { closed: () => void; cancelled: () => void }): void {
  const wc = win.webContents; // read now: after `closed` the window is destroyed
  const closed = () => {
    wc.off('will-prevent-unload', refused);
    on.closed();
  };
  const refused = () => {
    win.off('closed', closed);
    on.cancelled();
  };
  win.once('closed', closed);
  wc.once('will-prevent-unload', refused);
  win.close();
}
