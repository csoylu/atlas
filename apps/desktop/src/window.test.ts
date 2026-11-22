// The Atlas window's open and quit rules (#340): every door (Dock, tray, second launch) and the quit's close, no Electron.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { closeForQuit, openDecision, type QuitState, type WindowState } from './window.ts';

const idle: QuitState = { pending: false, stopping: false };

describe('openDecision: what a click on the Dock icon (or Open Atlas) does', () => {
  it('window closed with the red X or Cmd+W: a new window', () => {
    expect(openDecision({ window: 'none', quit: idle, ready: true })).toEqual({ action: 'create' });
  });

  it('minimized: restored and shown; hidden or behind: shown', () => {
    expect(openDecision({ window: 'minimized', quit: idle, ready: true })).toEqual({ action: 'show', restore: true });
    expect(openDecision({ window: 'hidden', quit: idle, ready: true })).toEqual({ action: 'show', restore: false });
    expect(openDecision({ window: 'visible', quit: idle, ready: true })).toEqual({ action: 'show', restore: false });
  });

  it('during a quit: nothing, whatever the window (#324)', () => {
    for (const window of ['none', 'visible', 'hidden', 'minimized'] as WindowState[]) {
      expect(openDecision({ window, quit: { pending: true, stopping: false }, ready: true }).action).toBe('none');
      expect(openDecision({ window, quit: { pending: true, stopping: true }, ready: true }).action).toBe('none');
    }
  });

  it('before the engine has started: nothing (start() makes the first window)', () => {
    expect(openDecision({ window: 'none', quit: idle, ready: false })).toEqual({ action: 'none', why: 'the engine has not started yet' });
  });
});

/** A BrowserWindow as closeForQuit sees it: `closed` when the page unloads, `will-prevent-unload` when it refuses. */
class FakeWindow extends EventEmitter {
  webContents = new EventEmitter();
  closeCalls = 0;
  constructor(private readonly refuse: boolean) {
    super();
  }
  close() {
    this.closeCalls++;
    if (this.refuse) this.webContents.emit('will-prevent-unload');
    else this.emit('closed');
  }
}

describe('closeForQuit: the quit ends with the window closed or cancelled, never stuck pending', () => {
  it('the window closes: closed once, no listener left', () => {
    const win = new FakeWindow(false);
    const calls: string[] = [];
    closeForQuit(win, { closed: () => calls.push('closed'), cancelled: () => calls.push('cancelled') });
    expect(calls).toEqual(['closed']);
    expect(win.listenerCount('closed') + win.webContents.listenerCount('will-prevent-unload')).toBe(0);
  });

  it('the page refuses (unsaved edits): cancelled, and a later red X no longer quits the app', () => {
    const win = new FakeWindow(true);
    const calls: string[] = [];
    closeForQuit(win, { closed: () => calls.push('closed'), cancelled: () => calls.push('cancelled') });
    expect(calls).toEqual(['cancelled']);
    expect(win.listenerCount('closed') + win.webContents.listenerCount('will-prevent-unload')).toBe(0);
    win.emit('closed'); // Master saves, then closes the window: a plain close, not the old quit's
    expect(calls).toEqual(['cancelled']);
  });

  it('cancelled, then the Dock icon opens Atlas again (the #340 bug: the quit stayed pending)', () => {
    const quit: QuitState = { pending: true, stopping: false };
    closeForQuit(new FakeWindow(true), { closed: () => (quit.stopping = true), cancelled: () => (quit.pending = false) });
    expect(openDecision({ window: 'none', quit, ready: true })).toEqual({ action: 'create' });
  });
});
