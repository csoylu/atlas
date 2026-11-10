import { app, BrowserWindow, dialog, nativeTheme, safeStorage, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEngine, type Engine, type SecretStore } from '@atlas/engine';

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

let engine: Engine | undefined;
let quitting = false;

function createWindow(url: string) {
  const win = new BrowserWindow({
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
  });
  // Links and url-node « open in new tab » go to the system browser, never a second Electron window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  void win.loadURL(url);
}

async function start() {
  if (DEV_UI) return createWindow(DEV_UI);
  const dataDir = join(app.getPath('userData'), 'data');
  mkdirSync(dataDir, { recursive: true });
  // The built UI ships as an extra resource in the packaged app; in a local build it sits in packages/ui/dist.
  const uiDir = app.isPackaged ? join(process.resourcesPath, 'ui') : join(app.getAppPath(), '../../packages/ui/dist');
  engine = await startEngine({ dbFile: join(dataDir, 'atlas.db'), dataDir, port: 0, uiDir, secrets: new KeychainStore() });
  createWindow(engine.url);
}

// One app per data folder: two engines on one database would fight over runs.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
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
    if (BrowserWindow.getAllWindows().length === 0 && (engine || DEV_UI)) createWindow(engine?.url ?? DEV_UI!);
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  // Graceful shutdown: running agents end 'interrupted' and resume at next launch (design §6).
  app.on('before-quit', (e) => {
    if (!engine || quitting) return;
    e.preventDefault();
    quitting = true;
    engine.stop().finally(() => app.quit());
  });
}
