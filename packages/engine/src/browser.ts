import { actionCaption, isDriving, MASTER_PANE, normalizeAddress, paneUrlProblem, type BrowserAction, type BrowserBounds, type BrowserInspected, type BrowserOwner, type BrowserShot, type BrowserStatus, type BrowserTab } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { InvalidError, NotFoundError, type Kanban } from './kanban.ts';
import { hostAllowed, notAllowed, OFFLINE, type Network } from './network.ts';

/**
 * The shared browser (#298 §3, S6). The engine keeps one tab per chat or task (`browser_tabs`, reopened after a
 * restart) and drives a BrowserHost: the desktop app's Electron views today (apps/desktop/src/browser.ts), a streamed
 * headless Chromium later (S8), behind the same interface. Agent tools (S7) go through `cdp` below.
 *
 * - Profile: one per workspace (project × agent), `persist:ws-<project>-<agent>`; Master's own pane: `persist:master`.
 * - Internet: an agent's tab goes through the workspace's allow-list proxy (network.ts), which applies its level at
 *   every request; loopback stays direct (the agent's dev server). Master's own pane goes direct.
 * - Input: one owner at a time. While the agent has it, Master's input in the view is blocked; while Master has it,
 *   the agent's calls are refused with « Master is using the browser ».
 */

export interface HostProxy {
  /** host:port of the proxy. */
  server: string;
  username: string;
  password: string;
}

export interface HostTab {
  id: string;
  /** Electron session partition (the browser profile). */
  partition: string;
  /** null: direct (Master's own pane). */
  proxy: HostProxy | null;
  /** The tab's page: loaded when the view is new (a restart, a crash), or always with `load`. */
  url: string | null;
  /** Load `url` even if the view already shows a page (Master or the agent opened it). */
  load: boolean;
}

export type HostEvent =
  | { type: 'navigated'; id: string; url: string }
  | { type: 'title'; id: string; title: string }
  | { type: 'loading'; id: string; loading: boolean }
  /** The main frame failed to load (Chromium's code and description: -111 ERR_TUNNEL_CONNECTION_FAILED…). */
  | { type: 'failed'; id: string; url: string; code: number; description: string }
  | { type: 'crashed'; id: string; reason: string }
  /** The page tried to open something outside Atlas (another scheme, a download) and the host refused it. */
  | { type: 'refused'; id: string; url: string; message: string }
  /** Master's mouse or keyboard reached the view while the agent has it: refused. */
  | { type: 'input-blocked'; id: string };

/** What a browser backend does. Every method acts on one tab (`id` = the chat id). */
export interface BrowserHost {
  /**
   * Make the tab's view if it has none (hidden; a view whose `partition` or `proxy` changed, or that crashed or went
   * with its window, is made again) and load `url` in a new view, or in any view with `load`. Idempotent otherwise.
   */
  open(tab: HostTab): void;
  history(id: string, action: 'back' | 'forward' | 'reload' | 'stop'): void;
  /** Destroy the view (the profile stays). */
  close(id: string): void;
  /** Show this tab's view at `bounds` (CSS px of the Atlas page), every other one hidden; null: none on screen. */
  show(id: string | null, bounds: BrowserBounds | null): void;
  /** Who has the input: 'agent' blocks Master's input in the view. */
  setOwner(id: string, owner: BrowserOwner): void;
  /** A CDP command on the tab's page (the debugger attaches after the first load). */
  send(id: string, method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** A picture of the page as shown (png data: URL) and its size in CSS px; the view must exist. */
  capture(id: string): Promise<BrowserShot>;
  /** Show the agent's action over the page (#306): a pulse on `point` (viewport CSS px) and the caption, for a moment. */
  signal(id: string, s: { caption: string; point: { x: number; y: number } | null }): void;
  on(listener: (e: HostEvent) => void): () => void;
}

/** The agent's call while Master has the browser. */
export class BrowserBusyError extends Error {
  constructor() {
    super('Master is using the browser');
  }
}

interface Row {
  chat_id: string;
  project_id: string | null;
  agent_id: string | null;
  url: string | null;
  title: string;
  owner: BrowserOwner;
  updated_at: string;
  opened_at: string | null;
  focused_at: string | null;
  agent_used: number;
}

interface Live {
  loading: boolean;
  error: string | null;
  crashed: boolean;
  needs: string | null;
  via: 'link' | 'typed' | null;
  action: BrowserAction | null;
}

const LIVE = (): Live => ({ loading: false, error: null, crashed: false, needs: null, via: null, action: null });

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/** The browser profile of a workspace (an Electron partition, kept on disk). */
export const partitionOf = (projectId: string | null, agentId: string | null): string =>
  projectId && agentId ? `persist:ws-${safe(projectId)}-${safe(agentId)}` : 'persist:master';

export class Browser {
  private live = new Map<string, Live>();
  /** Tabs handed to the host by this process (views die with the process). */
  private opened = new Set<string>();
  private onScreen: string | null = null;
  /** Tabs Master handed back since the agent's last call (S7 starts that call with « Master handed back the browser »). */
  private handedBack = new Set<string>();

  constructor(
    private db: Db,
    private bus: Bus,
    private kanban: Kanban,
    private network: Network,
    private host: BrowserHost | null,
    private why = 'The browser pane runs in the Atlas desktop app only: links open in a new tab here.',
  ) {
    host?.on((e) => this.onHost(e));
    bus.on((e) => {
      if (e.type === 'card.deleted' && this.row(e.id)) this.close(e.id);
    });
  }

  status(): BrowserStatus {
    return this.host ? { available: true, reason: null } : { available: false, reason: this.why };
  }

  get(chatId: string): BrowserTab | null {
    const r = this.row(chatId);
    return r ? this.toTab(r) : null;
  }

  list(): BrowserTab[] {
    return (this.db.prepare('SELECT * FROM browser_tabs ORDER BY updated_at DESC').all() as Row[]).map((r) => this.toTab(r));
  }

  /**
   * Open `url` in the chat's tab (made if new), as Master (a click on a link: Master gets the input) or as the agent
   * (refused while Master has it).
   */
  open(chatId: string, typed: string, by: BrowserOwner, via: 'link' | 'typed' = 'typed'): BrowserTab {
    const host = this.need();
    const url = normalizeAddress(typed);
    const bad = paneUrlProblem(url);
    if (bad) throw new InvalidError(bad);
    const ws = this.workspace(chatId);
    const prev = this.row(chatId);
    if (by === 'agent' && prev?.owner === 'master') throw new BrowserBusyError();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO browser_tabs (chat_id, project_id, agent_id, url, title, owner, updated_at, opened_at, focused_at, agent_used) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET project_id = excluded.project_id, agent_id = excluded.agent_id, url = excluded.url, owner = excluded.owner,
           updated_at = excluded.updated_at, agent_used = MAX(agent_used, excluded.agent_used)`,
      )
      .run(chatId, ws.projectId, ws.agentId, url, by, now, now, now, by === 'agent' ? 1 : 0);
    const prevLive = this.liveOf(chatId);
    this.live.set(chatId, { ...LIVE(), loading: true, via: by === 'master' ? via : null, action: by === 'agent' ? prevLive.action : null });
    host.open(this.hostTab(this.row(chatId)!, true));
    this.opened.add(chatId);
    host.setOwner(chatId, by);
    this.onPane(chatId, true); // the pane shows the browser (an agent's open shows the pane again)
    return this.changed(chatId);
  }

  /**
   * The browser tab of a chat with no page yet (#306, « + › Open a page »): the address bar waits. Master has it.
   * An existing tab is only focused.
   */
  create(chatId: string): BrowserTab {
    this.need();
    const ws = this.workspace(chatId);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO browser_tabs (chat_id, project_id, agent_id, url, title, owner, updated_at, opened_at, focused_at) VALUES (?, ?, ?, NULL, '', 'master', ?, ?, ?)
         ON CONFLICT (chat_id) DO NOTHING`,
      )
      .run(chatId, ws.projectId, ws.agentId, now, now, now);
    this.onPane(chatId, true);
    return this.changed(chatId);
  }

  /** Master shows the browser tab (it becomes the pane's active tab). */
  focus(chatId: string): void {
    this.mustRow(chatId);
    this.onPane(chatId, true);
  }

  /**
   * The agent acted on the page (#306; S7's browser_open and browser_act call it after each action): the pane shows a
   * pulse on the spot and a caption, the tab shows the agent is driving. `target` never carries a typed value.
   */
  acted(chatId: string, a: Omit<BrowserAction, 'at'>): BrowserTab {
    const r = this.mustRow(chatId);
    const action: BrowserAction = { verb: a.verb, target: a.target.slice(0, 200), point: a.point, at: new Date().toISOString() };
    this.liveOf(chatId).action = action;
    if (!r.agent_used) this.db.prepare('UPDATE browser_tabs SET agent_used = 1 WHERE chat_id = ?').run(chatId);
    if (this.opened.has(chatId)) this.host?.signal(chatId, { caption: actionCaption(r.agent_id ?? 'the agent', action), point: action.point });
    return this.changed(chatId);
  }

  /**
   * The agent needs Master on the page (#306: a login wall): the pane says why, with Take control. Cleared when
   * Master hands it back.
   */
  ask(chatId: string, why: string): BrowserTab {
    this.mustRow(chatId);
    this.liveOf(chatId).needs = why.replace(/\s+/g, ' ').trim().slice(0, 300) || 'to act on the page';
    this.onPane(chatId, true);
    return this.changed(chatId);
  }

  /** A picture of the page as shown (comment mode freezes the pane on it). */
  async shot(chatId: string): Promise<BrowserShot> {
    const host = this.need();
    this.ensure(this.mustRow(chatId));
    return host.capture(chatId);
  }

  /**
   * What is at a point (w = h = 0) or in an area of the page (comment mode, #306), read in the page as Master (allowed
   * whoever drives: it changes nothing). Selectors are rebuilt from ids and nth-of-type, like the html pages' helper.
   */
  async inspect(chatId: string, box: { x: number; y: number; w: number; h: number }): Promise<BrowserInspected> {
    const expression = `(${INSPECT.toString()})(${JSON.stringify(box)})`;
    const r = (await this.cdp(chatId, 'Runtime.evaluate', { expression, returnByValue: true }, 'master')) as { result?: { value?: BrowserInspected }; exceptionDetails?: { text?: string } };
    if (r.exceptionDetails || !r.result?.value) throw new Error(`the page could not be read (${r.exceptionDetails?.text ?? 'no answer'})`);
    return r.result.value;
  }

  /** Show the chat's tab at `bounds` (its view made and its last page loaded if this process has none yet), or none. */
  show(chatId: string | null, bounds: BrowserBounds | null): void {
    const host = this.need();
    if (chatId === null) {
      this.onScreen = null;
      return host.show(null, null);
    }
    const r = this.row(chatId);
    if (!r) throw new NotFoundError(`no browser tab in ${chatId}`);
    this.ensure(r);
    this.onScreen = chatId;
    host.show(chatId, bounds);
  }

  nav(chatId: string, action: 'back' | 'forward' | 'reload' | 'stop'): BrowserTab {
    const host = this.need();
    const r = this.mustRow(chatId);
    this.ensure(r);
    host.history(chatId, action);
    return this.toTab(r);
  }

  /** Take control (Master) or hand back (the agent). Master's own pane has no agent: always Master's. */
  setOwner(chatId: string, owner: BrowserOwner): BrowserTab {
    const host = this.need();
    const r = this.mustRow(chatId);
    if (owner === 'agent' && !r.agent_id) throw new InvalidError('Master’s own pane has no agent to hand it to');
    this.db.prepare('UPDATE browser_tabs SET owner = ?, updated_at = ? WHERE chat_id = ?').run(owner, new Date().toISOString(), chatId);
    if (owner === 'agent' && r.owner === 'master') {
      this.handedBack.add(chatId);
      this.liveOf(chatId).needs = null; // signed in: the agent carries on
    } else if (owner === 'master') this.handedBack.delete(chatId);
    if (this.opened.has(chatId)) host.setOwner(chatId, owner);
    return this.changed(chatId);
  }

  /** True once after Master handed the tab back: the agent's next call says so (S7). */
  takeHandBack(chatId: string): boolean {
    return this.handedBack.delete(chatId);
  }

  close(chatId: string): void {
    this.db.prepare('DELETE FROM browser_tabs WHERE chat_id = ?').run(chatId);
    this.live.delete(chatId);
    if (this.opened.delete(chatId)) this.host?.close(chatId);
    if (this.onScreen === chatId) this.onScreen = null;
    this.onPane(chatId, false);
    this.bus.emit({ type: 'browser.closed', chatId });
  }

  /** The pane's tab list changed (Documents, wired in index.ts): `focus` makes the browser the tab shown. */
  onPane: (chatId: string, focus: boolean) => void = () => {};

  /**
   * A CDP command on the chat's page. An agent's call is refused while Master has the browser (S7's tools come
   * through here); the tab's view is made and its page loaded first if needed.
   */
  async cdp(chatId: string, method: string, params: Record<string, unknown> | undefined, as: BrowserOwner): Promise<unknown> {
    const host = this.need();
    const r = this.mustRow(chatId);
    if (as === 'agent' && r.owner === 'master') throw new BrowserBusyError();
    this.ensure(r);
    return host.send(chatId, method, params);
  }

  /**
   * Resolves once the chat's page is not loading (S7: a snapshot waits for the page an action led to), or after
   * `timeoutMs` (the page is read as it is). `graceMs` first: a click's navigation starts a moment after the click.
   */
  async settle(chatId: string, o: { graceMs?: number; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    const { graceMs = 0, timeoutMs = 15_000, signal } = o;
    const wait = (ms: number, until: () => boolean) =>
      new Promise<boolean>((resolve, reject) => {
        if (until()) return resolve(true);
        const done = (v: boolean | Error) => {
          clearTimeout(timer);
          off();
          signal?.removeEventListener('abort', onAbort);
          return v instanceof Error ? reject(v) : resolve(v);
        };
        const onAbort = () => done(signal!.reason instanceof Error ? signal!.reason : new Error('aborted'));
        const timer = setTimeout(() => done(until()), ms);
        const off = this.bus.on((e) => {
          if (e.type === 'browser.updated' && e.tab.chatId === chatId && until()) done(true);
        });
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    if (graceMs) await wait(graceMs, () => false);
    return wait(timeoutMs, () => !this.liveOf(chatId).loading);
  }

  private onHost(e: HostEvent): void {
    const r = this.row(e.id);
    if (!r) return;
    const live = this.liveOf(e.id);
    switch (e.type) {
      case 'navigated':
        if (e.url === r.url) return void this.changed(e.id);
        this.db.prepare('UPDATE browser_tabs SET url = ?, updated_at = ? WHERE chat_id = ?').run(e.url, new Date().toISOString(), e.id);
        break;
      case 'title':
        if (e.title === r.title) return;
        this.db.prepare('UPDATE browser_tabs SET title = ? WHERE chat_id = ?').run(e.title.slice(0, 300), e.id);
        break;
      case 'loading':
        live.loading = e.loading;
        if (e.loading) {
          live.error = null;
          live.crashed = false;
        }
        break;
      case 'failed':
        live.loading = false;
        live.error = this.explain(r, e.url, e.description);
        break;
      case 'refused':
        live.error = e.message;
        break;
      case 'crashed':
        live.loading = false;
        live.crashed = true;
        live.error = `The page stopped (${e.reason}). Reload to open it again.`;
        break;
      case 'input-blocked': {
        // #298 §3.1: Master's click in the pane takes control, except while the agent is acting (the strip says so).
        const tab = this.toTab(r);
        if (!isDriving(tab)) return void this.setOwner(e.id, 'master');
        return void this.bus.emit({ type: 'browser.updated', tab, blocked: true });
      }
    }
    this.changed(e.id);
  }

  /** Why a page could not load, in the workspace's terms: offline, a host outside the list, else Chromium's reason. */
  private explain(r: Row, url: string, description: string): string {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* not a URL: say it as it is */
    }
    if (r.project_id && r.agent_id) {
      const s = this.network.setting(r.project_id, r.agent_id);
      if (s.level === 'off') return OFFLINE;
      if (s.level === 'hosts' && !hostAllowed(host, s.hosts)) return notAllowed(host);
    }
    return `${host} could not be loaded (${description})`;
  }

  /** The view exists, with the tab's profile, its proxy and (if new) its last page: the host keeps what it has. */
  private ensure(r: Row): void {
    const host = this.need();
    host.open(this.hostTab(r, false));
    if (!this.opened.has(r.chat_id) && r.url) this.liveOf(r.chat_id).loading = true;
    this.opened.add(r.chat_id);
    host.setOwner(r.chat_id, r.owner);
  }

  private hostTab(r: Row, load: boolean): HostTab {
    return { id: r.chat_id, partition: partitionOf(r.project_id, r.agent_id), proxy: this.proxyFor(r), url: r.url, load };
  }

  /** An agent's tab: its workspace's proxy (the proxy reads the level at every request, so a change applies at once). */
  private proxyFor(r: Row): HostProxy | null {
    if (!r.project_id || !r.agent_id) return null;
    const port = this.network.port;
    if (port === null) throw new Error('the network proxy is not running: the browser cannot apply the workspace’s internet setting');
    return { server: `127.0.0.1:${port}`, username: 'ws', password: this.network.token(r.project_id, r.agent_id) };
  }

  /** The workspace of a chat or task: its project and its agent; none for Master's own pane. */
  private workspace(chatId: string): { projectId: string | null; agentId: string | null } {
    if (chatId === MASTER_PANE) return { projectId: null, agentId: null };
    const c = this.kanban.get(chatId);
    if (!c.assignee) throw new InvalidError(`task ${c.number ?? chatId} has no agent: its links open in your own pane`);
    return { projectId: c.projectId, agentId: c.assignee };
  }

  private need(): BrowserHost {
    if (!this.host) throw new InvalidError(this.why);
    return this.host;
  }

  private row(chatId: string): Row | undefined {
    return this.db.prepare('SELECT * FROM browser_tabs WHERE chat_id = ?').get(chatId) as Row | undefined;
  }

  private mustRow(chatId: string): Row {
    const r = this.row(chatId);
    if (!r) throw new NotFoundError(`no browser tab in ${chatId}`);
    return r;
  }

  private liveOf(chatId: string): Live {
    let l = this.live.get(chatId);
    if (!l) this.live.set(chatId, (l = LIVE()));
    return l;
  }

  private toTab(r: Row): BrowserTab {
    const l = this.live.get(r.chat_id) ?? LIVE();
    return { chatId: r.chat_id, projectId: r.project_id, agentId: r.agent_id, url: r.url, title: r.title, owner: r.owner, ...l, agentUsed: !!r.agent_used, updatedAt: r.updated_at };
  }

  /** The chat's browser as a pane tab (Documents.tabs): its tab and its place in the pane's order. */
  paneTab(chatId: string): { tab: BrowserTab; openedAt: string; focusedAt: string } | null {
    const r = this.row(chatId);
    return r ? { tab: this.toTab(r), openedAt: r.opened_at ?? r.updated_at, focusedAt: r.focused_at ?? r.updated_at } : null;
  }

  private changed(chatId: string): BrowserTab {
    const tab = this.toTab(this.mustRow(chatId));
    this.bus.emit({ type: 'browser.updated', tab });
    return tab;
  }
}

/**
 * Runs in the page (Runtime.evaluate, comment mode): the element at a point, or the elements inside an area, each with
 * a selector that finds it again and its text. Plain DOM, no closure: it is sent as source.
 */
function INSPECT(b: { x: number; y: number; w: number; h: number }) {
  const sel = (el: Element): string => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && e !== document.documentElement && parts.length < 6; e = e.parentElement) {
      if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) {
        parts.unshift('#' + e.id);
        break;
      }
      const tag = e.tagName.toLowerCase();
      const same = e.parentElement ? Array.from(e.parentElement.children).filter((c) => c.tagName === e!.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(e) + 1})` : tag);
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  };
  const text = (el: Element): string => {
    const h = el as HTMLElement;
    const own = (h.getAttribute('aria-label') || (h as HTMLInputElement).placeholder || h.innerText || h.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
    // A field's value is never read (a password, a token): only its label.
    return own.slice(0, 300);
  };
  const rect = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  if (!b.w || !b.h) {
    const el = document.elementFromPoint(b.x, b.y);
    return { element: el ? { selector: sel(el), text: text(el), tag: el.tagName.toLowerCase(), box: rect(el) } : null, inside: [], viewport };
  }
  const inside: { selector: string; text: string }[] = [];
  for (const el of Array.from(document.body ? document.body.querySelectorAll('a,button,input,select,textarea,img,h1,h2,h3,h4,label,li,td,th,p,[role]') : [])) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.left < b.x || r.top < b.y || r.right > b.x + b.w || r.bottom > b.y + b.h) continue;
    inside.push({ selector: sel(el), text: text(el).slice(0, 120) });
    if (inside.length >= 12) break;
  }
  const mid = document.elementFromPoint(b.x + b.w / 2, b.y + b.h / 2);
  return { element: mid ? { selector: sel(mid), text: text(mid).slice(0, 300), tag: mid.tagName.toLowerCase(), box: rect(mid) } : null, inside, viewport };
}
