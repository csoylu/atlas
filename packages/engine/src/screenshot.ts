// screenshot (#133): a picture of the running Atlas UI (a route) or of a file served from a workspace (a mockup), taken
// with a fresh headless Google Chrome over CDP. Read-only like scripts/ui-check: every request other than GET, HEAD or
// OPTIONS is refused in the browser and listed in the result. The engine passes its own address, so no port lookup.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import WebSocket from 'ws';

/** What the engine gives the tool: its own address, a session cookie in server mode, and whose workspace this is. */
export interface EngineAccess {
  url: string;
  agentId: string;
  /** Value of the session cookie when the engine has a login (server mode); null without login. */
  cookie: () => string | null;
  /**
   * A read-only answer for a write the app makes only to look something up (POST /api/agents/x/main-chat: get or
   * create): the JSON to give the page, or undefined to refuse the request.
   */
  answer?: (method: string, path: string) => unknown;
}

export type Action = { click: string } | { type: string; text: string } | { press: string };

export interface ShotOptions {
  target: string;
  width: number;
  height: number;
  theme?: 'dark' | 'light';
  full_page: boolean;
  clip?: string;
  wait_for?: string;
  actions?: Action[];
}

/** Viewports under this width are phones: mobile metrics and touch (pointer: coarse), like ui-check. */
export const PHONE_BELOW = 500;
export const SCALE = 2;
/** Everything (Chrome start, load, waits, actions) must be done by then; the call fails rather than shoot half a page. */
export const TIMEOUT_MS = 15_000;
/** full_page: CSS pixels tall at most. */
export const FULL_PAGE_MAX = 6000;
/** Network quiet this long = the page has loaded what it needs. */
const QUIET_MS = 500;
/** After an action: shorter quiet (a menu, a dialog, a palette). */
const ACTION_QUIET_MS = 300;

/** The browser path: ATLAS_CHROME, else the usual install places. Throws a clear error when none is there (no fallback). */
export function findChrome(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (env.ATLAS_CHROME) {
    if (exists(env.ATLAS_CHROME)) return env.ATLAS_CHROME;
    throw new Error(`screenshot needs Google Chrome: ATLAS_CHROME is set to ${env.ATLAS_CHROME}, which does not exist`);
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = candidates.find(exists);
  if (found) return found;
  throw new Error(`screenshot needs Google Chrome, which was not found (looked in: ${candidates.join(', ')}). Install it, or set ATLAS_CHROME to its binary.`);
}

/**
 * Where the target lives, as a path + hash on the engine. Routes (`#/chat/paris`) are the app; `/api/files/<agent>/…`
 * a served workspace file; a relative path a file in the caller's workspace. Anything else (other sites) is refused.
 */
export function resolveTarget(target: string, o: { agentId: string; workdir: string; theme?: 'dark' | 'light' }): { path: string; kind: 'app' | 'file' } {
  const t = target.trim();
  if (!t) throw new Error('target is empty: give a route like #/board, or a workspace file like pages/x.html');
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//'))
    throw new Error(`${t}: only the Atlas UI (a route like #/chat/paris) and workspace files (pages/x.html or /api/files/<agent>/…) can be shot; use web_fetch for other pages`);
  const q = o.theme ? `?theme=${o.theme}` : '';
  if (t === '/' || t.startsWith('#') || t.startsWith('/#')) {
    const hash = t.replace(/^\//, '');
    return { path: `/${q}${hash === '' ? '' : hash.startsWith('#') ? hash : '#' + hash}`, kind: 'app' };
  }
  if (t.startsWith('/api/files/')) {
    const rest = t.slice('/api/files/'.length).split(/[?#]/)[0]!;
    if (!/^[^/]+\/./.test(rest) || rest.split('/').some((s) => s === '..'))
      throw new Error(`${t}: give a file inside a workspace, like /api/files/<agent>/pages/x.html`);
    return { path: t, kind: 'file' };
  }
  if (t.startsWith('/')) throw new Error(`${t}: not an Atlas route (start with #/) or a workspace file (relative path, or /api/files/<agent>/…)`);
  const [file, ...more] = t.split(/(?=[?#])/);
  const full = join(o.workdir, file!);
  const rel = relative(o.workdir, full);
  if (rel === '' || rel === '..' || rel.startsWith('..' + sep)) throw new Error(`${t} is outside your workspace`);
  if (!existsSync(full)) throw new Error(`${t} does not exist in your workspace`);
  return { path: `/api/files/${encodeURIComponent(o.agentId)}/${rel.split(sep).map(encodeURIComponent).join('/')}${more.join('')}`, kind: 'file' };
}

/**
 * Requests the page may make: reads only (the Atlas UI, mockups, their fonts). Writes are refused and listed. The one
 * POST let through is the engine's /api/auth/check: it only reads the session (the app shows nothing without it).
 */
export function allowedRequest(method: string, url: string, engineOrigin: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return true;
  try {
    const u = new URL(url);
    return method.toUpperCase() === 'POST' && u.origin === engineOrigin && u.pathname === '/api/auth/check';
  } catch {
    return false;
  }
}

/** The saved file's name: screenshots/<date>-<slug>-<width>-<theme>.png. */
export function shotName(target: string, width: number, theme: string | undefined, date: Date): string {
  const slug =
    target
      .replace(/^\/api\/files\/[^/]+\//, '')
      .replace(/\.(html?|svg)$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'home';
  const d = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${d}-${slug}-${width}-${theme ?? 'auto'}`;
}

const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};
const MODS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

/** "Meta+k", "Escape", "Shift+Tab" → a CDP key event. */
export function parseKey(spec: string): { key: string; code: string; keyCode: number; modifiers: number; text?: string } {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  const last = parts.pop();
  if (!last) throw new Error(`press: "${spec}" is not a key (e.g. "Enter", "Escape", "Meta+k")`);
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODS[m.toLowerCase()];
    if (!bit) throw new Error(`press: unknown modifier "${m}" in "${spec}" (Meta, Control, Alt, Shift)`);
    modifiers |= bit;
  }
  const named = KEYS[last.toLowerCase()];
  if (named) return { ...named, modifiers };
  if (last.length !== 1) throw new Error(`press: unknown key "${last}" (one character, or ${Object.values(KEYS).map((k) => k.code).join(', ')})`);
  const upper = last.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(last) ? `Digit${last}` : '';
  return { key: last, code, keyCode: upper.charCodeAt(0), modifiers, ...(modifiers & ~8 ? {} : { text: last }) };
}

/** Errors and refused writes seen while the page ran (returned next to the picture). */
interface Seen {
  errors: string[];
  refused: string[];
}

class Cdp {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private handlers = new Map<string, (p: any, sessionId?: string) => void>();
  constructor(private ws: WebSocket) {
    ws.on('message', (raw) => {
      const d = JSON.parse(String(raw)) as { id?: number; method?: string; params?: unknown; sessionId?: string; error?: { message: string }; result?: unknown };
      if (d.id && this.pending.has(d.id)) {
        const p = this.pending.get(d.id)!;
        this.pending.delete(d.id);
        if (d.error) p.reject(new Error(d.error.message));
        else p.resolve(d.result);
      } else if (d.method) this.handlers.get(d.method)?.(d.params, d.sessionId);
    });
    ws.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('Chrome closed the connection'));
      this.pending.clear();
    });
  }
  /** Events of the page and of its out-of-process frames (sessionId set: a frame attached with flatten). */
  on(method: string, h: (p: any, sessionId?: string) => void) {
    this.handlers.set(method, h);
  }
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, {
        resolve,
        reject: (e) => reject(new Error(`${method}: ${e.message}`)),
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value as T;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Browser {
  child?: ChildProcess;
  ws?: WebSocket;
  profile?: string;
}

/** Start Chrome into `b` as it goes, so the caller cleans up whatever was started even when a step fails. */
async function launch(b: Browser, chromePath: string, signal: AbortSignal, onSpawn?: (pid: number) => void): Promise<WebSocket> {
  const profile = (b.profile = await mkdtemp(join(tmpdir(), 'atlas-shot-chrome-')));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--disable-extensions', '--disable-background-networking', '--disable-sync', 'about:blank'];
  const child = (b.child = spawn(chromePath, args, { stdio: 'ignore', detached: process.platform !== 'win32' }));
  if (child.pid) onSpawn?.(child.pid);
  let failed: Error | null = null;
  child.on('error', (e) => (failed = new Error(`Chrome did not start (${chromePath}): ${e.message}`)));
  child.on('exit', (code) => (failed ??= new Error(`Chrome exited at start (code ${code})`)));
  // Chrome writes its chosen port to DevToolsActivePort in the profile.
  const portFile = join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    if (failed) throw failed;
    signal.throwIfAborted();
    port = Number((await readFile(portFile, 'utf8').catch(() => '')).split('\n')[0]) || 0;
    if (!port) await sleep(50);
  }
  if (!port) throw new Error('Chrome started but opened no debugging port within 5 s');
  let page: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 50 && !page; i++) {
    const list = (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json(), () => [])) as { type: string; webSocketDebuggerUrl: string }[];
    page = list.find((t) => t.type === 'page');
    if (!page) await sleep(50);
  }
  if (!page) throw new Error('Chrome opened no page');
  const ws = (b.ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 }));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return ws;
}

function kill(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

export interface ShotResult {
  /** Path relative to the workdir. */
  file: string;
  bytes: Buffer;
  url: string;
  viewport: string;
  mode: 'phone' | 'desktop';
  errors: string[];
  refused: string[];
}

/** Take the picture. `deadline` failures say what was still missing. */
export async function takeScreenshot(
  o: ShotOptions,
  ctx: { engine: EngineAccess; workdir: string; signal: AbortSignal; onSpawn?: (pid: number) => void; chromePath?: string; now?: Date },
): Promise<ShotResult> {
  const chromePath = ctx.chromePath ?? findChrome();
  const target = resolveTarget(o.target, { agentId: ctx.engine.agentId, workdir: ctx.workdir, theme: o.theme });
  const base = new URL(ctx.engine.url);
  const url = base.origin + target.path;
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new Error('timeout')), TIMEOUT_MS);
  const signal = AbortSignal.any([ctx.signal, timeout.signal]);
  const seen: Seen = { errors: [], refused: [] };
  let waiting = 'Chrome to start';
  const chrome: Browser = {};
  let pendingNow = (): string[] => [];
  try {
    const run = async (): Promise<ShotResult> => {
      const cdp = new Cdp(await launch(chrome, chromePath, signal, ctx.onSpawn));
      const phone = o.width < PHONE_BELOW;

      // Requests: count the in-flight ones (network quiet) and refuse every write. Out-of-process frames (sandboxed
      // mockups in the chat, iframes of other sites) are attached as their own sessions, with the same rules.
      const inflight = new Map<string, string>();
      const key = (sessionId: string | undefined, requestId: string) => `${sessionId ?? ''}:${requestId}`;
      let lastActivity = Date.now();
      const touch = () => (lastActivity = Date.now());
      let mainFrame = '';
      cdp.on('Network.requestWillBeSent', (p, sid) => (inflight.set(key(sid, p.requestId), `${p.request.method} ${String(p.request.url).replace(base.origin, '')}`), touch()));
      pendingNow = () => (loaded ? [...new Set(inflight.values())] : ['(the page load event)', ...new Set(inflight.values())]);
      const done = (p: { requestId: string }, sid?: string) => (inflight.delete(key(sid, p.requestId)), touch());
      cdp.on('Network.loadingFinished', done);
      // A frame's document loaded in another process finishes there: its response is the end of it here.
      cdp.on('Network.responseReceived', (p, sid) => {
        if (p.type === 'Document' && p.frameId !== mainFrame) done(p, sid);
      });
      cdp.on('Network.loadingFailed', (p, sid) => {
        done(p, sid);
        if (!String(p.errorText).startsWith('net::ERR_BLOCKED_BY_CLIENT') && !p.canceled && p.type !== 'EventSource' && p.type !== 'WebSocket') seen.errors.push(`request failed: ${p.errorText}`);
      });
      cdp.on('Fetch.requestPaused', ({ requestId, request }: { requestId: string; request: { method: string; url: string } }, sid) => {
        if (allowedRequest(request.method, request.url, base.origin)) return void cdp.send('Fetch.continueRequest', { requestId }, sid).catch(() => {});
        let where = request.url;
        try {
          const u = new URL(request.url);
          where = u.origin === base.origin ? u.pathname : u.origin + u.pathname;
        } catch {
          // keep the raw url
        }
        const known = where.startsWith('/') ? ctx.engine.answer?.(request.method, where) : undefined;
        if (known !== undefined)
          return void cdp
            .send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(known)).toString('base64') }, sid)
            .catch(() => {});
        seen.refused.push(`${request.method} ${where}`);
        void cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sid).catch(() => {});
      });
      cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => seen.errors.push('page error: ' + String(d.exception?.description ?? d.text).split('\n')[0]));
      cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
        if (type === 'error') seen.errors.push('console.error: ' + (args as { value?: unknown; description?: string }[]).map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? ''))).join(' ').slice(0, 300));
      });
      const watch = async (sid?: string) => {
        await cdp.send('Runtime.enable', {}, sid);
        await cdp.send('Network.enable', {}, sid);
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid);
        if (sid && o.theme) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.theme }] }, sid);
        await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid);
      };
      cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }: { sessionId: string; targetInfo: { type: string } }) => {
        const go = () => cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
        if (targetInfo.type !== 'iframe' && targetInfo.type !== 'worker') return void go();
        void watch(sessionId).catch(() => {}).finally(go);
      });
      let loaded = false;
      cdp.on('Page.loadEventFired', () => (loaded = true));

      await cdp.send('Page.enable');
      mainFrame = (await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')).frameTree.frame.id;
      await watch();
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: SCALE, mobile: phone });
      if (phone) await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      if (o.theme) await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.theme }] });
      const cookie = ctx.engine.cookie();
      if (cookie) await cdp.send('Network.setCookie', { name: 'atlas_session', value: cookie, url: base.origin, httpOnly: true, sameSite: 'Strict' });

      waiting = `${url} to load`;
      const nav = await cdp.send<{ errorText?: string }>('Page.navigate', { url });
      if (nav.errorText) throw new Error(`could not open ${url}: ${nav.errorText}`);
      const status = await cdp.evaluate<number>('performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0').catch(() => 0);
      const settle = async (quiet: number) => {
        while (!(loaded && inflight.size === 0 && Date.now() - lastActivity >= quiet)) {
          signal.throwIfAborted();
          await sleep(50);
        }
        await cdp.evaluate('document.fonts.ready.then(() => true)');
      };
      await settle(QUIET_MS);
      if (status >= 400) {
        const body = await cdp.evaluate<string>('document.body?.innerText?.slice(0, 300) ?? ""').catch(() => '');
        throw new Error(`${url} answered ${status}${body ? `: ${body}` : ''}`);
      }

      /** The element's box in page coordinates once it is there and visible; waits until the deadline. */
      const box = async (sel: string, why: string) => {
        waiting = `${why} ${JSON.stringify(sel)} to appear`;
        const expr = `(() => { let el; try { el = document.querySelector(${JSON.stringify(sel)}); } catch (e) { return { bad: String(e.message) }; }
          if (!el) return null; const r = el.getBoundingClientRect(); if (!r.width || !r.height) return null;
          return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, vx: r.left, vy: r.top }; })()`;
        for (;;) {
          const b = await cdp.evaluate<{ bad?: string; x: number; y: number; w: number; h: number; vx: number; vy: number } | null>(expr);
          if (b?.bad) throw new Error(`${JSON.stringify(sel)} is not a valid CSS selector: ${b.bad}`);
          if (b) return b;
          signal.throwIfAborted();
          await sleep(100);
        }
      };
      const clickAt = async (sel: string, why: string) => {
        await cdp.evaluate(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center', inline: 'center' })`).catch(() => {});
        const b = await box(sel, why);
        const x = b.vx + b.w / 2;
        const y = b.vy + b.h / 2;
        if (phone) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } else {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        }
      };
      for (const [i, a] of (o.actions ?? []).entries()) {
        const n = `action ${i + 1}`;
        if ('click' in a) await clickAt(a.click, `${n} (click):`);
        else if ('type' in a) {
          await clickAt(a.type, `${n} (type):`);
          await cdp.evaluate(`document.querySelector(${JSON.stringify(a.type)})?.focus()`);
          await cdp.send('Input.insertText', { text: a.text });
        } else {
          const k = parseKey(a.press);
          const ev = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: k.modifiers };
          await cdp.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...ev, ...(k.text ? { text: k.text } : {}) });
          await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
        }
        waiting = `the page to settle after ${n}`;
        await sleep(50);
        await settle(ACTION_QUIET_MS);
      }
      if (o.wait_for) await box(o.wait_for, 'wait_for:');
      // Let the last frame paint (transitions started by the wait or an action).
      await cdp.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');

      let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
      if (o.clip) {
        await cdp.evaluate(`document.querySelector(${JSON.stringify(o.clip)})?.scrollIntoView({ block: 'nearest' })`).catch(() => {});
        const b = await box(o.clip, 'clip:');
        clip = { x: b.x, y: b.y, width: Math.max(1, b.w), height: Math.max(1, Math.min(b.h, FULL_PAGE_MAX)), scale: 1 };
      } else if (o.full_page) {
        const m = await cdp.send<{ cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics');
        clip = { x: 0, y: 0, width: o.width, height: Math.min(Math.max(o.height, Math.ceil(m.cssContentSize.height)), FULL_PAGE_MAX), scale: 1 };
      }
      waiting = 'Chrome to take the picture';
      const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
      const finalUrl = await cdp.evaluate<string>('location.href');
      const bytes = Buffer.from(shot.data, 'base64');
      await mkdir(join(ctx.workdir, 'screenshots'), { recursive: true });
      const stem = join('screenshots', shotName(o.target, o.width, o.theme, ctx.now ?? new Date()));
      let file = `${stem}.png`;
      for (let i = 2; await stat(join(ctx.workdir, file)).then(() => true, () => false); i++) file = `${stem}-${i}.png`;
      await writeFile(join(ctx.workdir, file), bytes);
      return {
        file,
        bytes,
        url: finalUrl.replace(base.origin, ''),
        viewport: clip ? `${Math.round(clip.width)}×${Math.round(clip.height)} CSS px (of a ${o.width}×${o.height} viewport)` : `${o.width}×${o.height} CSS px`,
        mode: phone ? 'phone' : 'desktop',
        errors: [...new Set(seen.errors)],
        refused: [...new Set(seen.refused)],
      };
    };
    return await run();
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    if (timeout.signal.aborted) {
      const pend = waiting.endsWith('to load') || waiting.startsWith('the page to settle') ? pendingNow() : [];
      const still = pend.length ? `\nStill loading: ${pend.slice(0, 8).join(', ')}` : '';
      const extra = still + (seen.errors.length ? `\nPage errors so far:\n  ${[...new Set(seen.errors)].join('\n  ')}` : '');
      throw new Error(`screenshot timed out after ${TIMEOUT_MS / 1000} s waiting for ${waiting}; no picture taken${extra}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    chrome.ws?.terminate();
    if (chrome.child) kill(chrome.child);
    if (chrome.profile) await rm(chrome.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

/** The read-only answers the engine gives the page for lookups the app makes with a POST (see EngineAccess.answer). */
export function screenshotAnswer(kanban: { existingMainChat(agentId: string): unknown }, method: string, path: string): unknown {
  const m = method === 'POST' ? /^\/api\/agents\/([^/]+)\/main-chat$/.exec(path) : null;
  if (!m) return undefined;
  try {
    return kanban.existingMainChat(decodeURIComponent(m[1]!)) ?? undefined;
  } catch {
    return undefined;
  }
}
