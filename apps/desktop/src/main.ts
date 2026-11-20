import { app, BrowserWindow, dialog, globalShortcut, nativeTheme, safeStorage, shell, systemPreferences } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startEngine, type Engine, type SecretStore, type UpdateHost, type VoiceHost } from '@atlas/engine';
import { OrbOverlay } from './orb/overlay.ts';
import { DesktopVoice, voiceLog } from './voice.ts';
import { nativeHoldKey } from './optionkey.ts';
import { AtlasTray } from './tray/tray.ts';
import { ElectronBrowser } from './browser.ts';
import { dockBadge, type TrayAction, type TrayInput } from './tray/model.ts';

/**
 * Atlas desktop. Default: runs the engine in this process (design §2) with data in the app's user-data folder, and
 * loads the UI from it. Dev (`npm run desktop`): ATLAS_UI_URL points at Vite and the engine runs separately.
 */
const DEV_UI = process.env.ATLAS_UI_URL;

// The npm package is @atlas/desktop; data belongs in « Atlas » (macOS: ~/Library/Application Support/Atlas,
// Windows: %APPDATA%\Atlas). Must run before anything reads userData.
app.setName('Atlas');
app.setPath('userData', join(app.getPath('appData'), 'Atlas'));

/** Model keys encrypted with the OS keychain (Electron safeStorage), in userData/secrets.json (CLAUDE.md rule 5). */
class KeychainStore implements SecretStore {
  readonly label = process.platform === 'darwin' ? 'macOS Keychain' : process.platform === 'win32' ? 'Windows DPAPI' : 'system keyring';
  private file = join(app.getPath('userData'), 'secrets.json');
  private data: Record<string, string> = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>) : {};

  names = () => Object.keys(this.data);
  get = (name: string) => (this.data[name] ? safeStorage.decryptString(Buffer.from(this.data[name], 'base64')) : undefined);
  set = (name: string, value: string) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('the OS keychain is not available: cannot store keys safely');
    this.data[name] = safeStorage.encryptString(value).toString('base64');
    this.save();
  };
  delete = (name: string) => {
    delete this.data[name];
    this.save();
  };
  private save() {
    writeFileSync(this.file + '.tmp', JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
}

/**
 * Voice mode (Settings → Voice), Mac only: models in userData/voice-models, the microphone through macOS's permission
 * prompt (Info.plist NSMicrophoneUsageDescription, set in package.json → build.mac.extendInfo).
 */
const voiceHost = (): VoiceHost | undefined =>
  process.platform !== 'darwin'
    ? undefined
    : {
        modelsDir: join(app.getPath('userData'), 'voice-models'),
        micAccess: () => systemPreferences.getMediaAccessStatus('microphone'),
        requestMicAccess: () => systemPreferences.askForMediaAccess('microphone'),
      };

/**
 * App updates (#123, docs/updater.md): the packaged Mac app in /Applications installs a release on Master's click
 * (the engine downloads and verifies it; a detached helper swaps the bundle after this app quits). Elsewhere: why not.
 */
const INSTALLED = '/Applications/Atlas.app';
function updateHost(): { host: UpdateHost | null; cannotInstall?: string } {
  if (process.platform !== 'darwin') return { host: null, cannotInstall: 'Updates install by themselves on a Mac only: download the new installer from GitHub.' };
  if (!app.isPackaged) return { host: null, cannotInstall: 'This is a development build: updates install in the packaged app only.' };
  const bundle = dirname(dirname(dirname(app.getPath('exe'))));
  if (bundle !== INSTALLED) return { host: null, cannotInstall: `Atlas runs from ${bundle}: updates install in ${INSTALLED} only.` };
  return { host: { appPath: bundle, arch: process.arch === 'arm64' ? 'arm64' : 'x64', quit: () => app.quit() } };
}

let engine: Engine | undefined;
let quitting = false;
/** A quit is waiting for the main window to close; cleared if Master cancels at the unsaved-drawing prompt. */
let quitPending = false;
/** The Atlas window (the voice orb is a second, always-present window: never count it as « the » window). */
let mainWindow: BrowserWindow | null = null;
/** Voice mode on a Mac: the voice loop (voice.ts) drives the orb (setState, transcript, speak). */
let orb: OrbOverlay | undefined;
let talk: DesktopVoice | undefined;
/** The menu bar / tray orb (card #54): with the in-process engine only (not in dev, where the engine runs apart). */
let tray: AtlasTray | undefined;
/** The shared browser's views (#298 S6), laid over the Atlas window: with the in-process engine only. */
let browser: ElectronBrowser | undefined;

function createWindow(url: string) {
  const win = (mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    // The frame colour of the theme the page will most likely pick (it follows the OS unless chosen in the app).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#f2f4f6',
    title: 'Atlas',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 12 },
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  }));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  // Links and url-node « open in new tab » go to the system browser, never a second Electron window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  void win.loadURL(url);
  browser?.reattach();
}

async function start() {
  if (DEV_UI) return createWindow(DEV_UI);
  const dataDir = join(app.getPath('userData'), 'data');
  mkdirSync(dataDir, { recursive: true });
  // The built UI ships as an extra resource in the packaged app; in a local build it sits in packages/ui/dist.
  const uiDir = app.isPackaged ? join(process.resourcesPath, 'ui') : join(app.getAppPath(), '../../packages/ui/dist');
  engine = await startEngine({ dbFile: join(dataDir, 'atlas.db'), dataDir, port: 0, uiDir, secrets: new KeychainStore(), version: app.getVersion(), voice: voiceHost(), updates: updateHost(), shellPath: 'login', browser: (browser = new ElectronBrowser(() => mainWindow)) });
  createWindow(engine.url);
  if (engine.voice) followVoice(engine, engine.voice);
  startTray(engine);
}

/** Atlas in front, on `hash` if given (#/inbox/<card>: that card's question or review; #/board?card=<id>: its ticket). */
function showAtlas(e: Engine, hash?: string) {
  const win = mainWindow;
  if (!win) createWindow(hash ? `${e.url}/${hash}` : e.url);
  else {
    if (win.isMinimized()) win.restore();
    if (hash) void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`);
  }
  mainWindow?.show();
  mainWindow?.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function startTray(e: Engine) {
  const fail = (what: string) => (err: unknown) => dialog.showErrorBox(what, err instanceof Error ? err.message : String(err)); // rule 3
  const input = (): TrayInput => ({
    platform: process.platform,
    voice: e.voice?.status() ?? null,
    loopRunning: talk?.running ?? false,
    orb: orb?.current ?? 'idle',
    needs: e.notifications.inbox().needsYou,
    running: e.kanban.list().filter((c) => c.status === 'running'),
    now: new Date(),
  });
  const act = (a: TrayAction) => {
    try {
      switch (a.type) {
        case 'open':
          return showAtlas(e);
        case 'go':
          return showAtlas(e, a.hash);
        case 'talk':
          if (!talk) throw new Error('voice mode is not running: turn it on (and wait until it says Ready) first');
          return talk.talk();
        case 'voice':
          return void e.voice?.update({ enabled: a.on }).catch(fail('Voice mode could not change'));
        case 'pause':
          return void e.voice?.update({ pause: { until: a.until } }).catch(fail('Listening could not be paused'));
        case 'resume':
          return void e.voice?.update({ pause: null }).catch(fail('Listening could not resume'));
        case 'stop':
          e.runner.stop(a.cardId);
          return;
        case 'quit':
          return app.quit();
      }
    } catch (err) {
      fail('Atlas')(err);
    }
  };
  tray = new AtlasTray({ input, act, log: (line) => voiceLog(voiceLogFile(), `tray ${line}`) });
  // The Dock icon stays still (#310); « needs you » is its badge: the count of tasks needing Master, cleared at zero.
  // Bursts of events (a run streaming card updates) read the Inbox once, like the tray (150 ms).
  let dockTimer: ReturnType<typeof setTimeout> | null = null;
  const setDock = () => app.dock?.setBadge(dockBadge({ needs: e.notifications.inbox().needsYou }));
  const syncDock = () => {
    dockTimer ??= setTimeout(() => {
      dockTimer = null;
      setDock();
    }, 150);
  };
  setDock();
  e.bus.on((ev) => {
    if (ev.type === 'card.updated' || ev.type === 'card.deleted' || ev.type === 'inbox.changed' || ev.type === 'notification.created' || ev.type === 'voice.updated') tray?.changed();
    if (ev.type === 'card.updated' || ev.type === 'card.deleted' || ev.type === 'inbox.changed') syncDock();
  });
}

/**
 * The voice orb overlay: the ember shows bottom-right while voice mode is on (Settings → Voice), hidden otherwise.
 * Its window is created the first time voice mode is on (none otherwise). Its position is remembered in settings.
 * While shown, its page streams the microphone to the voice loop (voice.ts), which runs once voice mode is ready.
 */
const voiceLogFile = () => join(app.getPath('userData'), 'data', 'logs', 'voice.log');

function followVoice(e: Engine, voice: NonNullable<Engine['voice']>) {
  let creating: Promise<OrbOverlay> | null = null;
  let shown = false;
  const sync = () => {
    talk?.sync();
    // paused (menu bar orb → Pause listening): hidden, so the microphone is closed too
    const on = voice.status().enabled && !voice.status().paused;
    if (on === shown) return;
    shown = on;
    creating ??= OrbOverlay.create({
      store: e.settings,
      dir: join(import.meta.dirname, 'orb'),
      onAudio: (samples) => talk?.feed(samples),
      onEscape: () => talk?.escape(),
      onDismiss: () => talk?.dismissed(),
      onError: (message) => talk?.error(new Error(`orb: ${message}`)),
      onTrace: (line) => voiceLog(voiceLogFile(), `orb ${line}`), // from the window's creation on
      onState: () => tray?.now(),
    }).then((o) => {
      orb = o;
      // push-to-talk (card #57): Electron's global shortcuts; register() is false when another app holds the keys
      const shortcuts = { register: (acc: string, cb: () => void) => globalShortcut.register(acc, cb), unregister: (acc: string) => globalShortcut.unregister(acc) };
      // hold ⌥ (card #75): a native event tap, Mac only
      const holdKey = process.platform === 'darwin' ? nativeHoldKey((line) => voiceLog(voiceLogFile(), line)) : null;
      talk = new DesktopVoice(e, o, voiceLogFile(), () => tray?.changed(), shortcuts, holdKey);
      talk.sync();
      return o;
    });
    creating
      .then((o) => (shown ? o.show() : o.hide()))
      // fail loudly (CLAUDE.md rule 3)
      .catch((err: unknown) => dialog.showErrorBox('The voice orb could not start', err instanceof Error ? (err.stack ?? err.message) : String(err)));
  };
  e.bus.on((ev) => {
    if (ev.type === 'voice.updated') sync();
  });
  sync();
}

// One app per data folder: two engines on one database would fight over runs.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const win = mainWindow;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start).catch((e: unknown) => {
    // Fail loudly (CLAUDE.md rule 3): a dialog, not a blank window.
    dialog.showErrorBox('Atlas could not start', e instanceof Error ? (e.stack ?? e.message) : String(e));
    app.exit(1);
  });
  app.on('activate', () => {
    if (!mainWindow && (engine || DEV_UI)) createWindow(engine?.url ?? DEV_UI!);
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // Graceful shutdown: running agents end 'interrupted' and resume at next launch (design §6).
  // The window closes first, then the engine stops.
  app.on('before-quit', (e) => {
    if (!engine || quitting) return;
    e.preventDefault();
    const stopAll = () => {
      if (quitting || !quitPending) return;
      quitting = true;
      talk?.stop();
      engine!.stop().finally(() => app.quit());
    };
    quitPending = true;
    const win = mainWindow;
    if (!win || win.isDestroyed()) return stopAll();
    win.once('closed', stopAll);
    win.close();
  });
}
