import { session, shell, WebContentsView, type BrowserWindow, type Session, type WebContents } from 'electron';
import type { BrowserHost, BrowserHostEvent, BrowserHostTab } from '@atlas/engine';
import { cssPath, DRIVING_MS, findPassage, type BrowserPill, type BrowserSelection, type BrowserShot } from '@atlas/shared';

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
  /**
   * Master's text selection on the page (#368), as last read in Atlas's isolated world (`SELECTION_JS`), and whether
   * a field of the page had the focus then (Q is the page's). Read after Master's mouse or key lets go.
   */
  sel: BrowserSelection | null;
  typing: boolean;
  /** Reads in flight answer in order: an older one never overwrites a newer. */
  selRead: number;
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
/**
 * The « Quote Q » pill over the page (#368, #367's .qt-pop): a view of Atlas's own laid above the page, so the site
 * neither sees it nor can break it. Its colours and fonts are the app's tokens of the moment (`paint`).
 */
export const PILL_HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
#p{position:fixed;left:2px;top:2px;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 6px 0 10px;border-radius:999px;box-sizing:border-box;white-space:nowrap;cursor:pointer;font-size:13px;font-weight:530;line-height:1.3}
#p svg{flex:none}#p b{font-weight:440;padding:0 5px}
</style><div id="p" title="Quote this passage (Q)"><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 9.2C3 6.6 4.4 4.7 6.6 4l.5 1c-1.2.6-1.9 1.5-2 2.6.9 0 1.7.7 1.7 1.7S6 11 5 11 3 10.4 3 9.2Zm6 0C9 6.6 10.4 4.7 12.6 4l.5 1c-1.2.6-1.9 1.5-2 2.6.9 0 1.7.7 1.7 1.7S12 11 11 11s-2-.6-2-1.8Z"/></svg><span>Quote</span><b>Q</b></div><script>
function paint(c){const p=document.getElementById('p');p.style.cssText='background:'+c.bg+';border:1px solid '+c.border+';color:'+c.text+';font-family:'+c.font;
p.querySelector('svg').style.color=c.accent;const k=p.querySelector('b');k.style.cssText='background:'+c.chip+';color:'+c.faint+';font-family:'+c.mono;return [Math.ceil(p.offsetWidth)+4,Math.ceil(p.offsetHeight)+4]}
</script>`;

/**
 * Master's selection on the page (#368), read in an isolated world (the site sees no script, no global): its text,
 * where it starts (CSS px of the viewport), the element it sits in, and whether a field has the focus. Nothing when
 * the selection is empty, blocked (user-select: none reads empty) or in a frame of another origin (not in this one).
 */
const SELECTION_JS = `(() => {
  const cssPath = ${cssPath.toString()};
  const a = document.activeElement;
  const typing = !!a && (a.isContentEditable || /^(input|textarea|select)$/i.test(a.tagName));
  const s = getSelection();
  const text = s && !s.isCollapsed && s.rangeCount ? s.toString().trim() : '';
  if (!text || typing) return { sel: null, typing };
  const r = s.getRangeAt(0);
  const c = r.commonAncestorContainer;
  const el = c.nodeType === 1 ? c : c.parentElement;
  const f = [...r.getClientRects()].find((x) => x.width > 0) || r.getBoundingClientRect();
  if (!el || !document.body) return { sel: null, typing };
  return { sel: { text: text.slice(0, 20000), rect: { x: f.left, y: f.top, w: f.width, h: f.height }, selector: el === document.body ? 'body' : cssPath(el, document.body), code: !!el.closest('pre, code') }, typing };
})()`;
/** Atlas's own world on a page, apart from the site's (and from the agent's CDP calls in the main world). */
const QUOTE_WORLD = 1368;

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
  /** The quote pill (#368): one view, over the tab on screen; its size once painted. */
  private pillView: WebContentsView | null = null;
  private pillAt: { id: string; x: number; y: number; size: [number, number] } | null = null;
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
    if (this.pillAt?.id === id) this.pill(id, null);
    if (this.onScreen === id) this.onScreen = null;
  }

  show(id: string | null, bounds: { x: number; y: number; width: number; height: number } | null): void {
    // Another tab, or none (the pane closed, a picture of the page instead): the pill and the selection go (#368).
    if (this.onScreen && (id !== this.onScreen || !bounds)) this.forget(this.onScreen);
    this.onScreen = id;
    this.bounds = bounds;
    this.place();
  }

  /** The quote pill at x, y (CSS px of the Atlas window), painted in the app's colours; null hides it (#368). */
  pill(id: string, p: BrowserPill): void {
    if (!p) {
      if (this.pillAt?.id === id || !this.pillAt) this.pillAt = null;
      return this.place();
    }
    const view = this.pillView && !this.pillView.webContents.isDestroyed() ? this.pillView : this.makePill();
    const at = { id, x: p.x, y: p.y, size: this.pillAt?.size ?? ([110, 36] as [number, number]) };
    this.pillAt = at;
    const paint = () =>
      view.webContents
        .executeJavaScript(`paint(${JSON.stringify({ ...p.colors, font: p.font, mono: p.mono })})`)
        .then((size: [number, number]) => {
          if (this.pillAt !== at) return;
          at.size = size;
          this.place();
        });
    void (view.webContents.isLoading() ? new Promise<void>((ok) => view.webContents.once('did-finish-load', () => ok())).then(paint) : paint()).catch((e: unknown) => console.error('[browser] pill', e));
    this.place();
  }

  /**
   * A quote's jump back (#368): the passage selected again on the page and scrolled to, for 2 s (the selection is
   * Master's own gesture on the page, no element added); waits up to 5 s for a page that is still loading.
   */
  async flash(id: string, passage: string, selector: string | null): Promise<boolean> {
    const wc = this.need(id).view.webContents;
    const code = `(() => {
      const findPassage = ${findPassage.toString()};
      const scope = (${JSON.stringify(selector)} && document.querySelector(${JSON.stringify(selector)})) || document.body;
      const r = scope && (findPassage(scope, ${JSON.stringify(passage)}) || (scope !== document.body && findPassage(document.body, ${JSON.stringify(passage)})));
      if (!r) return document.readyState === 'complete' ? 'no' : 'wait';
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      (r.startContainer.parentElement || document.body).scrollIntoView({ block: 'center' });
      const text = s.toString();
      setTimeout(() => { if (getSelection().toString() === text) getSelection().removeAllRanges(); }, 2000);
      return 'yes';
    })()`;
    for (let i = 0; i < 25; i++) {
      if (wc.isDestroyed()) return false;
      const r: unknown = wc.isLoading() ? 'wait' : await wc.executeJavaScriptInIsolatedWorld(QUOTE_WORLD, [{ code }]).catch(() => 'wait');
      if (r === 'yes' || r === 'no') return r === 'yes';
      await new Promise((ok) => setTimeout(ok, 200));
    }
    return false;
  }

  /** The tab's selection is gone (scrolled, navigated, hidden): said once, and its pill hidden. */
  private forget(id: string): void {
    const tab = this.tabs.get(id);
    if (this.pillAt?.id === id) this.pillAt = null;
    if (!tab?.sel) return;
    tab.sel = null;
    tab.selRead++;
    this.emit({ type: 'selection', id, sel: null });
  }

  /** Read the selection again after Master's mouse or key let go; said when it changed. */
  private readSelection(tab: Tab): void {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const n = ++tab.selRead;
    void wc
      .executeJavaScriptInIsolatedWorld(QUOTE_WORLD, [{ code: SELECTION_JS }])
      .then((r: { sel: BrowserSelection | null; typing: boolean } | null) => {
        if (n !== tab.selRead) return;
        tab.typing = !!r?.typing;
        const sel = r?.sel ?? null;
        if (JSON.stringify(sel) === JSON.stringify(tab.sel)) return;
        tab.sel = sel;
        if (!sel && this.pillAt?.id === tab.id) {
          this.pillAt = null;
          this.place();
        }
        this.emit({ type: 'selection', id: tab.id, sel });
      })
      .catch(() => undefined); // the page is going (a navigation): its selection goes with it, said by did-start-navigation
  }

  private makePill(): WebContentsView {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true } });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    void view.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PILL_HTML));
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (e) => e.preventDefault());
    // A click on the pill quotes the selection; the pill takes no key (the page keeps the focus).
    view.webContents.on('before-mouse-event', (e, m) => {
      if (m.type === 'mouseMove' || m.type === 'mouseEnter' || m.type === 'mouseLeave') return;
      e.preventDefault();
      if (m.type === 'mouseUp' && this.pillAt) this.emit({ type: 'quote', id: this.pillAt.id, via: 'pill' });
    });
    view.webContents.on('before-input-event', (e) => e.preventDefault());
    this.pillView = view;
    this.window()?.contentView.addChildView(view);
    return view;
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
    const tab: Tab = { id: t.id, view, partition: t.partition, proxyKey, owner: 'master', agentInput: 0, attached: false, blockedAt: 0, gestureAt: 0, overlay: null, overlayUntil: 0, overlayTimer: null, sel: null, typing: false, selRead: 0 };
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
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) this.forget(id);
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
    wc.on('before-input-event', (e, i) => {
      // Q quotes Master's selection (#368): only with one, no field focused, no modifier; any other key is the page's.
      // It changes nothing on the page, so it works while the agent drives too.
      if (i.type === 'keyDown' && !i.isAutoRepeat && i.key.toLowerCase() === 'q' && !i.control && !i.meta && !i.alt && tab.sel && !tab.typing && tab.agentInput === 0) {
        e.preventDefault();
        return emit({ type: 'quote', id, via: 'key' });
      }
      block(e);
      if (i.type === 'keyUp' && tab.agentInput === 0 && tab.owner === 'master') this.readSelection(tab);
    });
    wc.on('before-mouse-event', (e, m) => {
      // Moving over the page shows nothing to the agent: only presses, the wheel and menus are blocked.
      if (m.type === 'mouseMove' || m.type === 'mouseEnter' || m.type === 'mouseLeave') return;
      // The wheel scrolls the page from under the pill: it goes (#368).
      if (m.type === 'mouseWheel' && tab.agentInput === 0) this.forget(id);
      block(e);
      if (m.type === 'mouseUp' && tab.agentInput === 0 && tab.owner === 'master') this.readSelection(tab);
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
    // The quote pill, over the tab on screen only (#368), on top of the page and its overlay.
    const pv = this.pillView;
    if (pv && !pv.webContents.isDestroyed()) {
      const at = this.pillAt;
      const on = !!at && at.id === this.onScreen && !!this.bounds && !!this.tabs.get(at.id)?.sel;
      if (on) {
        pv.setBounds({ x: Math.round((at.x - 2) * zoom), y: Math.round((at.y - 2) * zoom), width: Math.round(at.size[0] * zoom), height: Math.round(at.size[1] * zoom) });
        pv.webContents.setZoomFactor(zoom);
        win.contentView.addChildView(pv);
      }
      pv.setVisible(on);
    }
  }

  private need(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`no browser view for ${id}`);
    return tab;
  }
}
