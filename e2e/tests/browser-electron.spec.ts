import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { build } from 'esbuild';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * #298 S6: the shared browser in a real Electron (the desktop's ElectronBrowser + the engine in-process, as in the
 * app). A chat's tab opens in a WebContentsView of its workspace's profile, through the allow-list proxy; a restart
 * brings the same address back; agent A's profile holds no cookie of agent B; a host outside the allow-list is
 * refused in the pane; Master's input is blocked while the agent has the tab. The pane UI (#306) is not part of S6.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'e2e', 'electron', '.out');
const electronBin = createRequire(join(root, 'package.json'))('electron') as unknown as string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await build({
    entryPoints: [join(root, 'e2e', 'electron', 'browser-app.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: join(out, 'browser-app.mjs'),
    external: ['electron', 'better-sqlite3', 'sharp', 'sherpa-onnx-node', 'bufferutil', 'utf-8-validate'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning',
  });
  cpSync(join(root, 'packages', 'engine', 'src', 'store', 'migrations'), join(out, 'migrations'), { recursive: true });
});

/** A local site: sets a cookie, counts clicks on its button. Loopback goes direct (the agent's dev server). */
async function site(): Promise<{ url: string; close(): Promise<void> }> {
  const s = http.createServer((req, res) => {
    res.setHeader('set-cookie', `visit=${encodeURIComponent(req.url ?? '/')}; Path=/; Max-Age=3600`);
    res.setHeader('content-type', 'text/html');
    res.end(
      `<title>Site ${req.url}</title><button id=b style="position:fixed;left:0;top:0;width:400px;height:300px" onclick="this.dataset.n=(+this.dataset.n||0)+1;this.textContent=this.dataset.n" data-n=0>0</button><input id=i style="position:fixed;top:320px">`,
    );
  });
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', () => ok()));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => new Promise((ok) => s.close(() => ok())) };
}

async function launch(dataDir: string) {
  const app = await electron.launch({ executablePath: electronBin, args: [join(out, 'browser-app.mjs')], env: { ...process.env, ATLAS_E2E_DIR: dataDir } as Record<string, string> });
  await expect.poll(() => app.evaluate(() => !!(globalThis as { __atlas?: unknown }).__atlas), { timeout: 30_000 }).toBe(true);
  const url = await app.evaluate(() => (globalThis as unknown as { __atlas: { url: string } }).__atlas.url);
  const call = async <T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await fetch(url + '/api' + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    return { status: r.status, body: (t ? JSON.parse(t) : null) as T };
  };
  /** What a tab's view shows (address, page text), read in the Electron main process. */
  const view = (chatId: string) =>
    app.evaluate(async (_e, id) => {
      const tab = (globalThis as any).__atlas.host.tabs.get(id);
      if (!tab) return null;
      const wc = tab.view.webContents;
      return { url: wc.getURL() as string, visible: tab.view.getVisible() as boolean, text: wc.isLoading() ? null : ((await wc.executeJavaScript('document.body?.innerText ?? ""')) as string) };
    }, chatId);
  return { app, call, view };
}

type Tab = { chatId: string; url: string | null; title: string; owner: string; loading: boolean; error: string | null };

let dataDir: string;
let atlas: Awaited<ReturnType<typeof launch>>;
let web: Awaited<ReturnType<typeof site>>;
let app: ElectronApplication;

test.beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'atlas-e2e-browser-'));
  web = await site();
  atlas = await launch(dataDir);
  app = atlas.app;
});

test.afterEach(async () => {
  await app.close().catch(() => {});
  await web.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('a chat’s link opens in its view, shown in the pane’s place; a restart brings the same address back', async () => {
  const chat = (await atlas.call<{ id: string }>('POST', '/agents/atlas/chats')).body;
  const opened = await atlas.call<Tab>('POST', `/browser/tabs/${chat.id}/open`, { url: web.url + '/first' });
  expect(opened.status).toBe(200);
  await atlas.call('PUT', '/browser/view', { chatId: chat.id, bounds: { x: 600, y: 80, width: 600, height: 700 } });
  await expect.poll(async () => (await atlas.call<Tab>('GET', `/browser/tabs/${chat.id}`)).body).toMatchObject({ url: web.url + '/first', title: 'Site /first', loading: false, error: null });
  expect(await atlas.view(chat.id)).toMatchObject({ url: web.url + '/first', visible: true });
  // A link followed inside the page: the new address is stored.
  await app.evaluate((_e, [id, to]) => (globalThis as any).__atlas.host.tabs.get(id).view.webContents.loadURL(to), [chat.id, web.url + '/second'] as const);
  await expect.poll(async () => (await atlas.call<Tab>('GET', `/browser/tabs/${chat.id}`)).body.url).toBe(web.url + '/second');

  await app.close();
  atlas = await launch(dataDir);
  app = atlas.app;
  expect((await atlas.call<Tab>('GET', `/browser/tabs/${chat.id}`)).body).toMatchObject({ url: web.url + '/second' });
  await atlas.call('PUT', '/browser/view', { chatId: chat.id, bounds: { x: 600, y: 80, width: 600, height: 700 } });
  await expect.poll(async () => (await atlas.view(chat.id))?.url).toBe(web.url + '/second');
});

test('one profile per workspace: agent A’s partition holds no cookie of agent B', async () => {
  const models = (await atlas.call<{ id: string }[]>('GET', '/models')).body;
  expect((await atlas.call('POST', '/agents', { id: 'bob', modelId: models[0]!.id })).status).toBe(201);
  const a = (await atlas.call<{ id: string }>('POST', '/agents/atlas/chats')).body;
  const b = (await atlas.call<{ id: string }>('POST', '/agents/bob/chats')).body;
  await atlas.call('POST', `/browser/tabs/${a.id}/open`, { url: web.url + '/from-a' });
  await expect.poll(async () => (await atlas.call<Tab>('GET', `/browser/tabs/${a.id}`)).body.loading).toBe(false);
  const pid = (await atlas.call<{ id: string }[]>('GET', '/projects')).body[0]!.id;
  const cookies = (partition: string) => app.evaluate(async ({ session }, p) => (await session.fromPartition(p).cookies.get({})).map((c) => `${c.name}=${c.value}`), partition);
  expect(await cookies(`persist:ws-${pid}-atlas`)).toEqual(['visit=%2Ffrom-a']);
  expect(await cookies(`persist:ws-${pid}-bob`)).toEqual([]);
  await atlas.call('POST', `/browser/tabs/${b.id}/open`, { url: web.url + '/from-b' });
  await expect.poll(async () => (await atlas.call<Tab>('GET', `/browser/tabs/${b.id}`)).body.loading).toBe(false);
  expect(await cookies(`persist:ws-${pid}-bob`)).toEqual(['visit=%2Ffrom-b']);
  expect(await cookies(`persist:ws-${pid}-atlas`)).toEqual(['visit=%2Ffrom-a']);
  expect(await cookies('persist:master')).toEqual([]);
});

test('a host outside the workspace’s allow-list is refused in the pane, with the reason', async () => {
  const pid = (await atlas.call<{ id: string }[]>('GET', '/projects')).body[0]!.id;
  await atlas.call('PATCH', `/projects/${pid}`, { network: 'hosts', allowedHosts: ['github.com'] });
  const chat = (await atlas.call<{ id: string }>('POST', '/agents/atlas/chats')).body;
  await atlas.call('POST', `/browser/tabs/${chat.id}/open`, { url: 'https://example.com/' });
  await expect.poll(async () => (await atlas.call<Tab>('GET', `/browser/tabs/${chat.id}`)).body.error, { timeout: 20_000 }).toBe(
    "example.com is not in this workspace's allowed hosts (Settings → Workspaces)",
  );
  const refusals = (await atlas.call<{ host: string }[]>('GET', `/projects/${pid}/refusals`)).body;
  expect(refusals.map((r) => r.host)).toContain('example.com');
  // The agent's dev server (loopback) still opens.
  await atlas.call('POST', `/browser/tabs/${chat.id}/open`, { url: web.url + '/dev' });
  await expect.poll(async () => (await atlas.call<Tab>('GET', `/browser/tabs/${chat.id}`)).body).toMatchObject({ title: 'Site /dev', error: null });
});

test('Master’s input is blocked while the agent has the tab; the agent’s CDP input passes; take control gives it back', async () => {
  const chat = (await atlas.call<{ id: string }>('POST', '/agents/atlas/chats')).body;
  await atlas.call('POST', `/browser/tabs/${chat.id}/open`, { url: web.url + '/input' });
  await atlas.call('PUT', '/browser/view', { chatId: chat.id, bounds: { x: 600, y: 80, width: 600, height: 700 } });
  await expect.poll(async () => (await atlas.call<Tab>('GET', `/browser/tabs/${chat.id}`)).body.loading).toBe(false);
  /** Master's click: a real mouse press and release in the view (what the window would deliver). */
  const masterClick = () =>
    app.evaluate(async (_e, id) => {
      const wc = (globalThis as any).__atlas.host.tabs.get(id).view.webContents;
      wc.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: 100, y: 100, button: 'left', clickCount: 1 });
      await new Promise((ok) => setTimeout(ok, 300));
    }, chat.id);
  const count = async () => (await atlas.view(chat.id))?.text?.match(/^\d+/)?.[0];

  await masterClick();
  await expect.poll(count).toBe('1');

  await atlas.call('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'agent' });
  await masterClick();
  await masterClick();
  expect(await count()).toBe('1');
  const blocked = await app.evaluate(() => (globalThis as any).__atlas.events.filter((e: any) => e.type === 'browser.updated' && e.blocked).length);
  expect(blocked).toBeGreaterThanOrEqual(1);
  // The agent's click (CDP Input, S7's path) goes through.
  await app.evaluate(async (_e, id) => {
    const b = (globalThis as any).__atlas.engine.browser;
    for (const type of ['mousePressed', 'mouseReleased']) await b.cdp(id, 'Input.dispatchMouseEvent', { type, x: 100, y: 100, button: 'left', clickCount: 1 }, 'agent');
  }, chat.id);
  await expect.poll(count).toBe('2');

  // Take control: Master's clicks count again, the agent's calls are refused.
  await atlas.call('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'master' });
  await masterClick();
  await expect.poll(count).toBe('3');
  const refused = await app.evaluate(async (_e, id) => {
    try {
      await (globalThis as any).__atlas.engine.browser.cdp(id, 'Page.reload', {}, 'agent');
      return 'not refused';
    } catch (e) {
      return (e as Error).message;
    }
  }, chat.id);
  expect(refused).toBe('Master is using the browser');
});
