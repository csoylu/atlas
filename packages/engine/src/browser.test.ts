import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionCaption, appNavigation, DRIVING_MS, servedFile, isDriving, linkTarget, MASTER_PANE, normalizeAddress, type BrowserPaneTab, type BrowserStatus, type BrowserTab, type PanelTab, type ServerEvent } from '@atlas/shared';
import { launch } from '../test/kit/index.ts';
import type { BrowserHost, HostEvent, HostTab } from './browser.ts';

/** #298 S6: the browser engine against a fake BrowserHost (the Electron views are covered by e2e/tests/browser.spec.ts). */

class FakeHost implements BrowserHost {
  cleared: string[] = [];
  async clearData(partition: string): Promise<void> {
    this.cleared.push(partition);
  }
  calls: [string, ...unknown[]][] = [];
  tabs = new Map<string, HostTab>();
  owners = new Map<string, string>();
  shown: { id: string | null; bounds: unknown } = { id: null, bounds: null };
  private listeners = new Set<(e: HostEvent) => void>();
  open(t: HostTab) {
    this.calls.push(['open', t]);
    this.tabs.set(t.id, t);
  }
  history(id: string, action: string) {
    this.calls.push(['history', id, action]);
  }
  close(id: string) {
    this.calls.push(['close', id]);
    this.tabs.delete(id);
  }
  show(id: string | null, bounds: unknown) {
    this.calls.push(['show', id, bounds]);
    this.shown = { id, bounds };
  }
  setOwner(id: string, owner: string) {
    this.owners.set(id, owner);
  }
  async send(id: string, method: string, params?: Record<string, unknown>) {
    this.calls.push(['send', id, method, params]);
    return { ok: true };
  }
  async capture(id: string) {
    this.calls.push(['capture', id]);
    return { image: 'data:image/png;base64,AAAA', width: 800, height: 600 };
  }
  signals: [string, { caption: string; point: { x: number; y: number } | null }][] = [];
  signal(id: string, s: { caption: string; point: { x: number; y: number } | null }) {
    this.signals.push([id, s]);
  }
  pills: [string, unknown][] = [];
  pill(id: string, p: unknown) {
    this.pills.push([id, p]);
  }
  flashes: [string, string, string | null][] = [];
  async flash(id: string, passage: string, selector: string | null) {
    this.flashes.push([id, passage, selector]);
    return passage !== 'gone';
  }
  on(l: (e: HostEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: HostEvent) {
    for (const l of this.listeners) l(e);
  }
}

async function withBrowser(o: Parameters<typeof launch>[0] = {}) {
  const host = new FakeHost();
  const l = await launch({ dispatch: false, browser: host, ...o });
  const events: ServerEvent[] = [];
  l.engine.bus.on((e) => events.push(e));
  const pid = l.engine.projects.list()[0]!.id;
  return { ...l, host, events, pid };
}

describe('the shared browser (#298 S6)', () => {
  it('without a host (dev, server): unavailable, with the reason; opening a page is refused', async () => {
    const l = await launch({ dispatch: false });
    const s = await l.call<BrowserStatus>('GET', '/browser');
    expect(s.body).toEqual({ available: false, reason: expect.stringContaining('desktop app') });
    const chat = await l.chat();
    const r = await l.call<{ error: string }>('POST', `/browser/tabs/${chat.id}/open`, { url: 'https://example.com' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('desktop app');
  });

  it('a link in a chat opens its tab: the workspace profile, through the workspace proxy, Master has the input', async () => {
    const l = await withBrowser();
    const chat = await l.chat();
    const r = await l.call<BrowserTab>('POST', `/browser/tabs/${chat.id}/open`, { url: 'https://example.com/a' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ chatId: chat.id, projectId: l.pid, agentId: 'atlas', url: 'https://example.com/a', owner: 'master', loading: true, error: null });
    const t = l.host.tabs.get(chat.id)!;
    expect(t.partition).toBe(`persist:ws-${l.pid}-atlas`);
    expect(t.url).toBe('https://example.com/a');
    expect(t.proxy).toEqual({ server: `127.0.0.1:${l.engine.network.port}`, username: 'ws', password: l.engine.network.token(l.pid, 'atlas') });
    expect(l.host.owners.get(chat.id)).toBe('master');
    expect(l.events).toContainEqual({ type: 'browser.updated', tab: expect.objectContaining({ chatId: chat.id }) });
    // A typed address without its scheme.
    await l.call('POST', `/browser/tabs/${chat.id}/open`, { url: 'localhost:5173/x' });
    expect(l.host.tabs.get(chat.id)!.url).toBe('http://localhost:5173/x');
  });

  it('only http(s) opens in the pane: file://, javascript: and the like are refused', async () => {
    const l = await withBrowser();
    const chat = await l.chat();
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:x@y.z']) {
      const r = await l.call<{ error: string }>('POST', `/browser/tabs/${chat.id}/open`, { url });
      expect(r.status, url).toBe(400);
      expect(r.body.error).toContain('never open in the browser pane');
    }
    expect(l.host.calls).toEqual([]);
  });

  it('one profile per workspace: two agents, two partitions; Master’s own pane goes direct, in its own profile', async () => {
    const l = await withBrowser();
    expect((await l.call('POST', '/agents', { id: 'bob', modelId: l.engine.models.list()[0]!.id })).status).toBe(201);
    const a = await l.chat('atlas');
    const b = l.engine.kanban.create({ title: 'b task', assignee: 'bob' }, 'user');
    await l.call('POST', `/browser/tabs/${a.id}/open`, { url: 'https://a.test' });
    await l.call('POST', `/browser/tabs/${b.id}/open`, { url: 'https://b.test' });
    await l.call('POST', `/browser/tabs/${MASTER_PANE}/open`, { url: 'https://m.test' });
    const parts = [a.id, b.id, MASTER_PANE].map((id) => l.host.tabs.get(id)!.partition);
    expect(new Set(parts).size).toBe(3);
    expect(parts[2]).toBe('persist:master');
    expect(l.host.tabs.get(MASTER_PANE)!.proxy).toBeNull();
    expect(l.host.tabs.get(b.id)!.proxy!.password).not.toBe(l.host.tabs.get(a.id)!.proxy!.password);
    // No agent drives Master's pane.
    const r = await l.call<{ error: string }>('POST', `/browser/tabs/${MASTER_PANE}/owner`, { owner: 'agent' });
    expect(r.status).toBe(400);
  });

  it('a task without an agent has no tab of its own', async () => {
    const l = await withBrowser();
    const c = l.engine.kanban.create({ title: 'nobody', status: 'todo' }, 'user');
    const r = await l.call<{ error: string }>('POST', `/browser/tabs/${c.id}/open`, { url: 'https://x.test' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('has no agent');
  });

  it('the view reports: address and title stored, loading live, a refused host explained in the workspace’s terms', async () => {
    const l = await withBrowser();
    l.engine.projects.update(l.pid, { network: 'hosts', allowedHosts: ['github.com'] });
    const chat = await l.chat();
    await l.call('POST', `/browser/tabs/${chat.id}/open`, { url: 'https://github.com' });
    l.host.emit({ type: 'navigated', id: chat.id, url: 'https://github.com/csoylu' });
    l.host.emit({ type: 'title', id: chat.id, title: 'csoylu · GitHub' });
    l.host.emit({ type: 'loading', id: chat.id, loading: false });
    let tab = (await l.call<BrowserTab>('GET', `/browser/tabs/${chat.id}`)).body;
    expect(tab).toMatchObject({ url: 'https://github.com/csoylu', title: 'csoylu · GitHub', loading: false, error: null });
    l.host.emit({ type: 'failed', id: chat.id, url: 'https://example.com/', code: -111, description: 'ERR_TUNNEL_CONNECTION_FAILED' });
    tab = (await l.call<BrowserTab>('GET', `/browser/tabs/${chat.id}`)).body;
    expect(tab.error).toBe("example.com is not in this workspace's allowed hosts (Settings → Workspaces)");
    l.engine.projects.update(l.pid, { network: 'off' });
    l.host.emit({ type: 'failed', id: chat.id, url: 'https://github.com/', code: -111, description: 'ERR_TUNNEL_CONNECTION_FAILED' });
    expect(l.engine.browser.get(chat.id)!.error).toBe('This workspace is offline (Settings → Workspaces)');
    l.engine.projects.update(l.pid, { network: 'on' });
    l.host.emit({ type: 'failed', id: chat.id, url: 'https://down.test/', code: -105, description: 'ERR_NAME_NOT_RESOLVED' });
    expect(l.engine.browser.get(chat.id)!.error).toBe('down.test could not be loaded (ERR_NAME_NOT_RESOLVED)');
    l.host.emit({ type: 'loading', id: chat.id, loading: true });
    expect(l.engine.browser.get(chat.id)!.error).toBeNull();
    // The page tried to open something outside (smb:, a download without Master's click): the host refused, the tab says it.
    l.host.emit({ type: 'refused', id: chat.id, url: 'smb://evil.test/share', message: 'The page tried to open smb://evil.test/share outside Atlas: refused' });
    expect(l.engine.browser.get(chat.id)).toMatchObject({ error: expect.stringContaining('smb://evil.test/share') });
    l.host.emit({ type: 'loading', id: chat.id, loading: true });
    expect(l.engine.browser.get(chat.id)?.error).toBeNull();
    // A crash: said, and the next show makes a new view.
    l.host.emit({ type: 'crashed', id: chat.id, reason: 'oom' });
    expect(l.engine.browser.get(chat.id)).toMatchObject({ crashed: true, error: expect.stringContaining('oom') });
    const opens = l.host.calls.filter((c) => c[0] === 'open').length;
    await l.call('PUT', '/browser/view', { chatId: chat.id, bounds: { x: 1, y: 2, width: 300, height: 400 } });
    expect(l.host.calls.filter((c) => c[0] === 'open').length).toBe(opens + 1);
  });

  it('#368: a selection on the page goes to the UI as it is (the tab unchanged); the pill shows only over the tab on screen', async () => {
    const l = await withBrowser();
    const chat = await l.chat();
    await l.call('POST', `/browser/tabs/${chat.id}/open`, { url: 'https://example.com' });
    const before = l.engine.browser.get(chat.id);
    const sel = { text: 'Example Domain', rect: { x: 10, y: 20, w: 100, h: 18 }, selector: 'body > h1', code: false };
    l.host.emit({ type: 'selection', id: chat.id, sel });
    expect(l.events.at(-1)).toEqual({ type: 'browser.selection', chatId: chat.id, sel });
    l.host.emit({ type: 'quote', id: chat.id, via: 'key' });
    expect(l.events.at(-1)).toEqual({ type: 'browser.selection', chatId: chat.id, sel: null, quote: 'key' });
    expect(l.engine.browser.get(chat.id)).toEqual(before);
    const pill = { x: 400, y: 300, colors: { bg: '#222', border: '#333', text: '#eee', accent: '#4fb8d0', chip: '#2a2a2a', faint: '#888' }, font: 'Inter, sans-serif', mono: 'ui-monospace' };
    // Not on screen: hidden.
    expect((await l.call('PUT', `/browser/tabs/${chat.id}/pill`, { pill })).status).toBe(204);
    expect(l.host.pills.at(-1)).toEqual([chat.id, null]);
    await l.call('PUT', '/browser/view', { chatId: chat.id, bounds: { x: 1, y: 2, width: 300, height: 400 } });
    await l.call('PUT', `/browser/tabs/${chat.id}/pill`, { pill });
    expect(l.host.pills.at(-1)).toEqual([chat.id, pill]);
    await l.call('PUT', `/browser/tabs/${chat.id}/pill`, { pill: null });
    expect(l.host.pills.at(-1)).toEqual([chat.id, null]);
    // A jump back lights the passage; the page says whether it is still there.
    expect((await l.call('POST', `/browser/tabs/${chat.id}/flash`, { passage: 'Example Domain', selector: 'body > h1' })).body).toEqual({ found: true });
    expect((await l.call('POST', `/browser/tabs/${chat.id}/flash`, { passage: 'gone' })).body).toEqual({ found: false });
    expect(l.host.flashes).toEqual([[chat.id, 'Example Domain', 'body > h1'], [chat.id, 'gone', null]]);
  });

  it('input owner: the agent is refused while Master has it; hand back gives it the page; take control again', async () => {
    const l = await withBrowser();
    const chat = await l.chat();
    await l.call('POST', `/browser/tabs/${chat.id}/open`, { url: 'https://example.com' });
    await expect(l.engine.browser.cdp(chat.id, 'Page.reload', {}, 'agent')).rejects.toThrow('Master is using the browser');
    expect(() => l.engine.browser.open(chat.id, 'https://other.test', 'agent')).toThrow('Master is using the browser');
    const back = await l.call<BrowserTab>('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'agent' });
    expect(back.body.owner).toBe('agent');
    expect(l.host.owners.get(chat.id)).toBe('agent');
    expect(await l.engine.browser.cdp(chat.id, 'Accessibility.getFullAXTree', {}, 'agent')).toEqual({ ok: true });
    l.engine.browser.open(chat.id, 'https://other.test', 'agent');
    expect(l.engine.browser.get(chat.id)!.owner).toBe('agent');
    expect(l.engine.browser.takeHandBack(chat.id)).toBe(true);
    expect(l.engine.browser.takeHandBack(chat.id)).toBe(false);
    // Master's click in the view while the agent is acting: refused by the host, said to the UI (the strip).
    l.engine.browser.acted(chat.id, { verb: 'clicked', target: 'Go', point: null });
    l.host.emit({ type: 'input-blocked', id: chat.id });
    expect(l.events.at(-1)).toEqual({ type: 'browser.updated', tab: expect.objectContaining({ owner: 'agent' }), blocked: true });
    expect(l.host.owners.get(chat.id)).toBe('agent');
    // The agent has it but is not acting (its last action is old): Master's click takes control (#298 §3.1).
    vi.useFakeTimers({ now: Date.now() + DRIVING_MS + 1, toFake: ['Date'] });
    try {
      l.host.emit({ type: 'input-blocked', id: chat.id });
    } finally {
      vi.useRealTimers();
    }
    expect(l.host.owners.get(chat.id)).toBe('master');
    expect(l.engine.browser.get(chat.id)!.owner).toBe('master');
    await l.call('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'master' });
    expect(l.host.owners.get(chat.id)).toBe('master');
    expect((await l.call<{ error: string }>('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'nobody' })).status).toBe(400);
  });

  it('the pane places the view; back, forward, reload; closing the tab or deleting the chat removes it', async () => {
    const l = await withBrowser();
    const chat = await l.chat();
    expect((await l.call('PUT', '/browser/view', { chatId: chat.id, bounds: null })).status).toBe(404);
    await l.call('POST', `/browser/tabs/${chat.id}/open`, { url: 'https://example.com' });
    await l.call('PUT', '/browser/view', { chatId: chat.id, bounds: { x: 10, y: 20, width: 500, height: 600 } });
    expect(l.host.shown).toEqual({ id: chat.id, bounds: { x: 10, y: 20, width: 500, height: 600 } });
    await l.call('PUT', '/browser/view', { chatId: null });
    expect(l.host.shown.id).toBeNull();
    await l.call('POST', `/browser/tabs/${chat.id}/nav`, { action: 'back' });
    expect(l.host.calls.at(-1)).toEqual(['history', chat.id, 'back']);
    expect((await l.call('DELETE', `/browser/tabs/${chat.id}`)).status).toBe(204);
    expect(l.host.calls.at(-1)).toEqual(['close', chat.id]);
    expect((await l.call('GET', `/browser/tabs/${chat.id}`)).body).toBeNull();
    expect(l.events.at(-1)).toEqual({ type: 'browser.closed', chatId: chat.id });
    const task = l.engine.kanban.create({ title: 't', assignee: 'atlas', status: 'todo' }, 'user');
    l.engine.browser.open(task.id, 'https://example.com', 'master');
    l.engine.kanban.remove(task.id);
    expect(l.engine.browser.get(task.id)).toBeNull();
    expect(l.host.calls.at(-1)).toEqual(['close', task.id]);
  });

  it('restart (rule 2): the tab comes back with its last address and owner, in a new view, through the new proxy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-browser-'));
    try {
      const dbFile = join(dir, 'atlas.db');
      const first = await withBrowser({ dbFile, dataDir: dir });
      const chat = await first.chat();
      await first.call('POST', `/browser/tabs/${chat.id}/open`, { url: 'https://example.com/start' });
      first.host.emit({ type: 'navigated', id: chat.id, url: 'https://example.com/second' });
      await first.call('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'agent' });
      await first.engine.stop();

      const again = await withBrowser({ dbFile, dataDir: dir });
      expect(again.host.calls).toEqual([]); // nothing opens until the pane shows it
      const tab = (await again.call<BrowserTab>('GET', `/browser/tabs/${chat.id}`)).body;
      expect(tab).toMatchObject({ url: 'https://example.com/second', owner: 'agent' });
      await again.call('PUT', '/browser/view', { chatId: chat.id, bounds: { x: 0, y: 0, width: 400, height: 300 } });
      const t = again.host.tabs.get(chat.id)!;
      expect(t.url).toBe('https://example.com/second');
      expect(t.proxy!.server).toBe(`127.0.0.1:${again.engine.network.port}`);
      expect(again.host.owners.get(chat.id)).toBe('agent');
      expect(again.host.shown.id).toBe(chat.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the browser tab in the pane (#306)', () => {
  const browserTab = (tabs: PanelTab[]) => tabs.find((t): t is BrowserPaneTab => t.kind === 'browser');

  it('is a tab of the chat’s pane: opened from a link, made empty from « + », focused against artifacts; kept after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-306-'));
    try {
      const dbFile = join(dir, 'atlas.db');
      const l = await withBrowser({ dbFile, dataDir: dir });
      const chat = await l.chat();
      // « + › Open a page »: an empty tab, Master's, no driver.
      const empty = (await l.call<BrowserTab>('POST', `/browser/tabs/${chat.id}/create`)).body;
      expect(empty).toMatchObject({ url: null, owner: 'master', agentUsed: false, via: null, action: null, needs: null });
      let tabs = (await l.call<PanelTab[]>('GET', `/chats/${chat.id}/panel`)).body;
      expect(browserTab(tabs)).toMatchObject({ active: true, tab: { url: null } });
      // An artifact opened after it becomes the active tab; focusing the browser brings it back.
      const doc = l.engine.documents.create('atlas', { title: 'Spec', kind: 'markdown', content: '# a' }, 'atlas');
      tabs = (await l.call<PanelTab[]>('POST', `/chats/${chat.id}/panel/open`, { docId: doc.id })).body;
      expect(tabs.map((t) => [t.kind, t.active])).toEqual([['browser', false], ['artifact', true]]);
      await l.call('POST', `/browser/tabs/${chat.id}/focus`);
      tabs = (await l.call<PanelTab[]>('GET', `/chats/${chat.id}/panel`)).body;
      expect(tabs.map((t) => [t.kind, t.active])).toEqual([['browser', true], ['artifact', false]]);
      // A link: the same tab moves, says it came from a link; a pane update was sent.
      const n = l.events.length;
      const r = (await l.call<BrowserTab>('POST', `/browser/tabs/${chat.id}/open`, { url: 'https://github.com/csoylu/atlas/pull/107', via: 'link' })).body;
      expect(r).toMatchObject({ url: 'https://github.com/csoylu/atlas/pull/107', via: 'link', owner: 'master' });
      expect(l.events.slice(n)).toContainEqual(expect.objectContaining({ type: 'panel.updated', chatId: chat.id }));
      // Creating again only shows the existing tab.
      expect((await l.call<BrowserTab>('POST', `/browser/tabs/${chat.id}/create`)).body.url).toBe('https://github.com/csoylu/atlas/pull/107');
      await l.engine.stop();
      const again = await withBrowser({ dbFile, dataDir: dir });
      tabs = (await again.call<PanelTab[]>('GET', `/chats/${chat.id}/panel`)).body;
      expect(tabs.map((t) => [t.kind, t.active])).toEqual([['browser', true], ['artifact', false]]);
      // Closing the tab takes it out of the pane.
      await again.call('DELETE', `/browser/tabs/${chat.id}`);
      expect((await again.call<PanelTab[]>('GET', `/chats/${chat.id}/panel`)).body.map((t) => t.kind)).toEqual(['artifact']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the agent’s actions: a pulse and a caption over the page, the tab shows it drives; a typed value is never in it', async () => {
    const l = await withBrowser();
    const chat = await l.chat();
    l.engine.browser.open(chat.id, 'https://example.com', 'agent');
    expect(l.engine.browser.get(chat.id)).toMatchObject({ owner: 'agent', agentUsed: true, via: null });
    const t = l.engine.browser.acted(chat.id, { verb: 'clicked', target: 'Search', point: { x: 120, y: 40 } });
    expect(t.action).toMatchObject({ verb: 'clicked', target: 'Search', point: { x: 120, y: 40 } });
    expect(isDriving(t)).toBe(true);
    expect(isDriving(t, Date.now() + DRIVING_MS + 1)).toBe(false);
    expect(l.host.signals.at(-1)).toEqual([chat.id, { caption: 'atlas clicked « Search »', point: { x: 120, y: 40 } }]);
    l.engine.browser.acted(chat.id, { verb: 'typed in', target: 'Password', point: { x: 10, y: 80 } });
    expect(l.host.signals.at(-1)![1].caption).toBe('atlas typed in « Password »');
    expect(actionCaption('paris', { verb: 'opened', target: 'localhost:5173/tenders' })).toBe('paris opened localhost:5173/tenders');
    // Master takes control: no longer driving; the agent's next action is refused (« Master is using the browser »).
    const taken = (await l.call<BrowserTab>('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'master' })).body;
    expect(isDriving(taken)).toBe(false);
    expect(taken.agentUsed).toBe(true);
    // Handed back, the agent drives again only once it acts: Master's click in the idle tab takes control.
    const back = (await l.call<BrowserTab>('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'agent' })).body;
    expect(back.action).toBeNull();
    expect(isDriving(back)).toBe(false);
  });

  it('a login wall: the agent asks for Master, the pane says why; handing back clears it', async () => {
    const l = await withBrowser();
    const chat = await l.chat();
    l.engine.browser.open(chat.id, 'https://github.com/login', 'agent');
    expect(l.engine.browser.ask(chat.id, 'to sign in to github.com').needs).toBe('to sign in to github.com');
    await l.call('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'master' });
    expect(l.engine.browser.get(chat.id)!.needs).toBe('to sign in to github.com');
    const back = (await l.call<BrowserTab>('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'agent' })).body;
    expect(back.needs).toBeNull();
  });

  it('comment mode: a picture of the page and what is at a point, read as Master whoever drives', async () => {
    const l = await withBrowser();
    const chat = await l.chat();
    l.engine.browser.open(chat.id, 'https://example.com', 'agent');
    const shot = (await l.call<{ image: string }>('GET', `/browser/tabs/${chat.id}/shot`)).body;
    expect(shot.image).toMatch(/^data:image\/png;base64,/);
    // The fake host answers every CDP call { ok: true }: no value, so the page "could not be read".
    const r = await l.call<{ error: string }>('POST', `/browser/tabs/${chat.id}/inspect`, { x: 10, y: 10 });
    expect(r.status).toBe(500);
    expect(l.host.calls.at(-1)).toEqual(['send', chat.id, 'Runtime.evaluate', expect.objectContaining({ returnByValue: true })]);
    expect((await l.call('POST', `/browser/tabs/${chat.id}/inspect`, { x: 'a' })).status).toBe(400);
  });
});

describe('link routing (#298 §3.2)', () => {
  const app = 'http://127.0.0.1:4317';
  it('web pages open in the pane; ⌘-click, other schemes, downloads and sign-in pages stay external; Atlas routes stay in the app', () => {
    expect(linkTarget('https://github.com/csoylu/atlas/pull/107', { appOrigin: app })).toBe('pane');
    expect(linkTarget('http://localhost:5173/tenders', { appOrigin: app })).toBe('pane');
    expect(linkTarget('https://github.com/csoylu/atlas', { meta: true, appOrigin: app })).toBe('external');
    for (const u of ['mailto:x@y.z', 'file:///Users/x/a.txt', 'vscode://file/x', 'x-apple.systempreferences:com.apple.preference.security'])
      expect(linkTarget(u, { appOrigin: app }), u).toBe('external');
    expect(linkTarget('https://github.com/csoylu/atlas/releases/download/v1.2.0/Atlas-arm64.dmg', { appOrigin: app })).toBe('external');
    expect(linkTarget('https://example.com/file.zip', { appOrigin: app })).toBe('external');
    for (const u of ['https://auth.openai.com/oauth/authorize?x=1', 'https://claude.ai/oauth/authorize', 'https://accounts.google.com/o/oauth2', 'https://github.com/login/oauth/authorize'])
      expect(linkTarget(u, { appOrigin: app }), u).toBe('external');
    expect(linkTarget('https://claude.ai/new', { appOrigin: app })).toBe('pane');
    expect(linkTarget('#/library', { appOrigin: app })).toBe('app');
    expect(linkTarget(`${app}/#/chat/x`, { appOrigin: app })).toBe('app');
  });

  it('files Atlas serves open in the side panel (#339); ⌘-click keeps the default', () => {
    for (const p of ['images/atlas-x-avatar-800.png', 'pages/x.html', 'diagrams/a.svg', 'docs/spec.md', 'data/report.csv'])
      expect(linkTarget(`${app}/api/files/atlas/${p}`, { appOrigin: app }), p).toBe('file');
    expect(linkTarget('/api/files/atlas/images/a.png', { appOrigin: app })).toBe('file');
    expect(linkTarget(`${app}/api/files/atlas/images/a.png`, { meta: true, appOrigin: app })).toBe('app');
    // Not a served file: the app's own API, the folder itself, another origin's /api/files (a web page).
    expect(linkTarget(`${app}/api/cards`, { appOrigin: app })).toBe('app');
    expect(linkTarget(`${app}/api/files/atlas/`, { appOrigin: app })).toBe('app');
    expect(linkTarget('https://example.com/api/files/atlas/a.png', { appOrigin: app })).toBe('pane');
    expect(servedFile(`${app}/api/files/atlas%40p2/my%20pics/a%20b.png?v=2#x`, app)).toEqual({ root: 'atlas@p2', path: 'my pics/a b.png' });
    expect(servedFile(`${app}/api/files/atlas/a%2F..%2F..%2Fb.png`, app)).toBeNull();
    expect(servedFile(`${app}/api/files/atlas/%E0%A4%A.png`, app)).toBeNull();
    expect(servedFile('https://example.com/api/files/atlas/a.png', app)).toBeNull();
  });

  it('the Atlas window never leaves the app (#339): pages and files go to the system browser, other schemes are refused', () => {
    const url = 'http://127.0.0.1:4317';
    expect(appNavigation(`${url}/`, url)).toBe('stay');
    expect(appNavigation(`${url}/#/board`, url)).toBe('stay');
    expect(appNavigation(`${url}/api/files/atlas/images/a.png`, url)).toBe('external');
    expect(appNavigation('https://github.com/csoylu/atlas', url)).toBe('external');
    expect(appNavigation('http://localhost:5173/', url)).toBe('external');
    for (const u of ['file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,x', 'not a url']) expect(appNavigation(u, url), u).toBe('refuse');
    expect(appNavigation('http://localhost:5173/#/chat/x', 'http://localhost:5173')).toBe('stay');
  });

  it('typed addresses: https by default, http for local hosts', () => {
    expect(normalizeAddress('github.com')).toBe('https://github.com');
    expect(normalizeAddress(' localhost:5173/x ')).toBe('http://localhost:5173/x');
    expect(normalizeAddress('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeAddress('http://a.test')).toBe('http://a.test');
  });
});

describe('comments on a page of the chat’s browser (#306)', () => {
  it('names the address and the title; an area is cropped from the picture comment mode showed, not from the page now', async () => {
    const sharp = (await import('sharp')).default;
    const l = await withBrowser();
    const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#fff' } }).png().toBuffer();
    let captures = 0;
    l.host.capture = async () => {
      captures++;
      return { image: 'data:image/png;base64,' + png.toString('base64'), width: 400, height: 300 };
    };
    const chat = await l.chat();
    await l.call('POST', `/browser/tabs/${chat.id}/open`, { url: 'http://localhost:5173/tenders' });
    // Comment mode starts: the pane takes its picture.
    expect((await l.call('GET', `/browser/tabs/${chat.id}/shot`)).status).toBe(200);
    expect(captures).toBe(1);
    const target = { kind: 'browser', url: 'http://localhost:5173/tenders', title: 'Tenders' };
    const r = await l.call('POST', `/cards/${chat.id}/messages`, {
      comments: [
        { target, anchor: { type: 'area', box: { x: 10, y: 20, w: 100, h: 50 }, of: { w: 400, h: 300 }, unit: 'px', inside: [] }, text: 'This table.' },
        { target, anchor: { type: 'element', selector: 'button#go', text: 'Search', tag: 'button' }, text: 'Rename it.' },
      ],
    });
    expect(r.status).toBe(201);
    const last = l.engine.kanban.messages(chat.id).at(-1)!;
    const texts = last.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
    expect(texts.join('\n')).toContain('page http://localhost:5173/tenders');
    expect(texts.join('\n')).toContain('Tenders');
    expect(texts.join('\n')).toContain('button#go');
    const pics = last.content.filter((b) => b.type === 'image') as { width: number; height: number }[];
    expect(pics.map((p) => [p.width, p.height])).toEqual([[100, 50]]);
    // Cropped from the kept picture: no second capture.
    expect(captures).toBe(1);
  });
});

