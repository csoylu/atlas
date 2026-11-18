// screenshot tool (#133) with a real headless Chrome against a real engine and the built UI. Slow project (starts
// Chrome); skipped when Chrome is not installed or the UI is not built (`npm run build`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import sharp from 'sharp';
import { startEngine, type Engine } from '../src/index.ts';
import { FakeProvider } from '../src/providers/fake.ts';
import { findChrome, screenshotAnswer } from '../src/screenshot.ts';
import { runTool, type ToolContext } from '../src/tools.ts';

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
    writeFileSync(
      join(wd, 'pages', 'mock.html'),
      `<!doctype html><style>body{margin:0;background:#123}#box{width:200px;height:100px;background:#f00}</style>
       <div id="box"></div><button id="go" onclick="document.body.insertAdjacentHTML('beforeend','<p id=after>after</p>')">go</button>
       <script>console.error('mock says no'); fetch('/api/cards', { method: 'POST', body: '{}' }).catch(() => {}); setTimeout(() => { throw new Error('boom'); });</script>`,
    );
    writeFileSync(join(wd, 'pages', 'inner.html'), `<p>inner</p><script>fetch('/api/schedules', { method: 'POST', mode: 'no-cors', body: 'x' }).catch(() => {})</script>`);
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
    expect(r.output).toContain('Writes refused (read-only):\n  POST /api/schedules');
  }, 30_000);

  it('clip shoots one element; actions run before the shot; wait_for waits for the result', async () => {
    const clip = await shoot({ target: 'pages/mock.html', clip: '#box' });
    expect(clip.images![0]).toMatchObject({ width: 400, height: 200 });
    const after = await shoot({ target: 'pages/mock.html', actions: [{ click: '#go' }], wait_for: '#after' });
    expect(after.isError, after.output).toBe(false);
  }, 30_000);

  it('leaves no browser and no profile behind, after a shot and after a failure', async () => {
    const left = () => {
      let ps = '';
      try {
        ps = execFileSync('pgrep', ['-f', 'atlas-shot-chrome-'], { encoding: 'utf8' });
      } catch {
        // pgrep exits 1 when nothing matches
      }
      return { ps: ps.trim(), dirs: readdirSync(tmpdir()).filter((d) => d.startsWith('atlas-shot-chrome-')) };
    };
    await shoot({ target: 'pages/mock.html' });
    await shoot({ target: 'pages/none.html' }).catch(() => {});
    await shoot({ target: '/api/files/atlas/pages/none.html' });
    await new Promise((r) => setTimeout(r, 500));
    expect(left()).toEqual({ ps: '', dirs: [] });
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
