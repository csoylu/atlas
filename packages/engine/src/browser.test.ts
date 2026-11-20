import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkTarget, MASTER_PANE, normalizeAddress, type BrowserStatus, type BrowserTab, type ServerEvent } from '@atlas/shared';
import { launch } from '../test/kit/index.ts';
import type { BrowserHost, HostEvent, HostTab } from './browser.ts';

/** #298 S6: the browser engine against a fake BrowserHost (the Electron views are covered by e2e/tests/browser.spec.ts). */

class FakeHost implements BrowserHost {
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
    // Master's click in the view while the agent has it: refused by the host, said to the UI.
    l.host.emit({ type: 'input-blocked', id: chat.id });
    expect(l.events.at(-1)).toEqual({ type: 'browser.updated', tab: expect.objectContaining({ owner: 'agent' }), blocked: true });
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
    expect(linkTarget(`${app}/api/files/munih/pages/x.html`, { appOrigin: app })).toBe('app');
  });

  it('typed addresses: https by default, http for local hosts', () => {
    expect(normalizeAddress('github.com')).toBe('https://github.com');
    expect(normalizeAddress(' localhost:5173/x ')).toBe('http://localhost:5173/x');
    expect(normalizeAddress('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(normalizeAddress('http://a.test')).toBe('http://a.test');
  });
});
