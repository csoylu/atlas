// The .landed animation (#104/#112): a finished-task report plays it only when it arrives live (WebSocket
// message.appended), never when the history loads or the page is reloaded, and never with prefers-reduced-motion.
// Since #405 it is the shared x-in (the report row has no status chip since #271: its icon says Done).
//
//   node scripts/ui-check/landed.mjs [--ui packages/ui/dist] [--port N]
//
// Runs in an agent's sandbox like ui-check (#314): headless Chromium and a throwaway seeded engine (--port N: yours).
//
// Read-only: the "live" message is a synthetic WebSocket event dispatched inside the page; nothing is written to the
// engine (writes are refused). Exit code 1 on any failure.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { join, extname, resolve } from 'node:path';
import { findBrowser, browserArgs, startThrowawayEngine } from './tooling.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UI = resolve(arg('ui', 'packages/ui/dist'));

const BASE = arg('port') ? `http://127.0.0.1:${arg('port')}` : (await startThrowawayEngine({ ui: UI })).base;
if (!(await fetch(BASE + '/api/health').then((r) => r.ok, () => false))) throw new Error(`No Atlas engine answers on ${BASE}`);
const target = new URL(BASE);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path.startsWith('/api/')) {
    const up = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', (e) => res.destroy(e));
    return void req.pipe(up);
  }
  let file = join(UI, decodeURIComponent(path));
  if (path === '/' || !existsSync(file) || !statSync(file).isFile()) file = join(UI, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
server.on('upgrade', (req, socket, head) => {
  const up = netConnect(+target.port, target.hostname, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n` + Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n');
    up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${server.address().port}`;
const get = (p) => fetch(BASE + '/api' + p).then((r) => r.json());

const chats = await get('/chats');
const chat = chats[0];
if (!chat) throw new Error('no chat to test');

const CDP = 9400 + Math.floor(Math.random() * 50);
const profile = mkdtempSync(join(tmpdir(), 'atlas-landed-'));
const BROWSER = findBrowser();
const chrome = spawn(BROWSER, browserArgs(BROWSER, { port: CDP, profile }), { stdio: 'ignore' });
const done = (code) => { chrome.kill(); rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); process.exit(code); };
let targets = [];
for (let i = 0; i < 50 && !targets.some((t) => t.type === 'page'); i++) { await sleep(200); targets = await fetch(`http://127.0.0.1:${CDP}/json`).then((r) => r.json(), () => []); }
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let seq = 0; const pending = new Map(); const handlers = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method) handlers.get(d.method)?.(d.params); };
const send = (method, params = {}) => new Promise((r, j) => { const i = ++seq; pending.set(i, (d) => (d.error ? j(new Error(method + ': ' + d.error.message)) : r(d.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };

// Read-only: refuse writes; keep a handle on every app WebSocket so the test can feed it a "live" event.
handlers.set('Fetch.requestPaused', async ({ requestId, request }) => {
  const u = new URL(request.url);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && u.pathname !== '/api/auth/check') return send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  send('Fetch.continueRequest', { requestId });
});
await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] });
await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__ws = []; const W = window.WebSocket; window.WebSocket = function (...a) { const s = new W(...a); window.__ws.push(s); return s; }; window.WebSocket.prototype = W.prototype; Object.assign(window.WebSocket, W);` });
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const REPORT = (n) => ({ id: `m_landed${n}${Date.now()}`, conversationId: chat.conversationId, seq: 2e6 + n, role: 'user', author: 'system', content: [{ type: 'text', text: `Task “Landed check ${n}” (#9${n}) finished: all good.` }], at: new Date().toISOString() });
const fails = [];
const check = (ok, what) => { console.log((ok ? '✓ ' : '✗ ') + what); if (!ok) fails.push(what); };

async function open(reduced) {
  await send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(100);
  await send('Page.navigate', { url: `${PAGE}/?theme=dark#/chat/${chat.id}` });
  for (let i = 0; i < 100 && !(await evaluate(`!!document.querySelector('.chat .msg') && __ws.some((s) => s.readyState === 1)`).catch(() => false)); i++) await sleep(150);
  await sleep(600);
}
// The report is fed through the app's own WebSocket handler (a MessageEvent on the socket), so it takes the live path.
const feed = (m) => evaluate(`(() => { const s = __ws.find((x) => x.readyState === 1); s.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'message.appended', message: ${JSON.stringify(m)} }) })); return true; })()`);
const state = (id) => evaluate(`(() => { const rows = [...document.querySelectorAll('.chat-row.card-report')]; const r = rows.find((x) => x.textContent.includes(${JSON.stringify(id)})); if (!r) return null; return { landed: r.classList.contains('landed'), row: getComputedStyle(r).animationName, done: r.classList.contains('done') && !!r.querySelector('.chat-row-icon svg') }; })()`);
const history = () => evaluate(`[...document.querySelectorAll('.chat-row.card-report')].map((r) => ({ landed: r.classList.contains('landed'), row: getComputedStyle(r).animationName }))`);

// 1. A live report: .landed, its x-in running (#405), drawn as Done.
await open(false);
const before = await history();
check(before.every((h) => !h.landed && h.row === 'none'), `history load: ${before.length} report(s), none animated`);
const m1 = REPORT(1);
await feed(m1);
await sleep(100);
const s1 = await state('#91');
check(!!s1, 'live report is shown');
check(s1?.landed === true && s1.row === 'x-in', `live report animates (${JSON.stringify(s1)})`);
check(s1?.done === true, 'live report is drawn as Done (its status icon)');
await sleep(700);
const s1b = await state('#91');
check(s1b?.row === 'x-in' || s1b?.row === 'none', 'animation is a one-shot (no loop): ' + JSON.stringify(s1b));
const iter = await evaluate(`getComputedStyle(document.querySelector('.chat-row.card-report.landed')).animationIterationCount`);
check(iter === '1', 'animation-iteration-count is 1 (' + iter + ')');

// 1b. It does not replay when later messages arrive (the row must not remount): count animationstart on the report.
await evaluate(`window.__starts = 0; document.addEventListener('animationstart', (e) => { if (e.animationName === 'x-in' && e.target.classList?.contains('card-report')) window.__starts++; }, true);`);
await feed({ id: 'm_landed_a' + Date.now(), conversationId: chat.conversationId, seq: 2e6 + 50, role: 'assistant', author: chat.assignee ?? 'atlas', content: [{ type: 'text', text: 'Next message.' }], at: new Date().toISOString() });
await feed(REPORT(3));
await sleep(600);
const starts = await evaluate('window.__starts');
check(starts === 1, `later messages do not replay the first report's animation (only the new report animates: ${starts} start)`);

// 2. Reload: nothing animates (the report from step 1 was never stored, so it is gone; every stored report is history).
await open(false);
const after = await history();
check(after.every((h) => !h.landed && h.row === 'none'), `reload: ${after.length} report(s), none animated`);

// 3. Reduced motion: still marked live, but no animation.
await open(true);
await feed(REPORT(2));
await sleep(100);
const s2 = await state('#92');
check(!!s2 && s2.row === 'none', `prefers-reduced-motion: no animation (${JSON.stringify(s2)})`);
done(fails.length ? 1 : 0);
