// screenshot tool (#133) with a real headless Chrome against a real engine and the built UI. Slow project (starts
// Chrome); skipped when Chrome is not installed or the UI is not built (`npm run build`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expectNoProcessLeft } from './kit/index.ts';
import { readdirSync } from 'node:fs';
import sharp from 'sharp';
import { startEngine, type Engine } from '../src/index.ts';
import { FakeProvider } from '../src/providers/fake.ts';
import { findChrome, screenshotAnswer } from '../src/screenshot.ts';
import { runTool, type ToolContext } from '../src/tools.ts';
import type { CommentAnchor, ImageBlock } from '@atlas/shared';

const uiDir = resolve(import.meta.dirname, '../../ui/dist');
let chrome = true;
try {
  findChrome();
} catch {
  chrome = false;
}
const ready = chrome && existsSync(join(uiDir, 'index.html'));

describe.skipIf(!ready)('screenshot with Chrome', () => {
  let engine: Engine;
  let dataDir: string;
  let wd: string;
  const ctx = (): ToolContext => ({
    workdir: wd,
    signal: new AbortController().signal,
    conversationId: 'c',
    outputsDir: join(dataDir, 'outputs'),
    engine: { url: engine.url, agentId: 'atlas', cookie: () => null, answer: (m, p) => screenshotAnswer(engine.kanban, m, p) },
  });
  const shoot = (input: Record<string, unknown>) => runTool('screenshot', input, ctx());

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'atlas-shot-'));
    engine = await startEngine({ dbFile: ':memory:', dataDir, port: 0, dispatch: false, uiDir, providers: () => new FakeProvider([]), env: {} });
    wd = join(dataDir, 'workspaces', 'atlas');
    mkdirSync(join(wd, 'pages'), { recursive: true });
    mkdirSync(join(wd, 'links'), { recursive: true });
    writeFileSync(
      join(wd, 'pages', 'mock.html'),
      `<!doctype html><style>body{margin:0;background:#123}#box{width:200px;height:100px;background:#f00}</style>
       <div id="box"></div><button id="go" onclick="document.body.insertAdjacentHTML('beforeend','<p id=after>after</p>')">go</button>
       <script>console.error('mock says no'); fetch('/api/cards', { method: 'POST', body: '{}' }).catch(() => {}); setTimeout(() => { throw new Error('boom'); });</script>`,
    );
    writeFileSync(join(wd, 'pages', 'inner.html'), `<p>inner</p><script>fetch('/api/workflows', { method: 'POST', mode: 'no-cors', body: 'x' }).catch(() => {})</script>`);
    writeFileSync(join(wd, 'pages', 'outer.html'), `<h1>outer</h1><iframe src="/api/files/atlas/pages/inner.html"></iframe>`);
  }, 30_000);
  afterAll(async () => {
    await engine?.stop();
  });

  it('shoots an app route at a width and theme, as a picture saved in the workspace', async () => {
    const r = await shoot({ target: '#/board', width: 1100, height: 700, theme: 'light' });
    expect(r.isError, r.output).toBe(false);
    expect(r.output).toContain('Screenshot of /?theme=light#/board');
    expect(r.output).toContain('Viewport: 1100×700 CSS px, desktop mode, scale 2, theme light');
    const file = /Saved: (\S+)/.exec(r.output)![1]!;
    expect(file).toMatch(/^screenshots\/\d{4}-\d\d-\d\d-board-1100-light\.png$/);
    const meta = await sharp(readFileSync(join(wd, file))).metadata();
    expect([meta.width, meta.height]).toEqual([2200, 1400]);
    expect(r.images).toHaveLength(1);
    expect(r.images![0]).toMatchObject({ width: 2200, height: 1400, media_type: 'image/png' });
  }, 30_000);

  it('an agent chat: the main-chat lookup is answered read-only, so the chat shows without any write', async () => {
    engine.kanban.mainChat('atlas');
    const r = await shoot({ target: '#/chat/atlas', wait_for: 'textarea' });
    expect(r.isError, r.output).toBe(false);
    expect(r.output).not.toContain('Writes refused');
    expect(r.output).toContain('Page errors: none');
  }, 30_000);

  it('a mockup: page errors, console.error and refused writes come back with the picture', async () => {
    const cards = engine.kanban.list().length;
    const r = await shoot({ target: 'pages/mock.html', width: 390, height: 600 });
    expect(engine.kanban.list()).toHaveLength(cards);
    expect(r.isError, r.output).toBe(false);
    expect(r.output).toContain('phone mode (mobile, touch)');
    expect(r.output).toContain('console.error: mock says no');
    expect(r.output).toMatch(/page error: .*boom/);
    expect(r.output).toContain('Writes refused (read-only):\n  POST /api/cards');
  }, 30_000);

  it('frames in other processes (sandboxed pages, like mockups in a chat) settle and are read-only too', async () => {
    const r = await shoot({ target: 'pages/outer.html' });
    expect(r.isError, r.output).toBe(false);
    expect(r.output).toContain('Writes refused (read-only):\n  POST /api/workflows');
  }, 30_000);

  it('clip shoots one element; actions run before the shot; wait_for waits for the result', async () => {
    const clip = await shoot({ target: 'pages/mock.html', clip: '#box' });
    expect(clip.images![0]).toMatchObject({ width: 400, height: 200 });
    const after = await shoot({ target: 'pages/mock.html', actions: [{ click: '#go' }], wait_for: '#after' });
    expect(after.isError, after.output).toBe(false);
  }, 30_000);

  it('#381: an area dragged in a scrolled page in the pane is in the page\'s coordinates: the picture is that area, inside names it', async () => {
    // A long page, as a url artifact opens it in the pane (?pane=1: the helper). Red, then a green band at y 1500 with
    // one bar in it, then blue. In a frame it scrolls to 1400 and drags client (20,120)–(220,370) once comment mode is on.
    writeFileSync(
      join(wd, 'pages', 'long.html'),
      `<!doctype html><style>body{margin:0}div{position:absolute;left:0;width:600px}</style>
       <div style="top:0;height:1500px;background:#f00">Section 1</div>
       <div style="top:1500px;height:300px;background:#00a000"></div>
       <div class="bar" style="top:1560px;left:40px;width:120px;height:40px;background:#00a000">Working bar</div>
       <div style="top:1800px;height:1500px;background:#00f"></div>
       <script>if (window.parent !== window) { scrollTo(0, 1400); addEventListener('message', (e) => { if (!e.data || !e.data.on) return; setTimeout(() => {
         const ev = (t, x, y) => dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, button: 0, bubbles: true }));
         ev('pointerdown', 20, 120); ev('pointermove', 120, 250); ev('pointermove', 220, 370); ev('pointerup', 220, 370); }, 0); }); }</script>`,
    );
    // The app's side: comment mode on once the helper is ready; the pick it sends back is logged for the test to read.
    writeFileSync(
      join(wd, 'pages', 'pane381.html'),
      `<!doctype html><iframe id="f" src="/api/files/atlas/pages/long.html?pane=1" style="width:656px;height:500px;border:0"></iframe>
       <script>addEventListener('message', (e) => { const d = e.data || {};
         if (d.ready) document.getElementById('f').contentWindow.postMessage({ atlasPane: 1, on: true, marks: [] }, '*');
         if (d.pick) { console.error('PICK ' + JSON.stringify(d.pick.anchor)); document.body.insertAdjacentHTML('beforeend', '<p id="done">done</p>'); } });</script>`,
    );
    const r = await shoot({ target: 'pages/pane381.html', wait_for: '#done' });
    expect(r.isError, r.output).toBe(false);
    const anchor = JSON.parse(/PICK (\{.*\})/.exec(r.output)![1]!) as Extract<CommentAnchor, { type: 'area' }>;
    expect(anchor).toMatchObject({ type: 'area', box: { x: 20, y: 1520, w: 200, h: 250 }, unit: 'px', inside: [{ selector: expect.stringContaining('div.bar'), text: 'Working bar' }] });
    expect(anchor.of.h).toBe(3300); // the document, not the frame's 500 px

    // The engine shoots the page at that box: all green (the band), nothing of section 1 at the top.
    writeFileSync(join(wd, 'links', 'long.url'), '/api/files/atlas/pages/long.html\n');
    const link = engine.documents.indexFile('atlas', 'links/long.url', 'atlas');
    const chat = engine.kanban.newChat('atlas');
    const res = await fetch(`${engine.url}/api/cards/${chat.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ comments: [{ target: { kind: 'doc', docId: link.id, version: 1 }, anchor, text: 'These bars.' }] }),
    });
    expect(res.status).toBe(201);
    const content = engine.kanban.messages(chat.id).at(-1)!.content;
    const text = content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    expect(text).toContain('area x=20 y=1520 w=200 h=250 px of 656×3300');
    expect(text).toContain('Working bar');
    const pic = content.find((b): b is ImageBlock => b.type === 'image');
    expect(pic, text).toBeDefined();
    const { data, info } = await sharp(readFileSync(pic!.path)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([400, 500]); // 200×250 CSS px at scale 2
    let off = 0;
    for (let i = 0; i < data.length; i += 3) if (Math.abs(data[i]! - 0) > 8 || Math.abs(data[i + 1]! - 0xa0) > 8 || Math.abs(data[i + 2]! - 0) > 8) off++;
    expect(off / (data.length / 3)).toBeLessThan(0.02); // the bar's text aside, all green
  }, 60_000);

  it('leaves no browser and no profile behind, after a shot and after a failure', async (ctx) => {
    const profiles = () => readdirSync(tmpdir()).filter((d) => d.startsWith('atlas-shot-chrome-'));
    await shoot({ target: 'pages/mock.html' });
    await shoot({ target: 'pages/none.html' }).catch(() => {});
    await shoot({ target: '/api/files/atlas/pages/none.html' });
    await new Promise((r) => setTimeout(r, 500));
    expect(profiles()).toEqual([]);
    expectNoProcessLeft('atlas-shot-chrome-', ctx);
  }, 30_000);

  it('fails loudly, naming the selector, when wait_for never appears', async () => {
    const r = await shoot({ target: 'pages/mock.html', wait_for: '#never' });
    expect(r).toMatchObject({ isError: true });
    expect(r.output).toMatch(/^screenshot timed out after 15 s waiting for wait_for: "#never" to appear; no picture taken/);
  }, 30_000);

  it('a missing workspace file served by another agent is an error, not a picture of a 404', async () => {
    const r = await shoot({ target: '/api/files/atlas/pages/none.html' });
    expect(r).toMatchObject({ isError: true });
    expect(r.output).toMatch(/answered 404/);
  }, 30_000);
});
