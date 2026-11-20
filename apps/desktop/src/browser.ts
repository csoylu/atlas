import { session, shell, WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron';
import type { BrowserHost, BrowserHostEvent, BrowserHostTab } from '@atlas/engine';
import { DRIVING_MS, type BrowserShot } from '@atlas/shared';

/**
 * The shared browser's Electron backend (#298 §3.1, S6): one WebContentsView per chat tab, laid over the pane's page
 * area of the Atlas window. Each workspace has its own session (`persist:ws-<project>-<agent>`: cookies, cache,
 * storage on disk) whose traffic goes through the workspace's allow-list proxy (`ses.setProxy`, the token answered
 * on the proxy's 407); loopback stays direct (Chromium's default bypass), so the agent's dev server opens. The engine
 * drives a page over CDP (`webContents.debugger`, attached after the first load).
 *
 * Input owner: while the agent has the tab, Master's mouse and keys in the view are refused (before-input-event,
 * before-mouse-event), except the events the agent's own CDP Input.* commands dispatch.
 *
 * Pages are hostile (an agent opens any site): every permission is denied (microphone, camera, notifications,
 * location, devices…), WebRTC sends no UDP outside the proxy, and a page reaches the system only through
 * `EXTERNAL_SCHEMES` (mailto:, tel:) or an http(s) download, each right after Master's own click or key in that view.
 * Everything else (smb:, file:, custom app schemes, a page opening things by itself) is refused, and the tab says so.
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
  /** Last time Master's own input reached the page (a user gesture, used once to open something outside). */
  gestureAt: number;
  /**
   * The agent's action shown over the page (#306): a transparent view laid on the page while the agent drives, with
   * the accent edge, the pulse and the caption. It takes Master's clicks then (they are refused anyway, and reported).
   */
  overlay: WebContentsView | null;
  /** Until when the overlay shows (DRIVING_MS after the agent's last action). */
  overlayUntil: number;
  overlayTimer: ReturnType<typeof setTimeout> | null;
}

const BLOCK_REPORT_MS = 1500;

/**
 * The overlay's page (#306, mockup « workbench » Browser › Agent clicks): an accent edge around the page, a pulse on
 * the spot (30 px ring, 8 px dot) and the caption at the bottom left. Atlas's tokens, both themes (`show` sets it).
 */
export const OVERLAY_HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:440 13px/1.3 -apple-system,BlinkMacSystemFont,"Inter",sans-serif}
:root{--accent:#6cc0d2;--soft:rgba(108,192,210,.14);--raised:#17181b;--line:rgba(255,255,255,.11);--text:#e3e4e6;--shadow:0 12px 32px rgba(0,0,0,.55)}
:root.light{--accent:#1b6c80;--soft:#e2eff2;--raised:#fbfbfc;--line:rgba(0,0,0,.11);--text:#1b1c1f;--shadow:0 10px 28px rgba(16,24,40,.14)}
#edge{position:fixed;inset:0;box-shadow:inset 0 0 0 2px var(--accent);pointer-events:none}
#pulse{position:fixed;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid var(--accent);background:var(--soft);box-sizing:border-box;animation:ping 1.6s ease-out 3}
#pulse::after{content:'';position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--accent)}
@keyframes ping{0%{transform:scale(.5);opacity:1}100%{transform:scale(1.6);opacity:0}}
#cap{position:fixed;left:12px;bottom:12px;display:flex;align-items:center;gap:8px;max-width:calc(100% - 48px);padding:6px 12px 6px 8px;border-radius:10px;background:var(--raised);border:1px solid var(--line);box-shadow:var(--shadow);color:var(--text)}
#cap i{width:8px;height:8px;border-radius:50%;background:var(--accent);flex:none;margin:0 3px}
#cap span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style><div id="edge"></div><div id="cap" hidden><i></i><span></span></div><script>
function show(s){document.documentElement.className=s.theme;const c=document.getElementById('cap');c.hidden=!s.caption;c.querySelector('span').textContent=s.caption;
const old=document.getElementById('pulse');if(old)old.remove();if(s.point){const p=document.createElement('div');p.id='pulse';p.style.left=s.point.x+'px';p.style.top=s.point.y+'px';document.body.appendChild(p)}}
</script>`;
/** How long Master's click or key counts as the gesture that lets the page open a mailto: or start a download. */
const GESTURE_MS = 1000;
/** The only schemes a page may hand to the system, after Master's gesture (§3.2: mail and phone links). */
export const EXTERNAL_SCHEMES = ['mailto:', 'tel:'];

export class ElectronBrowser implements BrowserHost {
  private tabs = new Map<string, Tab>();
  private listeners = new Set<(e: BrowserHostEvent) => void>();
  /** Proxy credentials per partition, answered on the proxy's 407. */
  private creds = new Map<string, { username: string; password: string }>();
  private sessions = new Map<string, string>();
  private onScreen: string | null = null;
  private bounds: { x: number; y: number; width: number; height: number } | null = null;

  /**
   * `window()`: the Atlas window now (it can be closed and made again on macOS). `openExternal`: the system's opener
   * (tests record the calls instead).
   */
  constructor(
    private window: () => BrowserWindow | null,
    private openExternal: (url: string) => void = (url) => void shell.openExternal(url),
  ) {}

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
    this.dropOverlay(tab);
    if (this.onScreen === id) this.onScreen = null;
  }

  show(id: string | null, bounds: { x: number; y: number; width: number; height: number } | null): void {
    this.onScreen = id;
    this.bounds = bounds;
    this.place();
  }

  setOwner(id: string, owner: 'agent' | 'master'): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.owner = owner;
    if (owner === 'master' && tab.overlayUntil) {
      tab.overlayUntil = 0; // Master drives: nothing over the page
      this.place();
    }
  }

  async capture(id: string): Promise<BrowserShot> {
    const tab = this.need(id);
    const img = await tab.view.webContents.capturePage();
    const zoom = this.window()?.webContents.getZoomFactor() ?? 1;
    const b = tab.view.getBounds();
    return { image: img.toDataURL(), width: Math.round(b.width / zoom) || img.getSize().width, height: Math.round(b.height / zoom) || img.getSize().height };
  }

  signal(id: string, s: { caption: string; point: { x: number; y: number } | null }): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const overlay = tab.overlay ?? this.makeOverlay(tab);
    tab.overlayUntil = Date.now() + DRIVING_MS;
    if (tab.overlayTimer) clearTimeout(tab.overlayTimer);
    tab.overlayTimer = setTimeout(() => {
      tab.overlayTimer = null;
      tab.overlayUntil = 0;
      this.place();
    }, DRIVING_MS);
    const theme = this.window()?.webContents.executeJavaScript('document.documentElement.dataset.theme || "dark"') ?? Promise.resolve('dark');
    void theme
      .catch(() => 'dark') // the window is reloading: the dark look, the caption still shows
      .then((t: unknown) => overlay.webContents.executeJavaScript(`show(${JSON.stringify({ ...s, theme: t === 'light' ? 'light' : 'dark' })})`))
      .catch((e: unknown) => console.error('[browser] overlay', e));
    this.place();
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
    // WebRTC: no UDP that skips the proxy (STUN would reach the internet directly, past the workspace's level).
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    view.setVisible(false);
    const tab: Tab = { id: t.id, view, partition: t.partition, proxyKey, owner: 'master', agentInput: 0, attached: false, blockedAt: 0, gestureAt: 0, overlay: null, overlayUntil: 0, overlayTimer: null };
    this.tabs.set(t.id, tab);
    this.wire(tab, view.webContents);
    this.window()?.contentView.addChildView(view);
    return tab;
  }

  /** The overlay of a tab: a transparent page of Atlas's own (no network, no script from the site). */
  private makeOverlay(tab: Tab): WebContentsView {
    const overlay = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true } });
    overlay.setBackgroundColor('#00000000');
    overlay.setVisible(false);
    void overlay.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML));
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.webContents.on('will-navigate', (e) => e.preventDefault());
    // Master's click or key while the agent acts lands here: refused like on the page, and reported (the strip).
    const blocked = (e: Electron.Event) => {
      e.preventDefault();
      const now = Date.now();
      if (now - tab.blockedAt > BLOCK_REPORT_MS) this.emit({ type: 'input-blocked', id: tab.id });
      tab.blockedAt = now;
    };
    overlay.webContents.on('before-input-event', (e) => blocked(e));
    overlay.webContents.on('before-mouse-event', (e, m) => {
      if (m.type === 'mouseDown' || m.type === 'mouseWheel') blocked(e);
    });
    tab.overlay = overlay;
    this.window()?.contentView.addChildView(overlay);
    return overlay;
  }

  private dropOverlay(tab: Tab): void {
    if (tab.overlayTimer) clearTimeout(tab.overlayTimer);
    tab.overlayTimer = null;
    tab.overlayUntil = 0;
    const o = tab.overlay;
    tab.overlay = null;
    if (!o) return;
    this.window()?.contentView.removeChildView(o);
    if (!o.webContents.isDestroyed()) o.webContents.close();
  }

  /** « Clear browser data » (#308): cookies, logins, every storage and the cache of a workspace's profile. */
  async clearData(partition: string): Promise<void> {
    const ses = session.fromPartition(partition);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
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
    }
    if (!this.guarded.has(ses)) {
      this.guarded.add(ses);
      // Every permission denied, asked or checked: a page never gets the microphone (Atlas holds it for voice),
      // the camera, notifications, location, HID/USB/serial devices.
      ses.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      ses.setPermissionCheckHandler(() => false);
      ses.setDevicePermissionHandler(() => false);
      // Nothing is saved from the pane (§3.2): an http(s) download Master clicked opens in the system browser.
      ses.on('will-download', (e, item, wc) => {
        e.preventDefault();
        const tab = [...this.tabs.values()].find((t) => !t.view.webContents.isDestroyed() && t.view.webContents === wc);
        if (tab) this.outside(tab, item.getURL(), ['http:', 'https:'], 'download');
      });
    }
    return ses;
  }

  private guarded = new WeakSet<Session>();

  /**
   * The page wants the system to open `url` (a mailto: link, a download): only one of `schemes`, only right after
   * Master's own click or key in this view (the gesture is used up). Anything else is refused, and the tab says so.
   */
  private outside(tab: Tab, url: string, schemes: string[], what: 'link' | 'download'): void {
    let scheme = '';
    try {
      scheme = new URL(url).protocol;
    } catch {
      /* not a URL: refused below */
    }
    const gesture = tab.owner === 'master' && Date.now() - tab.gestureAt < GESTURE_MS;
    if (schemes.includes(scheme) && gesture) {
      tab.gestureAt = 0;
      this.openExternal(url);
      return;
    }
    const shown = url.length > 80 ? url.slice(0, 80) + '…' : url;
    const message = !schemes.includes(scheme)
      ? `The page tried to open ${shown} outside Atlas: refused (${what === 'download' ? 'only http and https downloads' : `only ${EXTERNAL_SCHEMES.join(' and ')} links`} leave the pane).`
      : `The page tried to open ${shown} outside Atlas without your click: refused.`;
    this.emit({ type: 'refused', id: tab.id, url, message });
  }

  private emit(e: BrowserHostEvent): void {
    this.listeners.forEach((l) => l(e));
  }

  private wire(tab: Tab, wc: WebContents): void {
    const emit = (e: BrowserHostEvent) => this.emit(e);
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
    // Pop-ups and target=_blank stay in the pane; mailto: and tel: go to the system after Master's click; the rest
    // (smb:, file:, app schemes…) is refused.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void this.load(tab, url);
      else this.outside(tab, url, EXTERNAL_SCHEMES, 'link');
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => {
      if (!/^https?:/i.test(e.url)) {
        e.preventDefault();
        this.outside(tab, e.url, EXTERNAL_SCHEMES, 'link');
      }
    });
    wc.on('will-frame-navigate', (e) => {
      // A sub-frame's navigation to another scheme (an iframe pointed at smb:…): refused the same way.
      if (!e.isMainFrame && !/^(https?|about|data|blob):/i.test(e.url)) e.preventDefault();
    });
    const block = (e: Electron.Event) => {
      if (tab.agentInput > 0) return; // the agent's own CDP input
      if (tab.owner !== 'agent') {
        tab.gestureAt = Date.now();
        return;
      }
      e.preventDefault();
      const now = Date.now();
      // Reported at most every BLOCK_REPORT_MS while the agent acts (the strip); at once when it is idle, since then
      // the click takes control (engine browser.ts) and must not be lost to a report made just before.
      if (now - tab.blockedAt > BLOCK_REPORT_MS || now >= tab.overlayUntil) emit({ type: 'input-blocked', id });
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
      const bounds = on ? { x: Math.round(this.bounds!.x * zoom), y: Math.round(this.bounds!.y * zoom), width: Math.round(this.bounds!.width * zoom), height: Math.round(this.bounds!.height * zoom) } : null;
      if (bounds) tab.view.setBounds(bounds);
      tab.view.setVisible(on);
      const o = tab.overlay;
      if (o && !o.webContents.isDestroyed()) {
        const over = !!bounds && tab.owner === 'agent' && Date.now() < tab.overlayUntil;
        if (over) {
          o.setBounds(bounds);
          win.contentView.addChildView(o); // on top of the page
        }
        o.setVisible(over);
      }
    }
  }

  private need(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`no browser view for ${id}`);
    return tab;
  }
}
