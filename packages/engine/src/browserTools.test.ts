import { describe, expect, it } from 'vitest';
import { actionCaption, type ContentBlock } from '@atlas/shared';
import { launch } from '../test/kit/index.ts';
import type { BrowserHost, HostEvent, HostTab } from './browser.ts';
import type { ModelRequest } from './providers/types.ts';
import type { SecretStore } from './secrets.ts';
import { BUSY, HANDED_BACK, keyEvents, renderAxTree, runBrowserTool } from './browserTools.ts';

/** #298 S7: the agent's browser tools against a fake BrowserHost that answers CDP for a small page. */

const SECRET = 'tok-very-secret-123456';

/** One page: a button (ref 5), a text box (ref 7, its value), a select (ref 9). */
class FakeHost implements BrowserHost {
  cleared: string[] = [];
  async clearData(partition: string): Promise<void> {
    this.cleared.push(partition);
  }
  sent: { method: string; params?: Record<string, unknown> }[] = [];
  url = '';
  value = '';
  entries: { id: number; url: string; title: string }[] = [];
  private listeners = new Set<(e: HostEvent) => void>();
  open(t: HostTab) {
    if (!t.url || !t.load) return;
    this.go(t.id, t.url);
  }
  private go(id: string, url: string) {
    this.url = url;
    this.entries.push({ id: this.entries.length + 1, url, title: `Title of ${new URL(url).pathname}` });
    // The page loads a moment later, as a real view does.
    setTimeout(() => {
      this.emit({ type: 'loading', id, loading: true });
      this.emit({ type: 'navigated', id, url });
      this.emit({ type: 'loading', id, loading: false });
    }, 5);
  }
  history() {}
  close() {}
  show() {}
  owner: 'agent' | 'master' = 'master';
  setOwner(_id: string, o: 'agent' | 'master') {
    this.owner = o;
  }
  async capture() {
    return { image: 'data:image/png;base64,AAAA', width: 800, height: 600 };
  }
  /** What the pane showed over the page (#306): the caption and the pulse's spot. */
  signals: { caption: string; point: { x: number; y: number } | null }[] = [];
  signal(_id: string, s: { caption: string; point: { x: number; y: number } | null }) {
    this.signals.push(s);
  }
  async send(id: string, method: string, params?: Record<string, unknown>) {
    this.sent.push({ method, ...(params ? { params } : {}) });
    const cur = this.entries.length - 1;
    switch (method) {
      case 'Page.getNavigationHistory':
        return { currentIndex: cur, entries: this.entries };
      case 'Accessibility.getFullAXTree':
        return {
          nodes: [
            { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'page' }, childIds: ['2', '3', '4', '6'], backendDOMNodeId: 1 },
            { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Click me' }, childIds: ['21'], backendDOMNodeId: 5 },
            { nodeId: '21', parentId: '2', role: { value: 'StaticText' }, name: { value: 'Click me' } },
            { nodeId: '3', parentId: '1', role: { value: 'textbox' }, name: { value: 'Name' }, value: { value: this.value }, backendDOMNodeId: 7, properties: [{ name: 'focused', value: { value: true } }] },
            { nodeId: '4', parentId: '1', role: { value: 'generic' }, childIds: ['41'], ignored: false },
            { nodeId: '41', parentId: '4', role: { value: 'StaticText' }, name: { value: `token ${SECRET}` } },
            { nodeId: '6', parentId: '1', role: { value: 'combobox' }, name: { value: 'Size' }, backendDOMNodeId: 9 },
          ],
        };
      case 'Accessibility.getPartialAXTree': {
        const names: Record<number, [string, string]> = { 5: ['button', 'Click me'], 7: ['textbox', 'Name'], 9: ['combobox', 'Size'] };
        const n = names[params?.backendNodeId as number];
        if (!n) throw new Error('No node with given id found');
        return { nodes: [{ nodeId: 'x', role: { value: n[0] }, name: { value: n[1] }, backendDOMNodeId: params!.backendNodeId }] };
      }
      case 'DOM.getContentQuads':
        if (params?.backendNodeId === 404) throw new Error('No node with given id found');
        return { quads: [[10, 20, 110, 20, 110, 60, 10, 60]] };
      case 'DOM.resolveNode':
        return { object: { objectId: 'obj-9' } };
      case 'Runtime.callFunctionOn':
        return { result: { value: null } };
      case 'Input.insertText':
        this.value += String(params!.text);
        return {};
      case 'Page.getLayoutMetrics':
        return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } };
      case 'Page.navigateToHistoryEntry': {
        const i = this.entries.findIndex((h) => h.id === params!.entryId);
        this.entries = this.entries.slice(0, i + 1);
        this.url = this.entries[i]!.url;
        this.emit({ type: 'navigated', id, url: this.url });
        return {};
      }
      case 'Page.captureScreenshot':
        // A 1×1 png.
        return { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' };
      default:
        return {};
    }
  }
  pills: [string, unknown][] = [];
  pill(id: string, p: unknown) {
    this.pills.push([id, p]);
  }
  flashes: [string, string, string | null][] = [];
  async flash(id: string, passage: string, selector: string | null) {
    this.flashes.push([id, passage, selector]);
    return passage !== 'gone';
  }
  on(l: (e: HostEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: HostEvent) {
    for (const l of this.listeners) l(e);
  }
}

class MemoryStore implements SecretStore {
  label = 'test store';
  map = new Map<string, string>();
  names = () => [...this.map.keys()];
  get = (n: string) => this.map.get(n);
  set = (n: string, v: string) => void this.map.set(n, v);
  delete = (n: string) => void this.map.delete(n);
}

const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id, name, input }];
const lastResult = (req: ModelRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b] : []))[0]!;

async function setup(withHost = true) {
  const host = new FakeHost();
  const l = await launch({ dispatch: false, env: {}, ...(withHost ? { browser: host } : {}) });
  const chat = await l.chat();
  const ctx = () => ({ browser: l.engine.browser, chatId: chat.id, workdir: l.workdir, signal: new AbortController().signal });
  const tool = (name: string, input: Record<string, unknown>) => runBrowserTool(name, input, ctx());
  return { ...l, host, chat, tool };
}

describe('browser tools (#298 S7)', () => {
  it('offered only where the engine has a browser host; elsewhere not in the list (and refused by name)', async () => {
    for (const withHost of [true, false]) {
      const store = new MemoryStore();
      const l = await launch({ dispatch: false, env: {}, secrets: store, script: [use('t1', 'browser_snapshot', {}), [{ type: 'text', text: 'ok' }]], ...(withHost ? { browser: new FakeHost() } : {}) });
      const card = l.engine.kanban.create({ title: 'b', assignee: 'atlas' }, 'user');
      l.engine.kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'go' }]);
      l.engine.runner.wake(card.id);
      await l.engine.runner.settled(card.id);
      const names = l.fake.calls[0]!.tools.map((t) => t.name);
      const browserNames = names.filter((n) => n.startsWith('browser_'));
      expect(browserNames).toEqual(withHost ? ['browser_open', 'browser_snapshot', 'browser_act', 'browser_ask'] : []);
      expect(names).toContain('screenshot'); // unchanged
      const r = lastResult(l.fake.calls[1]!);
      expect(r.content).toBe(withHost ? "No page is open in this chat's browser: browser_open a URL first." : 'unknown tool browser_snapshot');
      expect(r.is_error).toBe(true);
    }
  });

  it('a run: browser_open returns the snapshot with refs; secret values on the page are hidden (rule 5)', async () => {
    const store = new MemoryStore();
    const host = new FakeHost();
    const l = await launch({ dispatch: false, env: {}, secrets: store, browser: host, script: [use('t1', 'browser_open', { url: 'http://127.0.0.1:5173/login' }), [{ type: 'text', text: 'ok' }]] });
    expect((await l.call('POST', '/secrets', { name: 'TOK', value: SECRET, grant: 'none' })).status).toBe(201);
    const card = l.engine.kanban.create({ title: 'b', assignee: 'atlas' }, 'user');
    l.engine.kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'go' }]);
    l.engine.runner.wake(card.id);
    await l.engine.runner.settled(card.id);
    const r = lastResult(l.fake.calls[1]!);
    expect(r.is_error).toBeUndefined();
    expect(r.content).toContain('Page: Title of /login\nURL: http://127.0.0.1:5173/login');
    expect(r.content).toContain('- button "Click me" [ref=5]');
    expect(r.content).toContain('- textbox "Name" [ref=7] focused');
    expect(r.content).toContain('[secret TOK]');
    expect(r.content).not.toContain(SECRET);
    // The agent opened it: the agent has the input.
    expect(l.engine.browser.get(card.id)).toMatchObject({ owner: 'agent', url: 'http://127.0.0.1:5173/login' });
  });

  it('act: click at the middle of the ref’s box, type, press, select, scroll, back; each returns the new snapshot', async () => {
    const l = await setup();
    await l.tool('browser_open', { url: 'http://localhost:3000/a' });
    await l.tool('browser_open', { url: 'http://localhost:3000/b' });
    l.host.sent = [];
    const click = await l.tool('browser_act', { action: 'click', ref: 5 });
    expect(click.isError).toBe(false);
    expect(click.output).toContain('URL: http://localhost:3000/b');
    expect(l.host.sent.filter((s) => s.method === 'Input.dispatchMouseEvent').map((s) => s.params)).toEqual([
      { type: 'mouseMoved', x: 60, y: 40 },
      { type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 60, y: 40, button: 'left', clickCount: 1 },
    ]);
    const typed = await l.tool('browser_act', { action: 'type', ref: 7, text: 'munih' });
    expect(typed.output).toContain('- textbox "Name" [ref=7] value="munih" focused');
    expect(l.host.sent).toContainEqual({ method: 'DOM.focus', params: { backendNodeId: 7 } });

    l.host.sent = [];
    await l.tool('browser_act', { action: 'press', text: 'Enter' });
    expect(l.host.sent.filter((s) => s.method === 'Input.dispatchKeyEvent').map((s) => s.params)).toEqual([
      { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' },
      { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 },
    ]);
    await l.tool('browser_act', { action: 'select', ref: 9, text: 'Large' });
    expect(l.host.sent).toContainEqual(expect.objectContaining({ method: 'Runtime.callFunctionOn', params: expect.objectContaining({ objectId: 'obj-9', arguments: [{ value: 'Large' }] }) }));
    await l.tool('browser_act', { action: 'scroll', text: 'down' });
    expect(l.host.sent).toContainEqual({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 480 } });
    const back = await l.tool('browser_act', { action: 'back' });
    expect(back.output).toContain('URL: http://localhost:3000/a');
    expect((await l.tool('browser_act', { action: 'back' })).output).toBe('No earlier page to go back to.');

    // Mistakes say what to do.
    expect((await l.tool('browser_act', { action: 'click', ref: 404 })).output).toMatch(/^ref 404 is not on the page \(any more\): take a new browser_snapshot/);
    expect((await l.tool('browser_act', { action: 'click' })).output).toBe('click needs a ref from the snapshot');
    expect((await l.tool('browser_act', { action: 'type', text: '' })).output).toBe('type needs text');
    expect((await l.tool('browser_act', { action: 'press', text: 'Hyper+x' })).output).toContain('unknown modifier Hyper');
    expect((await l.tool('browser_open', { url: 'file:///etc/passwd' })).output).toContain('file: addresses never open');
  });

  it('the pane shows each action (#306): a caption naming the element, the pulse at its middle; never the typed text', async () => {
    const l = await setup();
    await l.tool('browser_open', { url: 'http://localhost:5173/tenders' });
    await l.tool('browser_act', { action: 'click', ref: 5 });
    await l.tool('browser_act', { action: 'type', ref: 7, text: 'hunter2' });
    await l.tool('browser_act', { action: 'press', text: 'Enter' });
    await l.tool('browser_act', { action: 'select', ref: 9, text: 'Large' });
    await l.tool('browser_act', { action: 'scroll', text: 'down' });
    expect(l.host.signals).toEqual([
      { caption: 'atlas opened localhost:5173/tenders', point: null },
      { caption: 'atlas clicked « Click me »', point: { x: 60, y: 40 } },
      { caption: 'atlas typed in « Name »', point: { x: 60, y: 40 } },
      { caption: 'atlas pressed « Enter »', point: null },
      { caption: 'atlas selected « Size »', point: { x: 60, y: 40 } },
      { caption: 'atlas scrolled « down »', point: null },
    ]);
    expect(JSON.stringify(l.host.signals)).not.toContain('hunter2');
    expect(JSON.stringify(l.engine.browser.get(l.chat.id))).not.toContain('hunter2');
    expect(l.engine.browser.get(l.chat.id)!.action).toMatchObject({ verb: 'scrolled' });
  });

  it('browser_ask: the pane says why, Master gets the input at once; handing back clears it and the agent reads the page', async () => {
    const l = await setup();
    await l.tool('browser_open', { url: 'https://github.com/login' });
    const r = await l.tool('browser_ask', { why: 'sign in to github.com' });
    expect(r.isError).toBe(false);
    expect(r.output).toContain('Stop here and wait');
    expect(l.engine.browser.get(l.chat.id)).toMatchObject({ owner: 'master', needs: 'sign in to github.com' });
    expect(l.host.owner).toBe('master');
    expect(await l.tool('browser_snapshot', {})).toEqual({ output: BUSY, isError: true });
    await l.call('POST', `/browser/tabs/${l.chat.id}/owner`, { owner: 'agent' });
    expect(l.engine.browser.get(l.chat.id)!.needs).toBeNull();
    expect((await l.tool('browser_snapshot', {})).output.startsWith(HANDED_BACK)).toBe(true);
  });

  it('snapshot with image: a screenshot saved in the workspace and returned as a picture', async () => {
    const l = await setup();
    await l.tool('browser_open', { url: 'http://localhost:3000/' });
    const r = await l.tool('browser_snapshot', { image: true });
    expect(r.isError).toBe(false);
    expect(r.output).toMatch(/Screenshot saved: screenshots\/browser-.*\.png/);
    expect(r.images).toHaveLength(1);
  });

  it('while Master drives: « Master is using the browser » at once, nothing sent; after hand back: that line and a fresh snapshot, the action not done', async () => {
    const l = await setup();
    await l.tool('browser_open', { url: 'http://localhost:3000/a' });
    await l.call('POST', `/browser/tabs/${l.chat.id}/owner`, { owner: 'master' });
    l.host.sent = [];
    l.host.signals = [];
    const events: { type: string; tab?: { action: { verb: string; target: string; refused?: boolean } | null } }[] = [];
    l.engine.bus.on((e) => void events.push(e as (typeof events)[number]));
    for (const [name, input] of [
      ['browser_snapshot', {}],
      ['browser_act', { action: 'click', ref: 5 }],
      ['browser_open', { url: 'http://localhost:3000/z' }],
    ] as const) {
      const r = await l.tool(name, input);
      expect(r).toEqual({ output: BUSY, isError: true });
    }
    // Only a read of the element's name, for the pane's caption: no input reached the page.
    expect(l.host.sent.map((s) => s.method)).toEqual(['Accessibility.getPartialAXTree']);
    expect(events.some((e) => e.type === 'browser.updated' && e.tab?.action?.refused && e.tab.action.verb === 'clicked' && e.tab.action.target === 'Click me')).toBe(true);
    expect(l.engine.browser.get(l.chat.id)!.url).toBe('http://localhost:3000/a');
    expect(l.engine.browser.get(l.chat.id)!.action).toMatchObject({ verb: 'opened', target: 'localhost:3000/z', refused: true });
    expect(actionCaption('atlas', l.engine.browser.get(l.chat.id)!.action!)).toBe('atlas tried to open localhost:3000/z: you have control');
    expect(l.host.signals).toEqual([]); // the overlay shows only while the agent drives

    // Master types in the page, then hands back.
    l.host.value = 'typed by Master';
    await l.call('POST', `/browser/tabs/${l.chat.id}/owner`, { owner: 'agent' });
    const r = await l.tool('browser_act', { action: 'click', ref: 5 });
    expect(r.isError).toBe(false);
    expect(r.output.startsWith(HANDED_BACK + '\nPage: Title of /a')).toBe(true);
    expect(r.output).toContain('value="typed by Master"');
    expect(r.output).toContain('Your action was not done');
    expect(l.host.sent.some((s) => s.method === 'Input.dispatchMouseEvent')).toBe(false);
    // Once only: the next call acts.
    const again = await l.tool('browser_act', { action: 'click', ref: 5 });
    expect(again.output).not.toContain(HANDED_BACK);
    expect(l.host.sent.some((s) => s.method === 'Input.dispatchMouseEvent')).toBe(true);
  });
});

describe('snapshot text and keys', () => {
  it('renders roles, names, refs, values and states; plain containers flattened, repeated text dropped', () => {
    const tree = renderAxTree([
      { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2', '5'] },
      { nodeId: '2', parentId: '1', role: { value: 'generic' }, childIds: ['3'] },
      { nodeId: '3', parentId: '2', role: { value: 'link' }, name: { value: 'Docs' }, backendDOMNodeId: 12, childIds: ['4'] },
      { nodeId: '4', parentId: '3', role: { value: 'StaticText' }, name: { value: 'Docs' } },
      { nodeId: '5', parentId: '1', role: { value: 'checkbox' }, name: { value: 'Remember' }, backendDOMNodeId: 13, properties: [{ name: 'checked', value: { value: 'true' } }, { name: 'disabled', value: { value: false } }] },
    ]);
    expect(tree).toBe('- link "Docs" [ref=12]\n- checkbox "Remember" [ref=13] checked');
  });

  it('keys: named, single characters, shortcuts', () => {
    expect(keyEvents('a')[0]).toEqual({ type: 'keyDown', key: 'a', windowsVirtualKeyCode: 65, modifiers: 0, text: 'a' });
    expect(keyEvents('Meta+a')[0]).toEqual({ type: 'rawKeyDown', key: 'a', windowsVirtualKeyCode: 65, modifiers: 4 });
    expect(keyEvents('Tab')[0]).toEqual({ type: 'rawKeyDown', key: 'Tab', windowsVirtualKeyCode: 9, modifiers: 0 });
    expect(() => keyEvents('Banana')).toThrow('unknown key Banana');
  });
});
