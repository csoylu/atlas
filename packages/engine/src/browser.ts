import { MASTER_PANE, normalizeAddress, paneUrlProblem, type BrowserBounds, type BrowserOwner, type BrowserStatus, type BrowserTab } from '@atlas/shared';
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
}

interface Live {
  loading: boolean;
  error: string | null;
  crashed: boolean;
}

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
  open(chatId: string, typed: string, by: BrowserOwner): BrowserTab {
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
        `INSERT INTO browser_tabs (chat_id, project_id, agent_id, url, title, owner, updated_at) VALUES (?, ?, ?, ?, '', ?, ?)
         ON CONFLICT (chat_id) DO UPDATE SET project_id = excluded.project_id, agent_id = excluded.agent_id, url = excluded.url, owner = excluded.owner, updated_at = excluded.updated_at`,
      )
      .run(chatId, ws.projectId, ws.agentId, url, by, now);
    this.live.set(chatId, { loading: true, error: null, crashed: false });
    host.open(this.hostTab(this.row(chatId)!, true));
    this.opened.add(chatId);
    host.setOwner(chatId, by);
    return this.changed(chatId);
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
    if (owner === 'agent' && r.owner === 'master') this.handedBack.add(chatId);
    else if (owner === 'master') this.handedBack.delete(chatId);
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
    this.bus.emit({ type: 'browser.closed', chatId });
  }

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
      case 'input-blocked':
        return void this.bus.emit({ type: 'browser.updated', tab: this.toTab(r), blocked: true });
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
    if (!l) this.live.set(chatId, (l = { loading: false, error: null, crashed: false }));
    return l;
  }

  private toTab(r: Row): BrowserTab {
    const l = this.live.get(r.chat_id) ?? { loading: false, error: null, crashed: false };
    return { chatId: r.chat_id, projectId: r.project_id, agentId: r.agent_id, url: r.url, title: r.title, owner: r.owner, ...l, updatedAt: r.updated_at };
  }

  private changed(chatId: string): BrowserTab {
    const tab = this.toTab(this.mustRow(chatId));
    this.bus.emit({ type: 'browser.updated', tab });
    return tab;
  }
}
