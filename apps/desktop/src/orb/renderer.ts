/**
 * The voice orb page (overlay window). The animation is the one Master approved in pages/orb.html, ported as is, with
 * the fake audio replaced by real levels: the microphone (listening) and the reply being played (speaking). Colours:
 * the Atlas accent, sea teal (#6cc0d2, the bright dark-theme one: the orb floats over the desktop), approved 13 Nov.
 * The page is also the voice loop's ear: while shown, it streams the microphone (16 kHz, echo-cancelled) to the main
 * process, where the wake word listens (apps/desktop/src/voice.ts).
 *
 * Performance: one canvas the size of the orb's glow (not the screen), moved with a CSS transform. The animation loop
 * runs only while the orb is awake or fading; at rest it stops and a CSS-animated ember takes over (no script per
 * frame). Hidden: everything stops, microphone and audio closed.
 */
import { ORB_BOX, ORB_RADIUS, bubbleSide, clampToArea, isOnOrb, levelFromRms, replyLineOnEnter, rms, typeDelay, withSentence, type OrbState, type Point } from './model.ts';
import type { FromOrb, OrbBridge, ToOrb } from './protocol.ts';

declare global {
  interface Window {
    orb: OrbBridge;
    /** Frame timings for the performance check (scripts/orb-check). */
    __orbStats: () => { intervals: number[]; draw: number[]; at: number[]; running: boolean };
    __orbStatsReset: () => void;
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cv = $<HTMLCanvasElement>('c');
const g = cv.getContext('2d')!;
const send = (m: FromOrb) => window.orb.send(m);

// ── layout ───────────────────────────────────────────────────────────────────────────────────────────────────────
const B = ORB_BOX;
const C = B / 2; // orb centre inside the canvas
let pos: Point = { x: innerWidth - 118, y: innerHeight - 150 };

function sizeCanvas() {
  const dpr = devicePixelRatio || 1;
  cv.width = B * dpr;
  cv.height = B * dpr;
  cv.style.width = cv.style.height = `${B}px`;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
sizeCanvas();
matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', sizeCanvas);

function place() {
  cv.style.transform = `translate(${pos.x - C}px, ${pos.y - C}px)`;
  const ember = $('ember');
  // the `translate` property, not `transform`: the breathing animates `scale`, and CSS applies `scale` around the
  // element's own centre only when the position is in `translate` (with `transform` it scaled the position itself:
  // the ember swung 20 % of the way towards the screen's top-left corner on every beat)
  ember.style.translate = `${pos.x}px ${pos.y}px`;
  const label = $('label');
  label.style.left = `${pos.x}px`;
  label.style.top = `${pos.y + 92}px`;
  const b = $('bubble');
  const side = bubbleSide(pos.x);
  b.classList.toggle('right', side === 'right');
  b.style.left = side === 'right' ? `${pos.x + 132}px` : '';
  b.style.right = side === 'left' ? `${innerWidth - (pos.x - 132)}px` : '';
  // near the top of the screen the bubble hangs down from the orb instead of rising from it
  b.style.bottom = pos.y > 320 ? `${innerHeight - (pos.y + 40)}px` : '';
  b.style.top = pos.y > 320 ? '' : `${pos.y - 40}px`;
}
const trace = (why: string) => send({ type: 'trace', line: `${why}: orb at ${Math.round(pos.x)},${Math.round(pos.y)} in a ${innerWidth}×${innerHeight} page` });
addEventListener('resize', () => {
  pos = clampToArea(pos, { x: 0, y: 0, width: innerWidth, height: innerHeight });
  place();
  trace('page resized');
});

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────────────
let state: OrbState = 'idle';
let visible = true;
/** The voice loop wants the microphone (main process 'mic'); closed until it says so. */
let micWanted = false;
const k = { vis: 0, scale: 0.2, level: 0, spin: 0, think: 0, listen: 0, speak: 0 }; // smoothed parameters
const P = [...Array(140)].map(() => ({ a: Math.random() * 6.283, r: 0.9 + Math.random() * 1.1, s: 0.2 + Math.random() * 0.8, z: Math.random(), l: Math.random() }));
const ripples: { t: number; big: boolean }[] = [];
let flash = 0;
let stateAt = performance.now();

function setState(s: OrbState) {
  const prev = state;
  state = s;
  stateAt = performance.now();
  if (s === 'wake') {
    flash = 1;
    ripples.push({ t: 0, big: true });
  }
  $('label').textContent = { idle: '', wake: 'online', listening: 'listening', thinking: 'thinking', speaking: 'speaking' }[s];
  ember();
  if (s !== 'idle' && !hit) setHit(isOnOrb(mouse, pos, s)); // the hit area grows when the orb wakes
  // caption
  if (s === 'idle') {
    bubble(false);
    stopSpeech();
  } else $('err').textContent = '';
  const line = replyLineOnEnter(s);
  if (s === 'wake') bubble(true, '', line, false);
  if (s === 'listening') {
    if (prev !== 'listening') transcript = '';
    bubble(true, transcript ? `You: “${transcript}”` : '', line, true);
  }
  if (s === 'thinking') bubble(true, undefined, line, true);
  if (s === 'speaking') bubble(true, undefined, line, false);
  loop();
}

// ── caption bubble ───────────────────────────────────────────────────────────────────────────────────────────────
let typeJob = 0;
let transcript = '';
function type(el: HTMLElement, s: string, ms = 28, append = false) {
  const id = ++typeJob;
  const base = append ? (el.textContent ?? '') : '';
  el.textContent = base;
  let i = 0;
  const step = () => {
    if (id !== typeJob) return;
    el.textContent = base + s.slice(0, ++i);
    if (i < s.length) setTimeout(step, ms);
  };
  if (s) step();
}
function bubble(show: boolean, you?: string, txt?: string, caret?: boolean) {
  $('bubble').classList.toggle('show', show);
  if (you !== undefined) $('you').textContent = you;
  if (txt !== undefined) type($('txt'), txt);
  if (caret !== undefined) $('caret').style.display = caret ? 'inline-block' : 'none';
}
function displayError(message: string) {
  $('err').textContent = message;
  $('bubble').classList.add('show');
}
function showError(message: string) {
  displayError(message);
  send({ type: 'error', message });
}

// ── audio: microphone level (listening) and reply playback + its level (speaking) ──────────────────────────────
interface Meter {
  ctx: AudioContext;
  an: AnalyserNode;
  buf: Float32Array<ArrayBuffer>;
}
let mic: (Meter & { stream: MediaStream; proc: ScriptProcessorNode }) | null = null;
let micOpening = false;
let out: (Meter & { gain: GainNode; head: number; sources: Set<AudioBufferSourceNode>; timers: Set<ReturnType<typeof setTimeout>> }) | null = null;

function meter(ctx: AudioContext): Meter {
  const an = ctx.createAnalyser();
  an.fftSize = 1024;
  return { ctx, an, buf: new Float32Array(an.fftSize) };
}
const level = (m: Meter | null) => {
  if (!m) return 0;
  m.an.getFloatTimeDomainData(m.buf);
  return levelFromRms(rms(m.buf));
};

/**
 * At rest: the ember breathes while the wake word listens; with the microphone closed (wake word off, card #57) it is
 * a dim, still dot: nothing hears you until the push-to-talk shortcut.
 */
function ember() {
  const e = $('ember');
  e.classList.toggle('on', state === 'idle' && visible && micWanted);
  e.classList.toggle('closed', state === 'idle' && visible && !micWanted);
}

async function openMic() {
  if (mic || micOpening || !micWanted) return;
  micOpening = true;
  try {
    // echo cancellation: Atlas's own voice (played by this page) is taken out of what the microphone hears
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
    if (!visible || !micWanted) return stream.getTracks().forEach((t) => t.stop()); // hidden or closed meanwhile
    // 16 kHz, what the voice models take: Chromium resamples the microphone into this context
    const m = meter(new AudioContext({ sampleRate: 16_000 }));
    const src = m.ctx.createMediaStreamSource(stream);
    src.connect(m.an);
    // ~128 ms frames to the main process (the wake word listens all the time while the orb is shown)
    const proc = m.ctx.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = (e) => send({ type: 'audio', samples: new Float32Array(e.inputBuffer.getChannelData(0)) });
    src.connect(proc);
    proc.connect(m.ctx.destination); // outputs silence; a processor only runs when connected
    mic = { ...m, stream, proc };
  } catch (e) {
    showError(`Microphone unavailable: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    micOpening = false;
  }
}
function closeMic() {
  if (!mic) return;
  mic.proc.onaudioprocess = null;
  mic.stream.getTracks().forEach((t) => t.stop());
  void mic.ctx.close();
  mic = null;
}

function speak(msg: Extract<ToOrb, { type: 'speak' }>) {
  if (!out) {
    const ctx = new AudioContext();
    const m = meter(ctx);
    const gain = ctx.createGain();
    gain.connect(m.an);
    m.an.connect(ctx.destination);
    out = { ...m, gain, head: 0, sources: new Set(), timers: new Set() };
  }
  const o = out;
  void o.ctx.resume();
  const buffer = o.ctx.createBuffer(1, msg.samples.length, msg.sampleRate);
  buffer.copyToChannel(new Float32Array(msg.samples), 0);
  const src = o.ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(o.gain);
  const at = Math.max(o.ctx.currentTime + 0.03, o.head);
  src.start(at);
  o.head = at + buffer.duration;
  o.sources.add(src);
  src.onended = () => {
    o.sources.delete(src);
    if (out === o) send({ type: 'spoken', id: msg.id });
  };
  // type the sentence while it is heard
  const timer = setTimeout(() => {
    o.timers.delete(timer);
    const txt = $('txt');
    const shown = txt.textContent ?? '';
    type(txt, withSentence(shown, msg.text).slice(shown.length), typeDelay(msg.text, buffer.duration), true);
  }, (at - o.ctx.currentTime) * 1000);
  o.timers.add(timer);
}
function stopSpeech() {
  if (!out) return;
  const o = out;
  out = null;
  o.timers.forEach(clearTimeout);
  o.sources.forEach((s) => s.stop());
  void o.ctx.close();
}

// ── mouse: click-through except on the orb, drag, click on the orb = end, Esc ───────────────────────────────────────────────────────────
let hit = false;
let mouse: Point = { x: -1e4, y: -1e4 };
let drag: { dx: number; dy: number; x0: number; y0: number; moved: boolean } | null = null;
/** Pointer travel (px) under which a press on the orb is a click (end the conversation), not a drag. */
const CLICK_SLOP = 4;
function setHit(on: boolean) {
  if (on === hit) return;
  hit = on;
  document.body.classList.toggle('grab', on);
  send({ type: 'hit', on });
}
addEventListener('mousemove', (e) => {
  mouse = { x: e.clientX, y: e.clientY };
  if (drag && !(e.buttons & 1)) {
    // the button was released where this page never saw it (another app took the mouse, or the window ignored it):
    // without this, the orb went on following the pointer around the screen
    endDrag('drag ended without a mouseup (button no longer down)');
  } else if (drag) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > CLICK_SLOP) drag.moved = true;
    if (!drag.moved) return;
    pos = clampToArea({ x: e.clientX - drag.dx, y: e.clientY - drag.dy }, { x: 0, y: 0, width: innerWidth, height: innerHeight });
    place();
    return;
  }
  setHit(isOnOrb(mouse, pos, state));
});
addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !isOnOrb({ x: e.clientX, y: e.clientY }, pos, state)) return;
  drag = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, x0: e.clientX, y0: e.clientY, moved: false };
  document.body.classList.add('grabbing');
});
function endDrag(why: string, click = false) {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  document.body.classList.remove('grabbing');
  if (moved) {
    send({ type: 'moved', pos });
    trace(why);
  } else if (click && state !== 'idle') send({ type: 'dismiss' }); // a click on the awake orb ends the conversation
  setHit(isOnOrb(mouse, pos, state));
}
addEventListener('mouseup', () => endDrag('dragged', true));
addEventListener('blur', () => endDrag('drag ended: the orb window lost focus'));
document.addEventListener('mouseleave', () => !drag && setHit(false));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') send({ type: 'escape' });
});

// ── animation ────────────────────────────────────────────────────────────────────────────────────────────────────
const n1 = (x: number, t: number) => Math.sin(x * 3 + t * 1.3) * 0.5 + Math.sin(x * 5 - t * 1.9) * 0.3 + Math.sin(x * 7 + t * 2.7) * 0.2;
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const TARGET: Record<OrbState, { vis: number; scale: number }> = {
  idle: { vis: 0, scale: 0.35 },
  wake: { vis: 1, scale: 1 },
  listening: { vis: 1, scale: 1 },
  thinking: { vis: 1, scale: 0.92 },
  speaking: { vis: 1, scale: 1 },
};
let running = false;
let raf = 0;
let last = 0;
let T = 0;
const STATS = 1200;
const intervals = new Float32Array(STATS);
const drawMs = new Float32Array(STATS);
const frameAt = new Float64Array(STATS);
let nStats = 0;
window.__orbStats = () => {
  const n = Math.min(nStats, STATS);
  return { intervals: [...intervals.subarray(0, n)], draw: [...drawMs.subarray(0, n)], at: [...frameAt.subarray(0, n)], running };
};
window.__orbStatsReset = () => void (nStats = 0);

function loop() {
  if (running || !visible) return;
  running = true;
  last = performance.now();
  raf = requestAnimationFrame(frame);
}

function frame(now: number) {
  if (!visible) return void (running = false);
  const t0 = performance.now();
  const dtMs = now - last;
  const dt = Math.min(0.05, dtMs / 1000);
  last = now;
  T += dt;
  const s = state;
  const since = (now - stateAt) / 1000;
  const tts = level(out);
  let lvl = 0;
  if (s === 'listening') lvl = level(mic);
  if (s === 'speaking') lvl = tts;
  if (s === 'wake') lvl = Math.max(0.6 - since * 0.5, tts, 0);
  const tgt = TARGET[s];
  const f = 1 - Math.pow(0.001, dt);
  k.vis = lerp(k.vis, tgt.vis, s === 'idle' ? f * 0.6 : f * 1.6);
  k.level = lerp(k.level, lvl, 1 - Math.pow(0.0001, dt));
  k.scale = lerp(k.scale, tgt.scale + (s === 'speaking' ? k.level * 0.12 : 0) + (s === 'listening' ? k.level * 0.07 : 0), 1 - Math.pow(0.002, dt));
  k.think = lerp(k.think, s === 'thinking' ? 1 : 0, f);
  k.listen = lerp(k.listen, s === 'listening' ? 1 : 0, f);
  k.speak = lerp(k.speak, s === 'speaking' ? 1 : 0, f);
  k.spin += dt * (0.4 + k.think * 4.5 + k.speak * 1.2);
  flash = Math.max(0, flash - dt * 1.8);
  if (s === 'listening' && Math.random() < dt * (1.2 + k.level * 3)) ripples.push({ t: 0, big: false });
  if (s === 'speaking' && k.level > 0.75 && Math.random() < dt * 4) ripples.push({ t: 0, big: false });
  draw(T, dt);
  const i = nStats++ % STATS;
  intervals[i] = dtMs;
  drawMs[i] = performance.now() - t0;
  frameAt[i] = now;
  // at rest and faded out: stop; the CSS ember carries on without script
  if (s === 'idle' && k.vis < 0.004 && !ripples.length) {
    running = false;
    g.clearRect(0, 0, B, B);
    return;
  }
  raf = requestAnimationFrame(frame);
}

function draw(t: number, dt: number) {
  g.clearRect(0, 0, B, B);
  const cx = C;
  const cy = C;
  const R = ORB_RADIUS * k.scale;
  const V = k.vis;
  if (V < 0.004) return;
  g.save();
  g.globalAlpha = V;
  // big ambient glow
  g.globalCompositeOperation = 'lighter';
  const gr = Math.min(C - 2, R * (3.2 + k.level * 1.4 + flash * 2));
  const a = g.createRadialGradient(cx, cy, R * 0.4, cx, cy, gr);
  a.addColorStop(0, `rgba(108,192,210,${0.35 + k.level * 0.25 + flash * 0.4})`);
  a.addColorStop(0.4, 'rgba(27,108,128,.14)');
  a.addColorStop(1, 'rgba(11,42,49,0)');
  g.fillStyle = a;
  g.beginPath();
  g.arc(cx, cy, gr, 0, 7);
  g.fill();
  // ripples
  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i]!;
    r.t += dt;
    const life = r.big ? 1.2 : 1.6;
    const p = r.t / life;
    if (p >= 1) {
      ripples.splice(i, 1);
      continue;
    }
    g.strokeStyle = `rgba(${108 + 90 * (1 - p)},${192 + 45 * (1 - p)},${210 + 30 * (1 - p)},${0.5 * (1 - p) * (r.big ? 1.4 : 1)})`;
    g.lineWidth = (r.big ? 3 : 1.5) * (1 - p) + 0.3;
    g.beginPath();
    g.arc(cx, cy, Math.min(C - 2, R * (1.05 + p * (r.big ? 2.6 : 1.5))), 0, 7);
    g.stroke();
  }
  // orbit / swirl particles
  const step = dt * 60;
  const swirl = k.think * 0.45;
  const burst = k.speak * k.level * 0.6;
  for (const p of P) {
    p.a += (0.002 + p.s * 0.006) * (1 + k.think * 6 + k.speak * 1.5) * step;
    const rr = R * (p.r * (1 - swirl * 0.5) + burst * p.l + k.listen * 0.15 * Math.sin(t * 3 + p.a * 4));
    const tilt = 0.35 + 0.65 * p.z;
    const al = (0.25 + 0.6 * p.l) * (0.5 + 0.5 * Math.sin(t * 2 + p.a * 3));
    g.fillStyle = `rgba(${(108 + 110 * p.l) | 0},${(192 + 50 * p.l) | 0},${(210 + 30 * p.z) | 0},${al})`;
    g.beginPath();
    g.arc(cx + Math.cos(p.a) * rr, cy + Math.sin(p.a) * rr * tilt, 0.6 + p.l * 1.6, 0, 7);
    g.fill();
  }
  // thinking arcs
  if (k.think > 0.02) {
    g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const rr = R * (1.25 + i * 0.18);
      const st0 = k.spin * (i % 2 ? -1 : 1) * (1 + i * 0.4) + i * 2;
      g.strokeStyle = `rgba(${108 + i * 40},${192 + i * 20},${210 + i * 10},${0.7 * k.think})`;
      g.lineWidth = 2.2 - i * 0.5;
      g.beginPath();
      g.arc(cx, cy, rr, st0, st0 + 1.1 + i * 0.5);
      g.stroke();
    }
  }
  g.globalCompositeOperation = 'source-over';
  // liquid core blob
  const amp = 0.04 + k.level * 0.16 + k.think * 0.05 + flash * 0.15;
  g.beginPath();
  for (let i = 0; i <= 96; i++) {
    const th = (i / 96) * 6.283;
    const d = 1 + amp * n1(th, t * (1.6 + k.speak * 2.5 + k.think * 2));
    const x = cx + Math.cos(th) * R * d;
    const y = cy + Math.sin(th) * R * d;
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.closePath();
  const cg = g.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.05, cx, cy, R * 1.15);
  cg.addColorStop(0, '#e6f7fa');
  cg.addColorStop(0.18, '#a9dfea');
  cg.addColorStop(0.5, '#6cc0d2');
  cg.addColorStop(0.85, '#1b6c80');
  cg.addColorStop(1, '#0b2a31');
  g.fillStyle = cg;
  g.shadowColor = 'rgba(108,192,210,.9)';
  g.shadowBlur = 30 + k.level * 30;
  g.fill();
  g.shadowBlur = 0;
  // inner plasma swirls (clipped)
  g.save();
  g.clip();
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {
    const ang = k.spin * (1 + i * 0.3) + i * 1.6;
    const px = cx + Math.cos(ang) * R * 0.35;
    const py = cy + Math.sin(ang * 1.3) * R * 0.3;
    const pg = g.createRadialGradient(px, py, 0, px, py, R * (0.55 + k.level * 0.3));
    pg.addColorStop(0, `rgba(${150 + i * 20},${215 + i * 10},228,${0.35 + k.level * 0.3})`);
    pg.addColorStop(1, 'rgba(27,108,128,0)');
    g.fillStyle = pg;
    g.fillRect(cx - R * 1.4, cy - R * 1.4, R * 2.8, R * 2.8);
  }
  // speaking: equalizer bars inside the core
  if (k.speak > 0.05) {
    g.fillStyle = `rgba(235,250,252,${0.75 * k.speak})`;
    for (let i = 0; i < 7; i++) {
      const h = R * (0.12 + 0.55 * k.level * Math.abs(Math.sin(t * 9 + i * 1.3)) * (1 - Math.abs(i - 3) / 5));
      const bx = cx + (i - 3) * R * 0.17;
      g.beginPath();
      g.roundRect(bx - R * 0.045, cy - h / 2, R * 0.09, h, R * 0.045);
      g.fill();
    }
  }
  g.restore();
  // glass highlight
  g.globalCompositeOperation = 'screen';
  const hg = g.createRadialGradient(cx - R * 0.38, cy - R * 0.45, 0, cx - R * 0.38, cy - R * 0.45, R * 0.55);
  hg.addColorStop(0, 'rgba(255,255,255,.55)');
  hg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hg;
  g.beginPath();
  g.arc(cx - R * 0.38, cy - R * 0.45, R * 0.55, 0, 7);
  g.fill();
  // rim
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = `rgba(160,220,232,${0.25 + k.level * 0.4})`;
  g.lineWidth = 1.2;
  g.beginPath();
  g.arc(cx, cy, R * 1.02, 0, 7);
  g.stroke();
  // wake flash
  if (flash > 0) {
    const fg = g.createRadialGradient(cx, cy, 0, cx, cy, R * 2.2);
    fg.addColorStop(0, `rgba(240,252,255,${flash * 0.7})`);
    fg.addColorStop(1, 'rgba(108,192,210,0)');
    g.fillStyle = fg;
    g.beginPath();
    g.arc(cx, cy, R * 2.2, 0, 7);
    g.fill();
  }
  g.restore();
}

// ── messages from the main process ──────────────────────────────────────────────────────────────────────────────
window.orb.on((msg) => {
  switch (msg.type) {
    case 'init':
      pos = msg.pos;
      place();
      trace('placed by the app');
      return;
    case 'state':
      return setState(msg.state);
    case 'transcript':
      transcript = msg.text;
      if (state === 'listening') $('you').textContent = msg.text ? `You: “${msg.text}”` : '';
      return;
    case 'speak':
      return speak(msg);
    case 'hush':
      stopSpeech();
      return;
    case 'error':
      return displayError(msg.message);
    case 'mic':
      micWanted = msg.on;
      if (micWanted && visible) void openMic();
      if (!micWanted) closeMic();
      ember();
      return;
    case 'visible':
      visible = msg.visible;
      if (!visible) {
        cancelAnimationFrame(raf);
        running = false;
        stopSpeech();
        closeMic();
        ember();
      } else {
        ember();
        void openMic();
        loop();
      }
      return;
  }
});
place();
setState('idle');
