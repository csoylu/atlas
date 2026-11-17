// Electron main for the orb check (built and launched by check.mjs). Drives the REAL overlay (apps/desktop/src/orb)
// through every state and measures it. Input: env ORB_CHECK_OUT (output dir, holds reply.json from tts.ts) and
// ORB_CHECK_ORB (dist/orb). The microphone is Chromium's fake capture device playing a speech recording
// (--use-file-for-fake-audio-capture), so « listening » reacts to a real getUserMedia level, reproducibly.
import { app, globalShortcut, screen, type BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { OrbOverlay, type OrbStore } from '../../apps/desktop/src/orb/overlay.ts';
import { frameStats, type OrbPlace } from '../../apps/desktop/src/orb/model.ts';

const out = process.env.ORB_CHECK_OUT!;
const dir = process.env.ORB_CHECK_ORB!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const report: Record<string, any> = {};
const errors: string[] = [];
const events: string[] = [];
let step = 'start';
const front = () => { try { return execFileSync('lsappinfo', ['info', '-only', 'name', '`lsappinfo front`'], { shell: true }).toString().trim(); } catch (e) { return String(e); } };

/** Stand-in for the engine's Settings (SQLite needs better-sqlite3 built for Electron; persistence has its own test). */
class FileStore implements OrbStore {
  constructor(private file: string) {}
  orbPosition(): OrbPlace | null {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as OrbPlace;
    } catch {
      return null;
    }
  }
  setOrbPosition(p: OrbPlace) {
    writeFileSync(this.file, JSON.stringify(p));
  }
}

async function cpu(seconds: number) {
  app.getAppMetrics(); // starts the measuring window (CPU % is since the previous call)
  await sleep(seconds * 1000);
  const by: Record<string, number> = {};
  for (const m of app.getAppMetrics()) {
    const key = m.type === 'Tab' ? 'renderer (orb page)' : m.type === 'Browser' ? 'main' : m.type === 'GPU' ? 'gpu' : m.serviceName || m.type;
    by[key] = Math.round(((by[key] ?? 0) + m.cpu.percentCPUUsage) * 10) / 10;
  }
  return { total: Math.round(Object.values(by).reduce((a, b) => a + b, 0) * 10) / 10, ...by };
}

const js = <T>(win: BrowserWindow, code: string) => win.webContents.executeJavaScript(code) as Promise<T>;
const orbPos = (win: BrowserWindow) =>
  js<string>(win, "document.getElementById('c').style.transform").then((t) => {
    const [x, y] = [...t.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]) + 410);
    return { x: x!, y: y! };
  });

const shotAt: number[] = [];
async function shot(o: OrbOverlay, name: string) {
  shotAt.push(await js<number>(o.win, 'performance.now()'));
  const p = await orbPos(o.win);
  const b = o.win.getBounds();
  const rect = { x: Math.max(0, Math.round(p.x - 560)), y: Math.max(0, Math.round(p.y - 300)), width: 0, height: 0 };
  rect.width = Math.min(b.width - rect.x, 720);
  rect.height = Math.min(b.height - rect.y, 460);
  const img = await o.win.webContents.capturePage(rect);
  writeFileSync(join(out, `${name}.png`), img.toPNG());
}

async function frames(o: OrbOverlay) {
  const s = await js<{ intervals: number[]; draw: number[]; at: number[] }>(o.win, 'window.__orbStats()');
  const long = s.intervals.map((d, i) => ({ ms: Math.round(d), at: Math.round(s.at[i]! - s.at[0]!) })).filter((f, i) => i > 0 && f.ms > 33.4);
  return { interval: frameStats(s.intervals.slice(1)), draw: frameStats(s.draw), longFrames: long, shots: shotAt.splice(0).map((t) => Math.round(t - s.at[0]!)) };
}

async function run() {
  const store = new FileStore(join(out, 'store.json'));
  let dismissed = 0;
  let frames16k = 0;
  let audioSamples = 0;
  let o = await OrbOverlay.create({
    store,
    dir,
    onDismiss: () => (dismissed++, events.push(`dismiss at ${step}`)),
    onError: (e) => errors.push(e),
    onAudio: (s) => (frames16k++, (audioSamples += s.length)),
  });
  const ignore: boolean[] = [];
  const spy = (win: BrowserWindow) => {
    const real = win.setIgnoreMouseEvents.bind(win);
    win.setIgnoreMouseEvents = (v, opts) => (ignore.push(v), real(v, opts));
  };
  spy(o.win);
  o.win.on('blur', () => events.push(`blur at ${step} +${Math.round(performance.now())}ms front=${front()}`));
  report.display = { hz: screen.getPrimaryDisplay().displayFrequency, scale: screen.getPrimaryDisplay().scaleFactor, bounds: o.win.getBounds() };
  report.window = { alwaysOnTop: o.win.isAlwaysOnTop(), allSpaces: o.win.isVisibleOnAllWorkspaces(), focusable: o.win.isFocusable() };

  // ── idle ──
  o.show();
  await sleep(2000);
  report.idleLoopStopped = !(await js<{ running: boolean }>(o.win, 'window.__orbStats()')).running;
  // the ember breathes in place: its centre must not move over a few beats (it once swung towards the top-left)
  const centres: { x: number; y: number }[] = [];
  for (let i = 0; i < 20; i++) {
    centres.push(await js(o.win, "(() => { const r = document.getElementById('ember').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()"));
    await sleep(150);
  }
  const spread = (k: 'x' | 'y') => Math.max(...centres.map((c) => c[k])) - Math.min(...centres.map((c) => c[k]));
  report.emberStill = { first: centres[0], dx: spread('x'), dy: spread('y'), ok: spread('x') < 0.5 && spread('y') < 0.5 };
  const a0 = audioSamples;
  const t0 = performance.now();
  report.cpuIdleShown = await cpu(10);
  // the voice loop's ear: the microphone streams to the main process at rest too (wake word), at 16 kHz
  report.micAtRest = { frames: frames16k, samplesPerSecond: Math.round(((audioSamples - a0) * 1000) / (performance.now() - t0)) };
  report.micAtRest.ok = report.micAtRest.samplesPerSecond > 15_000 && report.micAtRest.samplesPerSecond < 17_000;
  await shot(o, '1-idle');

  // ── wake ──
  events.push(`front before wake: ${front()}`);
  step = 'wake';
  o.setState('wake');
  await sleep(50);
  events.push(`after wake: focused=${o.win.isFocused()} front=${front()}`);
  report.wakeNoFocus = { ok: !o.win.isFocused(), focused: o.win.isFocused() };
  report.globalEscAwake = { ok: globalShortcut.isRegistered('Escape') };
  await sleep(380);
  await shot(o, '2-wake');
  await sleep(900);

  // ── listening (fake mic device = speech recording through getUserMedia) ──
  step = 'listening';
  o.setState('listening');
  await js(o.win, 'window.__orbStatsReset()');
  const said = 'what’s on the board today?';
  for (let i = 1; i <= said.length; i++) {
    o.transcript(said.slice(0, i));
    await sleep(70);
  }
  await sleep(600);
  await shot(o, '3-listening');
  report.cpuListening = await cpu(6);
  report.framesListening = await frames(o);

  // ── thinking ──
  step = 'thinking';
  o.setState('thinking');
  await sleep(1300);
  await shot(o, '4-thinking');

  // ── speaking (real Kokoro audio) ──
  const reply = JSON.parse(readFileSync(join(out, 'reply.json'), 'utf8')) as { text: string; file: string; sampleRate: number }[];
  step = 'speaking';
  o.setState('speaking');
  await js(o.win, 'window.__orbStatsReset()');
  const played = reply.map((s) => {
    const b = readFileSync(s.file);
    return o.speak(s.text, new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4), s.sampleRate);
  });
  const cpuSpeaking = cpu(5);
  await sleep(2600);
  await shot(o, '5-speaking');
  report.cpuSpeaking = await cpuSpeaking;
  report.spoken = await Promise.all(played);
  report.framesSpeaking = await frames(o);
  await sleep(300);
  await shot(o, '6-speaking-end');

  // ── barge-in: hush cuts the reply, the orb stays awake ──
  step = 'barge-in';
  o.setState('speaking');
  const b0 = readFileSync(reply[2]!.file);
  const cut = o.speak(reply[2]!.text, new Float32Array(b0.buffer, b0.byteOffset, b0.byteLength / 4), reply[2]!.sampleRate);
  await sleep(400);
  o.hush();
  o.setState('listening');
  report.hush = { played: await cut, state: o.current };
  report.hush.ok = report.hush.played === false && o.current === 'listening';
  o.error('the agent did not start answering');
  await sleep(500);
  await shot(o, '7-error');

  // ── Esc dismisses ──
  step = 'esc';
  dismissed = 0;
  const focusedBefore = o.win.isFocused();
  o.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(300);
  report.escDismisses = { ok: o.current === 'idle' && dismissed === 1, state: o.current, dismissed, focusedBefore };
  report.globalEscAtRest = { ok: !globalShortcut.isRegistered('Escape') };

  // ── focus loss does not end the conversation (Master clicks another app) ──
  step = 'blur';
  dismissed = 0;
  o.setState('speaking');
  const b1 = readFileSync(reply[0]!.file);
  const kept = o.speak(reply[0]!.text, new Float32Array(b1.buffer, b1.byteOffset, b1.byteLength / 4), reply[0]!.sampleRate);
  o.win.focus();
  await sleep(100);
  o.win.blur();
  o.win.emit('blur'); // the real event may not fire when the window was never key
  await sleep(300);
  report.blurKeeps = { ok: o.current === 'speaking' && dismissed === 0, state: o.current, dismissed };
  o.hush();

  // ── a click (no drag) on the awake orb ends the conversation ──
  step = 'orb-click';
  const pc = await orbPos(o.win);
  o.setState('listening');
  await sleep(200);
  o.win.webContents.sendInputEvent({ type: 'mouseMove', x: pc.x, y: pc.y });
  await sleep(50);
  o.win.webContents.sendInputEvent({ type: 'mouseDown', x: pc.x, y: pc.y, button: 'left', clickCount: 1 });
  await sleep(60);
  o.win.webContents.sendInputEvent({ type: 'mouseUp', x: pc.x + 1, y: pc.y, button: 'left', clickCount: 1 });
  await sleep(300);
  report.orbClickDismisses = { ok: o.current === 'idle' && dismissed === 1 && (await kept) === false, state: o.current, dismissed, posUnchanged: JSON.stringify(await orbPos(o.win)) === JSON.stringify(pc) };
  report.orbClickDismisses.ok &&= report.orbClickDismisses.posUnchanged;

  // ── click-through: the window ignores the mouse except over the orb ──
  const p = await orbPos(o.win);
  o.setState('listening');
  await sleep(200);
  step = 'click-through';
  const move = (x: number, y: number) => o.win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  move(p.x - 300, p.y - 200); // the orb-click step left the pointer on the orb
  await sleep(100);
  ignore.length = 0;
  move(p.x - 300, p.y - 200);
  await sleep(100);
  move(p.x + 5, p.y - 5);
  await sleep(100);
  move(p.x - 300, p.y - 200);
  await sleep(100);
  report.clickThrough = { ignoreCalls: [...ignore], ok: ignore.join() === 'false,true' };
  o.dismiss();
  await sleep(1500);

  // ── drag the ember (at rest), then « restart » (new overlay window, same store) ──
  const to = { x: p.x - 400, y: p.y - 250 };
  move(p.x, p.y);
  await sleep(50);
  o.win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 20; i++) {
    // a real drag reports the left button held on every move (the page ends a drag without it)
    o.win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x + ((to.x - p.x) * i) / 20, y: p.y + ((to.y - p.y) * i) / 20, modifiers: ['leftButtonDown'] });
    await sleep(16);
  }
  o.win.webContents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  await sleep(200);
  const b = o.win.getBounds();
  const saved = store.orbPosition();
  await o.destroy();
  console.log('restart: new overlay window');
  o = await OrbOverlay.create({ store, dir, onError: (e) => errors.push(e) });
  o.show();
  await sleep(500);
  const after = await orbPos(o.win);
  // saved relative to the display's work area (#51), not as absolute pixels
  const d = screen.getDisplayMatching(b);
  report.drag = {
    from: p, to, saved, afterRestart: after,
    ok: saved?.display === d.id && saved.x === to.x + b.x - d.workArea.x && saved.y === to.y + b.y - d.workArea.y &&
      saved.width === d.workArea.width && saved.height === d.workArea.height && after.x === to.x && after.y === to.y,
  };

  // ── hidden ──
  o.hide();
  await sleep(1500);
  report.cpuHidden = await cpu(10);
  report.hiddenLoopStopped = !(await js<{ running: boolean }>(o.win, 'window.__orbStats()')).running;
  // every `{ ok }` check that failed counts as an error (exit 1)
  for (const [k, v] of Object.entries(report)) if (v && typeof v === 'object' && v.ok === false) errors.push(`check failed: ${k} ${JSON.stringify(v)}`);
  report.errors = errors;
  report.events = events;
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await o.destroy();
}

app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.ORB_CHECK_MIC!);
// the sandboxed audio service can't read the recording otherwise
app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox');
app.dock?.hide();
app
  .whenReady()
  .then(run)
  .then(() => app.exit(errors.length ? 1 : 0))
  .catch((e: unknown) => {
    console.error(e);
    app.exit(1);
  });
