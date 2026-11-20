// screenshot tool (#133): everything that can be checked without Chrome. The real browser run is in
// test/screenshot.chrome.test.ts (slow project, skipped when Chrome is missing).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import type { ModelRequest } from './providers/types.ts';
import { allowedRequest, findChrome, parseKey, resolveTarget, screenshotAnswer, shotName } from './screenshot.ts';
import { runTool, toolSpecs } from './tools.ts';

const wd = mkdtempSync(join(tmpdir(), 'atlas-shot-wd-'));
mkdirSync(join(wd, 'pages'), { recursive: true });
writeFileSync(join(wd, 'pages', 'my page.html'), '<p>hi</p>');

describe('resolveTarget', () => {
  const r = (t: string, theme?: 'dark' | 'light') => resolveTarget(t, { agentId: 'paris', workdir: wd, theme });
  it('takes app routes, with the theme as a preview parameter', () => {
    expect(r('#/chat/paris', 'dark')).toEqual({ path: '/?theme=dark#/chat/paris', kind: 'app' });
    expect(r('/#/board')).toEqual({ path: '/#/board', kind: 'app' });
    expect(r('/')).toEqual({ path: '/', kind: 'app' });
  });
  it('takes workspace files: relative to the workdir, or another agent’s /api/files path', () => {
    expect(r('pages/my page.html')).toEqual({ path: '/api/files/paris/pages/my%20page.html', kind: 'file' });
    expect(r('pages/my page.html#top').path).toBe('/api/files/paris/pages/my%20page.html#top');
    expect(r('/api/files/zurich/pages/x.html')).toEqual({ path: '/api/files/zurich/pages/x.html', kind: 'file' });
  });
  it('refuses other sites, paths outside the workspace and missing files, with the reason', () => {
    expect(() => r('https://example.com')).toThrow(/use web_fetch for other pages/);
    expect(() => r('//evil.com/x')).toThrow(/only the Atlas UI/);
    expect(() => r('file:///etc/passwd')).toThrow(/only the Atlas UI/);
    expect(() => r('../other/x.html')).toThrow(/outside your workspace/);
    expect(() => r('pages/none.html')).toThrow(/does not exist in your workspace/);
    expect(() => r('/api/files/zurich/../../x')).toThrow(/inside a workspace/);
    expect(() => r('/api/cards')).toThrow(/not an Atlas route/);
    expect(() => r('  ')).toThrow(/target is empty/);
  });
});

describe('read-only', () => {
  const engine = 'http://127.0.0.1:4317';
  it('lets reads through and refuses every write, except the session check', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(allowedRequest(m, engine + '/api/cards', engine)).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(allowedRequest(m, engine + '/api/cards/c_1', engine)).toBe(false);
    expect(allowedRequest('POST', engine + '/api/auth/check', engine)).toBe(true);
    expect(allowedRequest('POST', 'https://other.site/api/auth/check', engine)).toBe(false);
    expect(allowedRequest('POST', 'https://fonts.example/x', engine)).toBe(false);
  });
});

describe('names, keys, Chrome', () => {
  it('names the file after the target, width and theme', () => {
    const d = new Date(2026, 10, 18, 12);
    expect(shotName('#/chat/paris', 1440, 'dark', d)).toBe('2026-11-18-chat-paris-1440-dark');
    expect(shotName('/', 390, undefined, d)).toBe('2026-11-18-home-390-auto');
    expect(shotName('/api/files/paris/pages/Mock Up.html', 1100, 'light', d)).toBe('2026-11-18-pages-mock-up-1100-light');
  });
  it('parses key presses with modifiers', () => {
    expect(parseKey('Escape')).toMatchObject({ key: 'Escape', code: 'Escape', modifiers: 0 });
    expect(parseKey('Meta+k')).toMatchObject({ key: 'k', code: 'KeyK', modifiers: 4 });
    expect(parseKey('Meta+k').text).toBeUndefined(); // a shortcut types nothing
    expect(parseKey('a')).toMatchObject({ code: 'KeyA', text: 'a' });
    expect(parseKey('Shift+Tab')).toMatchObject({ key: 'Tab', modifiers: 8 });
    expect(() => parseKey('Hyper+k')).toThrow(/unknown modifier/);
    expect(() => parseKey('PageDown')).toThrow(/unknown key/);
  });
  it('fails loudly when Chrome is missing (no fallback)', () => {
    expect(() => findChrome({ ATLAS_CHROME: '/nope/chrome' }, () => false)).toThrow(/ATLAS_CHROME is set to \/nope\/chrome, which does not exist/);
    expect(() => findChrome({}, () => false)).toThrow(/needs Google Chrome, which was not found .*set ATLAS_CHROME/);
    expect(findChrome({}, (p) => p === '/usr/bin/chromium')).toBe('/usr/bin/chromium');
    expect(findChrome({ ATLAS_CHROME: '/x/chrome' }, (p) => p === '/x/chrome')).toBe('/x/chrome');
  });
  it('is offered with its inputs, and refused without an engine', async () => {
    const spec = toolSpecs().find((t) => t.name === 'screenshot')!;
    expect(Object.keys((spec.input_schema as { properties: object }).properties)).toEqual(['target', 'width', 'height', 'theme', 'full_page', 'clip', 'wait_for', 'actions']);
    const r = await runTool('screenshot', { target: '#/board' }, { workdir: wd, signal: new AbortController().signal, conversationId: 'c', outputsDir: wd });
    expect(r).toMatchObject({ isError: true, output: 'screenshot is not available here (no engine address)' });
    const bad = await runTool('screenshot', { target: '#/board', width: 100 }, { workdir: wd, signal: new AbortController().signal, conversationId: 'c', outputsDir: wd });
    expect(bad.isError).toBe(true);
  });
});

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});
const lastText = (req: ModelRequest) =>
  req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : [])).join('\n');
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

describe('in the engine', () => {
  it('answers the main-chat lookup read-only: the existing chat, never a new one', async () => {
    const engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, providers: () => new FakeProvider([]), env: {} });
    engines.push(engine);
    const count = () => engine.kanban.list().filter((c) => c.board === 'direct').length;
    const before = count();
    expect(screenshotAnswer(engine.kanban, 'POST', '/api/agents/atlas/main-chat')).toBeUndefined();
    expect(count()).toBe(before); // nothing created
    const chat = engine.kanban.mainChat('atlas');
    expect(screenshotAnswer(engine.kanban, 'POST', '/api/agents/atlas/main-chat')).toMatchObject({ id: chat.id });
    expect(screenshotAnswer(engine.kanban, 'POST', '/api/agents/atlas/main-chat/new')).toBeUndefined();
    expect(screenshotAnswer(engine.kanban, 'GET', '/api/agents/atlas/main-chat')).toBeUndefined();
    expect(screenshotAnswer(engine.kanban, 'POST', '/api/agents/nobody/main-chat')).toBeUndefined();
    // The pane's report (#305) gets a harmless answer; other writes on a card are still refused.
    expect(screenshotAnswer(engine.kanban, 'PUT', `/api/cards/${chat.id}/pane`)).toBeNull();
    expect(screenshotAnswer(engine.kanban, 'POST', `/api/cards/${chat.id}/pane`)).toBeUndefined();
    expect(screenshotAnswer(engine.kanban, 'PUT', `/api/cards/${chat.id}`)).toBeUndefined();
  });

  it('gets the engine address from the runner, so the agent never looks for a port', async () => {
    const prev = process.env.ATLAS_CHROME;
    process.env.ATLAS_CHROME = '/nonexistent/chrome-for-test';
    try {
      const fake = new FakeProvider([[{ type: 'tool_use', id: 't1', name: 'screenshot', input: { target: '#/board' } }], text('ok')]);
      const engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, providers: () => fake, env: {} });
      engines.push(engine);
      const card = engine.kanban.create({ title: 'shot', assignee: 'atlas' }, 'user');
      engine.kanban.appendMessage(card.id, 'user', 'user', text('take it'));
      engine.runner.wake(card.id);
      await engine.runner.settled(card.id);
      // Past the "no engine address" check: it reached the Chrome lookup, which fails loudly.
      expect(lastText(fake.calls[1]!)).toBe('screenshot needs Google Chrome: ATLAS_CHROME is set to /nonexistent/chrome-for-test, which does not exist');
    } finally {
      if (prev === undefined) delete process.env.ATLAS_CHROME;
      else process.env.ATLAS_CHROME = prev;
    }
  });
});
