import { session, shell, WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron';
import type { BrowserHost, BrowserHostEvent, BrowserHostTab } from '@atlas/engine';

/**
 * The shared browser's Electron backend (#298 §3.1, S6): one WebContentsView per chat tab, laid over the pane's page
 * area of the Atlas window. Each workspace has its own session (`persist:ws-<project>-<agent>`: cookies, cache,
 * storage on disk) whose traffic goes through the workspace's allow-list proxy (`ses.setProxy`, the token answered
 * on the proxy's 407); loopback stays direct (Chromium's default bypass), so the agent's dev server opens. The engine
 * drives a page over CDP (`webContents.debugger`, attached after the first load).
 *
 * Input owner: while the agent has the tab, Master's mouse and keys in the view are refused (before-input-event,
 * before-mouse-event), except the events the agent's own CDP Input.* commands dispatch.
 */

interface Tab {
  id: string;
  view: WebContentsView;
  partition: string;
  proxyKey: string;
  owner: 'agent' | 'master';
  /** Input.* commands of the agent in flight: their events pass the input block. */
  agentInput: number;
  attached: boolean;
  /** Last time Master's blocked input was reported (one event per burst). */
  blockedAt: number;
}

const BLOCK_REPORT_MS = 1500;

export class ElectronBrowser implements BrowserHost {
  private tabs = new Map<string, Tab>();
  private listeners = new Set<(e: BrowserHostEvent) => void>();
  /** Proxy credentials per partition, answered on the proxy's 407. */
  private creds = new Map<string, { username: string; password: string }>();
  private sessions = new Map<string, string>();
  private onScreen: string | null = null;
  private bounds: { x: number; y: number; width: number; height: number } | null = null;

  /** `window()`: the Atlas window now (it can be closed and made again on macOS). */
  constructor(private window: () => BrowserWindow | null) {}

  on(l: (e: BrowserHostEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  open(t: BrowserHostTab): void {
    const proxyKey = t.proxy ? `${t.proxy.server}|${t.proxy.username}|${t.proxy.password}` : 'direct';
    let tab = this.tabs.get(t.id);
    if (tab && (tab.partition !== t.partition || tab.proxyKey !== proxyKey || tab.view.webContents.isDestroyed() || tab.view.webContents.isCrashed())) {
      this.close(t.id);
      tab = undefined;
    }
    const fresh = !tab;
    if (!tab) tab = this.make(t, proxyKey);
    if (t.url && (fresh || t.load)) void this.load(tab, t.url);
    if (this.onScreen === t.id) this.place();
  }

  history(id: string, action: 'back' | 'forward' | 'reload' | 'stop'): void {
    const wc = this.need(id).view.webContents;
    const h = wc.navigationHistory;
    if (action === 'back' && h.canGoBack()) h.goBack();
    else if (action === 'forward' && h.canGoForward()) h.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
  }

  close(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    this.window()?.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.onScreen === id) this.onScreen = null;
  }

  show(id: string | null, bounds: { x: number; y: number; width: number; height: number } | null): void {
    this.onScreen = id;
    this.bounds = bounds;
    this.place();
  }

  setOwner(id: string, owner: 'agent' | 'master'): void {
    const tab = this.tabs.get(id);
    if (tab) tab.owner = owner;
  }

  async send(id: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const tab = this.need(id);
    this.attach(tab);
    const input = method.startsWith('Input.');
    if (input) tab.agentInput++;
    try {
      return await tab.view.webContents.debugger.sendCommand(method, params);
    } finally {
      // The view handles the dispatched event after the command returns: release on the next turn.
      if (input) setTimeout(() => tab.agentInput--, 50);
    }
  }

  /** The views live in the window: a new window gets them back (macOS reopens it from the Dock). */
  reattach(): void {
    this.place();
  }

  private make(t: BrowserHostTab, proxyKey: string): Tab {
    const ses = this.session(t);
    const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    view.setVisible(false);
    const tab: Tab = { id: t.id, view, partition: t.partition, proxyKey, owner: 'master', agentInput: 0, attached: false, blockedAt: 0 };
    this.tabs.set(t.id, tab);
    this.wire(tab, view.webContents);
    this.window()?.contentView.addChildView(view);
    return tab;
  }

  /** The workspace's session, its proxy set (again when the token changed: a new engine start). */
  private session(t: BrowserHostTab): Session {
    const ses = session.fromPartition(t.partition);
    const key = t.proxy ? `${t.proxy.server}|${t.proxy.username}|${t.proxy.password}` : 'direct';
    if (t.proxy) this.creds.set(t.partition, { username: t.proxy.username, password: t.proxy.password });
    else this.creds.delete(t.partition);
    if (this.sessions.get(t.partition) !== key) {
      this.sessions.set(t.partition, key);
      void ses.setProxy(t.proxy ? { proxyRules: `http=${t.proxy.server};https=${t.proxy.server}` } : { mode: 'direct' });
      void ses.closeAllConnections();
      // Downloads go to the system browser (§3.2): nothing is saved from the pane.
      if (!ses.listenerCount('will-download'))
        ses.on('will-download', (e, item) => {
          e.preventDefault();
          void shell.openExternal(item.getURL());
        });
    }
    return ses;
  }

  private wire(tab: Tab, wc: WebContents): void {
    const emit = (e: BrowserHostEvent) => this.listeners.forEach((l) => l(e));
    const id = tab.id;
    wc.on('login', (e, _details, auth, cb) => {
      const c = this.creds.get(tab.partition);
      if (!auth.isProxy || !c) return;
      e.preventDefault();
      cb(c.username, c.password);
    });
    wc.on('did-start-loading', () => emit({ type: 'loading', id, loading: true }));
    wc.on('did-stop-loading', () => {
      emit({ type: 'loading', id, loading: false });
      this.attach(tab); // after the first load
    });
    wc.on('did-navigate', (_e, url) => emit({ type: 'navigated', id, url }));
    wc.on('did-navigate-in-page', (_e, url, main) => main && emit({ type: 'navigated', id, url }));
    wc.on('page-title-updated', (_e, title) => emit({ type: 'title', id, title }));
    wc.on('did-fail-load', (_e, code, description, url, main) => {
      // -3 ABORTED: a new navigation replaced this one, nothing failed.
      if (main && code !== -3) emit({ type: 'failed', id, url, code, description });
    });
    wc.on('render-process-gone', (_e, d) => emit({ type: 'crashed', id, reason: d.reason }));
    // Pop-ups and target=_blank stay in the pane; other schemes (mailto:, zoommtg:…) go to the system.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void this.load(tab, url);
      else void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => {
      if (!/^https?:/i.test(e.url)) {
        e.preventDefault();
        void shell.openExternal(e.url);
      }
    });
    const block = (e: Electron.Event) => {
      if (tab.owner !== 'agent' || tab.agentInput > 0) return;
      e.preventDefault();
      const now = Date.now();
      if (now - tab.blockedAt > BLOCK_REPORT_MS) emit({ type: 'input-blocked', id });
      tab.blockedAt = now;
    };
    wc.on('before-input-event', (e) => block(e));
    wc.on('before-mouse-event', (e, m) => {
      // Moving over the page shows nothing to the agent: only presses, the wheel and menus are blocked.
      if (m.type === 'mouseMove' || m.type === 'mouseEnter' || m.type === 'mouseLeave') return;
      block(e);
    });
  }

  private attach(tab: Tab): void {
    if (tab.attached || tab.view.webContents.isDestroyed()) return;
    const dbg = tab.view.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    tab.attached = true;
    dbg.on('detach', () => (tab.attached = false));
  }

  private async load(tab: Tab, url: string): Promise<void> {
    // A refused page is reported by did-fail-load; the promise's rejection says the same thing.
    await tab.view.webContents.loadURL(url).catch(() => undefined);
  }

  /** Every view hidden but the one on screen, laid over the pane at the page's zoom. */
  private place(): void {
    const win = this.window();
    if (!win || win.isDestroyed()) return;
    const zoom = win.webContents.getZoomFactor();
    for (const tab of [...this.tabs.values()]) {
      if (tab.view.webContents.isDestroyed()) {
        this.tabs.delete(tab.id); // went with a closed window: the engine makes it again at the next show
        continue;
      }
      if (!win.contentView.children.includes(tab.view)) win.contentView.addChildView(tab.view);
      const on = tab.id === this.onScreen && !!this.bounds && this.bounds.width > 0 && this.bounds.height > 0;
      if (on) {
        const b = this.bounds!;
        tab.view.setBounds({ x: Math.round(b.x * zoom), y: Math.round(b.y * zoom), width: Math.round(b.width * zoom), height: Math.round(b.height * zoom) });
      }
      tab.view.setVisible(on);
    }
  }

  private need(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`no browser view for ${id}`);
    return tab;
  }
}
