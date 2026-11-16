import { BrowserWindow, globalShortcut, ipcMain, screen, session, type Display, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { clampToArea, ORB_STATES, placeOf, restoreOrb, type OrbPlace, type OrbState } from './model.ts';
import type { FromOrb, ToOrb } from './protocol.ts';

/** Where the orb's position is remembered (the engine's Settings: SQLite). */
export interface OrbStore {
  orbPosition(): OrbPlace | null;
  setOrbPosition(p: OrbPlace): void;
}

export interface OrbOptions {
  store: OrbStore;
  /** Folder with orb.html, renderer.js and orb-preload.cjs (the desktop app's dist/orb). */
  dir: string;
  /** Master clicked the orb while it is awake (ends the conversation). The orb is already back at rest. */
  onDismiss?: () => void;
  /** Esc. Default: dismiss (rest). The voice loop handles it: while Atlas speaks, Esc stops it and listens. */
  onEscape?: () => void;
  /** Microphone frames (16 kHz mono float) while the orb is shown. */
  onAudio?: (samples: Float32Array) => void;
  /** The microphone or audio output failed (also shown on the orb). Default: console.error. */
  onError?: (message: string) => void;
  /** Every state change (the menu bar orb mirrors it). */
  onState?: (state: OrbState) => void;
  /** Placement diagnostics (every fit, page placement and drag), for logs/voice.log. */
  onTrace?: (line: string) => void;
}

/**
 * The voice orb: a transparent, frameless panel over the whole display the orb is on, above every window (full-screen
 * apps included) and on every Space. Mouse clicks go through it to the apps below, except on the orb itself (the page
 * reports when the mouse is over the orb; see renderer.ts). The orb can be dragged; its position is saved in settings.
 *
 * Driven by the voice loop: show()/hide() with voice mode, then setState(), transcript() and speak() per turn.
 */
export class OrbOverlay {
  private state: OrbState = 'idle';
  private nextId = 1;
  private readonly spoken = new Map<number, (played: boolean) => void>();
  private display: Display;
  private fitted = false;
  private shown = false;
  private escRegistered = false;
  private escAt = 0;
  private readonly onGlobalEsc = () => this.escape();
  private readonly onEvent = (e: IpcMainEvent, msg: FromOrb) => {
    if (e.sender === this.win.webContents) this.handle(msg);
  };
  // macOS sends bursts of display-metrics-changed with nothing changed (~10/s from the built-in display, 13 Nov):
  // ignored, neither logged nor refitted. A real change (or a monitor plugged in / out) refits.
  private readonly onMetrics = (_e: unknown, d: Display, changed: string[]) => {
    if (!changed.length) return;
    this.opts.onTrace?.(`display-metrics-changed ${d.id}: ${changed.join(',')}`);
    this.fit();
  };
  private readonly onAdded = (_e: unknown, d: Display) => {
    this.opts.onTrace?.(`display-added ${d.id}`);
    this.fit(); // the orb's own display may be back
  };
  private readonly onRemoved = (_e: unknown, d: Display) => {
    this.opts.onTrace?.(`display-removed ${d.id}`);
    this.fit();
  };

  private constructor(
    readonly win: BrowserWindow,
    private readonly opts: OrbOptions,
    display: Display,
  ) {
    this.display = display;
    ipcMain.on('orb:event', this.onEvent);
    screen.on('display-metrics-changed', this.onMetrics);
    screen.on('display-added', this.onAdded);
    screen.on('display-removed', this.onRemoved);
    // No blur handler on purpose: a click on another app must not end the conversation (Master, 13 Nov 2026). Only a
    // click on the orb, Esc (global shortcut while awake) or the voice loop's silence timeout put it back to rest.
    win.on('moved', () => this.opts.onTrace?.(`window moved by macOS to ${JSON.stringify(win.getBounds())}`));
    win.on('resized', () => this.opts.onTrace?.(`window resized by macOS to ${JSON.stringify(win.getBounds())}`));
    win.webContents.on('render-process-gone', (_e, d) => this.fail(`the orb window's page crashed (${d.reason})`));
  }

  static async create(opts: OrbOptions): Promise<OrbOverlay> {
    const display = OrbOverlay.target(opts.store).display;
    // Its own session: only this page may use the microphone.
    const ses = session.fromPartition('orb');
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
    const win = new BrowserWindow({
      ...display.bounds,
      type: process.platform === 'darwin' ? 'panel' : undefined, // NSPanel: floats over full-screen apps, takes keys without activating Atlas
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      enableLargerThanScreen: true,
      roundedCorners: false,
      alwaysOnTop: true,
      title: 'Atlas orb',
      webPreferences: {
        preload: join(opts.dir, 'orb-preload.cjs'),
        partition: 'orb',
        contextIsolation: true,
        sandbox: true,
        // replies play as soon as they arrive, no click needed
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setHiddenInMissionControl(true);
    win.setIgnoreMouseEvents(true, { forward: true });
    const overlay = new OrbOverlay(win, opts, display);
    await win.loadFile(join(opts.dir, 'orb.html'));
    overlay.fit();
    return overlay;
  }

  get current(): OrbState {
    return this.state;
  }

  /** Voice mode on: the ember at rest, bottom-right (or where it was dragged). Doesn't take focus. */
  show(): void {
    this.shown = true;
    this.send({ type: 'visible', visible: true });
    this.win.showInactive();
  }

  /** Voice mode off: hidden, animation stopped, microphone and audio closed. */
  hide(): void {
    this.shown = false;
    this.setState('idle');
    this.send({ type: 'visible', visible: false });
    this.win.hide();
  }

  setState(state: OrbState): void {
    if (!ORB_STATES.includes(state)) throw new Error(`unknown orb state: ${String(state)}`);
    const waking = this.state === 'idle' && state !== 'idle';
    this.state = state;
    if (state === 'idle') this.finishSpeech(false);
    this.send({ type: 'state', state });
    this.opts.onState?.(state);
    if (waking && this.shown) this.win.showInactive(); // never takes focus: Master keeps typing in their app
    this.globalEsc(state !== 'idle' && this.shown);
  }

  /** Esc while the orb is awake, whatever app is in front (the orb never has focus). Released at rest. */
  private globalEsc(on: boolean) {
    if (on === this.escRegistered) return;
    if (on) {
      if (!globalShortcut.register('Escape', this.onGlobalEsc)) {
        this.fail('Esc could not be registered as a global shortcut (another app holds it): click the orb to end the conversation');
        return;
      }
    } else globalShortcut.unregister('Escape');
    this.escRegistered = on;
  }

  /** Esc (global shortcut, or the page's keydown in tests): the voice loop decides; default: rest. */
  escape(): void {
    // the page's keydown and the global shortcut can both see one press
    const now = Date.now();
    if (now - this.escAt < 200) return;
    this.escAt = now;
    if (this.opts.onEscape) this.opts.onEscape();
    else this.dismiss();
  }

  /** Live transcript while listening. */
  transcript(text: string): void {
    this.send({ type: 'transcript', text });
  }

  /**
   * Plays one reply sentence (mono float PCM) and types its text in the caption while it plays; the orb's equalizer
   * follows the real output level. Resolves when it has been heard (true) or was cut off by a dismiss (false).
   */
  speak(text: string, samples: Float32Array, sampleRate: number): Promise<boolean> {
    if (this.state === 'idle') throw new Error('the orb is at rest: setState(speaking) before speak()');
    const id = this.nextId++;
    const done = new Promise<boolean>((resolve) => this.spoken.set(id, resolve));
    this.send({ type: 'speak', id, text, samples, sampleRate });
    return done;
  }

  /** Opens or closes the page's microphone (closed at rest when the wake word is off, card #57). */
  mic(on: boolean): void {
    this.send({ type: 'mic', on });
  }

  /** Barge-in: stop playing now, stay awake (pending speak() calls resolve false). */
  hush(): void {
    this.finishSpeech(false);
    this.send({ type: 'hush' });
  }

  /** Shows a voice loop error in the caption (the orb stays as it is). */
  error(message: string): void {
    this.send({ type: 'error', message });
  }

  /** Back to rest, as when Master clicks the orb. */
  dismiss(): void {
    if (this.state === 'idle') return;
    this.setState('idle');
    this.opts.onDismiss?.();
  }

  /** Closes the window (resolves once it is gone). */
  async destroy(): Promise<void> {
    ipcMain.off('orb:event', this.onEvent);
    this.globalEsc(false);
    screen.off('display-metrics-changed', this.onMetrics);
    screen.off('display-added', this.onAdded);
    screen.off('display-removed', this.onRemoved);
    this.finishSpeech(false);
    if (this.win.isDestroyed()) return;
    const closed = new Promise<void>((resolve) => this.win.once('closed', () => resolve()));
    this.win.close();
    await closed;
  }

  /** The display and spot the saved place maps to with the displays connected now (see restoreOrb). */
  private static target(store: OrbStore): { display: Display; pos: { x: number; y: number }; saved: OrbPlace | null } {
    const saved = store.orbPosition();
    const displays = screen.getAllDisplays();
    const r = restoreOrb(saved, displays, screen.getPrimaryDisplay().id);
    return { display: displays.find((d) => d.id === r.display)!, pos: r.pos, saved };
  }

  /**
   * Cover the orb's display and place the orb on it: its saved display if connected, else the primary one at the same
   * corner; bottom-right of the primary display the first time. Not the display under the pointer (the orb jumped
   * between screens as the pointer moved). Unchanged display and spot: nothing to do (no reset of the orb).
   */
  private fit() {
    const { display, pos, saved } = OrbOverlay.target(this.opts.store);
    const b0 = this.win.getBounds();
    const same = (a: Electron.Rectangle, b: Electron.Rectangle) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
    const displays = screen.getAllDisplays().map((d) => `${d.id}${d.id === screen.getPrimaryDisplay().id ? '*' : ''} ${d.bounds.x},${d.bounds.y} ${d.bounds.width}×${d.bounds.height}`).join(' | ');
    if (this.fitted && display.id === this.display.id && same(display.bounds, b0) && same(display.workArea, this.display.workArea)) {
      this.opts.onTrace?.(`fit: nothing changed (displays: ${displays})`);
      return;
    }
    this.opts.onTrace?.(`fit: window ${JSON.stringify(b0)} → display ${display.id} ${JSON.stringify(display.bounds)}, saved ${JSON.stringify(saved)} → orb at ${pos.x},${pos.y} (displays: ${displays})`);
    this.fitted = true;
    this.display = display;
    this.win.setBounds(display.bounds);
    const b = this.win.getBounds();
    this.send({ type: 'init', pos: { x: pos.x - b.x, y: pos.y - b.y } });
  }

  private handle(msg: FromOrb) {
    switch (msg.type) {
      case 'hit':
        // over the orb: take the click (drag); elsewhere: clicks go to the app below
        this.win.setIgnoreMouseEvents(!msg.on, { forward: true });
        return;
      case 'trace':
        this.opts.onTrace?.(`page: ${msg.line}`);
        return;
      case 'moved': {
        const b = this.win.getBounds();
        const p = clampToArea({ x: msg.pos.x + b.x, y: msg.pos.y + b.y }, this.display.workArea);
        this.opts.store.setOrbPosition(placeOf({ x: Math.round(p.x), y: Math.round(p.y) }, this.display));
        return;
      }
      case 'dismiss':
        return this.dismiss();
      case 'escape':
        return this.escape();
      case 'audio':
        this.opts.onAudio?.(msg.samples);
        return;
      case 'spoken':
        this.spoken.get(msg.id)?.(true);
        this.spoken.delete(msg.id);
        return;
      case 'error':
        return this.fail(msg.message);
    }
  }

  private finishSpeech(played: boolean) {
    for (const resolve of this.spoken.values()) resolve(played);
    this.spoken.clear();
  }

  private fail(message: string) {
    if (this.opts.onError) this.opts.onError(message);
    else console.error(`[orb] ${message}`);
  }

  private send(msg: ToOrb) {
    if (!this.win.isDestroyed()) this.win.webContents.send('orb', msg);
  }
}
