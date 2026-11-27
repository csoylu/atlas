import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ImageBlock } from '@atlas/shared';
import type { ToolSpec } from './providers/types.ts';
import type { BrowserAction } from '@atlas/shared';
import { BrowserBusyError, type Browser } from './browser.ts';
import { describeImage, imageLine } from './images.ts';
import { specsOf } from './toolSpec.ts';
import { headTail } from './web.ts';

/**
 * The agent's browser tools (#298 §3.3, S7): the chat's own tab in the shared browser (browser.ts), driven over CDP
 * through the same path as Master's input. Each call returns the page as a snapshot: the accessibility tree, one
 * `[ref=N]` per element (N = the element's backend DOM node id, stable while the page lives). Offered only where the
 * engine has a BrowserHost (the desktop app); elsewhere the tools are not in the list.
 *
 * Input owner: while Master has the browser, every call answers « Master is using the browser » at once. The first
 * call after Master hands it back starts with « Master handed back the browser » and the page as Master left it; an
 * action is not done then (its ref came from a page Master may have changed).
 */

export interface BrowserToolContext {
  browser: Browser;
  /** The chat or task whose tab this is. */
  chatId: string;
  workdir: string;
  signal: AbortSignal;
  /** Hides secret values before the snapshot is cut (#227); the runner redacts the whole output again. */
  redact?: (text: string) => string;
}

/** A snapshot longer than this is cut in the middle. */
export const SNAPSHOT_CHARS = 20_000;
/** A click's navigation starts a moment after the click: the snapshot waits this long before reading the page. */
const ACT_GRACE_MS = 300;
export const BUSY = 'Master is using the browser. Your next browser call after they hand it back gets the page as they left it.';
export const HANDED_BACK = 'Master handed back the browser; the page is now:';

const SPECS = {
  browser_open: {
    description: "Open a URL in this chat's browser tab; returns the page snapshot.",
    input: z.object({ url: z.string().min(1).max(4000) }),
  },
  browser_snapshot: {
    description: "This chat's browser page: title, URL, accessibility tree with [ref=N].",
    input: z.object({ image: z.boolean().default(false).describe('add a screenshot') }),
  },
  browser_act: {
    description: 'Act on the page like a user, then return the new snapshot.',
    input: z.object({
      action: z.enum(['click', 'type', 'press', 'select', 'scroll', 'back']),
      ref: z.number().int().positive().optional().describe('element from the snapshot (click, select; type: focus it first)'),
      text: z.string().max(10_000).optional().describe('type: the text; press: a key (Enter, Tab, Meta+a); select: option label or value; scroll: up or down'),
    }),
  },
  browser_ask: {
    description:
      "Ask Master to act on the page themselves (sign in, a captcha, a payment): the pane shows why with Take control. Then stop and wait: in a task, task_block needs_input; your next browser call after they hand back gets the page.",
    input: z.object({ why: z.string().min(1).max(300).describe('what Master should do, e.g. « sign in to github.com »') }),
  },
} as const;

export const isBrowserTool = (name: string): boolean => name in SPECS;
export const browserToolSpecs = (): ToolSpec[] => specsOf(SPECS);

type Input<N extends keyof typeof SPECS> = z.infer<(typeof SPECS)[N]['input']>;

/** One browser tool call. Errors come back as is_error results; a busy browser too. */
export async function runBrowserTool(name: string, raw: unknown, ctx: BrowserToolContext): Promise<{ output: string; isError: boolean; images?: ImageBlock[] }> {
  const spec = (SPECS as Record<string, { input: z.ZodType }>)[name];
  if (!spec) return { output: `unknown tool ${name}`, isError: true };
  const parsed = spec.input.safeParse(raw);
  if (!parsed.success) return { output: `invalid input for ${name}: ${parsed.error.message}`, isError: true };
  try {
    return { ...(await call(name as keyof typeof SPECS, parsed.data, ctx)), isError: false };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    if (e instanceof BrowserBusyError) return { output: BUSY, isError: true };
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}

async function call(name: keyof typeof SPECS, input: unknown, ctx: BrowserToolContext): Promise<{ output: string; images?: ImageBlock[] }> {
  const { browser, chatId } = ctx;
  const tab = browser.get(chatId);
  if (tab?.owner === 'master') {
    // At once, nothing done; the pane says what the agent tried (#306 « Master has control »).
    if (name === 'browser_open' || name === 'browser_act') browser.acted(chatId, await tried(ctx, name, input));
    throw new BrowserBusyError();
  }
  const back = !!tab && browser.takeHandBack(chatId);
  if (name === 'browser_open') {
    const { url } = input as Input<'browser_open'>;
    const left = back ? `${HANDED_BACK} ${tab!.url ?? 'no page'}${tab!.title ? ` (${tab!.title})` : ''}. Now opening ${url}:\n` : '';
    const opened = browser.open(chatId, url, 'agent');
    browser.acted(chatId, { verb: 'opened', target: shortUrl(opened.url ?? url), point: null });
    return snapshot(ctx, false, left);
  }
  if (name === 'browser_ask') {
    // Master gets the input at once (the pane's banner says why); the agent waits for the hand-back.
    browser.ask(chatId, (input as Input<'browser_ask'>).why);
    browser.setOwner(chatId, 'master');
    return { output: 'Master was asked and now has the browser. Stop here and wait (in a task: task_block needs_input saying what you asked); your next browser call after they hand it back gets the page as they left it.' };
  }
  if (!tab?.url) throw new Error("No page is open in this chat's browser: browser_open a URL first.");
  if (back) {
    const note = name === 'browser_act' ? '\n\n(Your action was not done: the page may have changed. Act again from this snapshot if still needed.)' : '';
    const r = await snapshot(ctx, name === 'browser_snapshot' && (input as Input<'browser_snapshot'>).image, HANDED_BACK + '\n');
    return { ...r, output: r.output + note };
  }
  if (name === 'browser_snapshot') return snapshot(ctx, (input as Input<'browser_snapshot'>).image, '');
  const o = input as Input<'browser_act'>;
  // What the pane shows is read first: after a click the element may be gone (a new page).
  const seen = await shown(ctx, o);
  const done = await act(ctx, o);
  browser.acted(chatId, seen);
  return snapshot(ctx, false, done ? done + '\n' : '', ACT_GRACE_MS);
}

/** What a refused call would have done, for the pane's caption: the element's name read without touching the page. */
async function tried(ctx: BrowserToolContext, name: 'browser_open' | 'browser_act', input: unknown): Promise<Omit<BrowserAction, 'at'>> {
  if (name === 'browser_open') return { verb: 'opened', target: shortUrl((input as Input<'browser_open'>).url), point: null, refused: true };
  const o = input as Input<'browser_act'>;
  let target = o.action === 'press' ? (o.text ?? '') : '';
  if (o.ref !== undefined && o.action !== 'press' && o.action !== 'back') {
    // A read (no input) as Master's side: the agent's own calls are refused now. A page that can't answer: no name.
    const r = await untilAborted(ctx.browser.cdp(ctx.chatId, 'Accessibility.getPartialAXTree', { backendNodeId: o.ref, fetchRelatives: false }, 'master'), ctx.signal).then(
      (v) => v as { nodes: AxNode[] },
      () => ({ nodes: [] as AxNode[] }),
    );
    target = String(r.nodes.find((x) => x.backendDOMNodeId === o.ref)?.name?.value ?? '').trim();
  }
  return { verb: VERB[o.action], target, point: null, refused: true };
}

/** « localhost:5173/tenders », for the caption. */
const shortUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

const VERB = { click: 'clicked', type: 'typed in', press: 'pressed', select: 'selected', scroll: 'scrolled', back: 'went back' } as const;

/**
 * The pane shows the action (#306): a pulse on the element, a caption naming it (its accessible name; for a key, the
 * key). Never the typed text or the chosen value: « paris typed in « Password » ».
 */
async function shown(ctx: BrowserToolContext, o: Input<'browser_act'>): Promise<Omit<BrowserAction, 'at'>> {
  let target = o.action === 'press' ? (o.text ?? '') : '';
  let point: { x: number; y: number } | null = null;
  if (o.ref !== undefined && o.action !== 'back') {
    const ref = o.ref;
    await ctx.browser.settle(ctx.chatId, { signal: ctx.signal }); // the debugger attaches only after the first load
    const { nodes } = await onNode(ctx, ref, () => cdp<{ nodes: AxNode[] }>(ctx, 'Accessibility.getPartialAXTree', { backendNodeId: ref, fetchRelatives: false }));
    const n = nodes.find((x) => x.backendDOMNodeId === o.ref) ?? nodes[0];
    const name = String(n?.name?.value ?? '').trim();
    if (o.action !== 'press') target = name || String(n?.role?.value ?? '');
    if (o.action !== 'scroll') point = await center(ctx, ref);
  }
  return { verb: VERB[o.action], target: o.action === 'scroll' ? (o.text ?? 'down').trim() : target, point };
}

/**
 * CDP on the chat's tab, as the agent (refused while Master has it). A page that never answers (a dialog, a frozen
 * renderer) no longer holds the run: a stop or the engine's shutdown ends the wait (#375).
 */
const cdp = <T = Record<string, unknown>>(ctx: BrowserToolContext, method: string, params?: Record<string, unknown>) =>
  untilAborted(ctx.browser.cdp(ctx.chatId, method, params, 'agent') as Promise<T>, ctx.signal);

/** `p`, or the signal's reason as soon as it aborts (the CDP call itself has no signal). */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  return new Promise<T>((ok, fail) => {
    const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(ok, fail).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Does the action; returns a line to put above the snapshot, or ''. */
async function act(ctx: BrowserToolContext, o: Input<'browser_act'>): Promise<string> {
  await ctx.browser.settle(ctx.chatId, { signal: ctx.signal }); // the debugger attaches only after the first load
  const needRef = () => {
    if (o.ref === undefined) throw new Error(`${o.action} needs a ref from the snapshot`);
    return o.ref;
  };
  const needText = () => {
    if (!o.text) throw new Error(`${o.action} needs text`);
    return o.text;
  };
  switch (o.action) {
    case 'click': {
      const { x, y } = await center(ctx, needRef());
      await cdp(ctx, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      for (const type of ['mousePressed', 'mouseReleased']) await cdp(ctx, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      return '';
    }
    case 'type': {
      const text = needText();
      if (o.ref !== undefined) await onNode(ctx, o.ref, () => cdp(ctx, 'DOM.focus', { backendNodeId: o.ref }));
      await cdp(ctx, 'Input.insertText', { text });
      return '';
    }
    case 'press': {
      if (o.ref !== undefined) await onNode(ctx, o.ref, () => cdp(ctx, 'DOM.focus', { backendNodeId: o.ref }));
      for (const e of keyEvents(needText())) await cdp(ctx, 'Input.dispatchKeyEvent', e);
      return '';
    }
    case 'select': {
      const ref = needRef();
      const want = needText();
      const { object } = await onNode(ctx, ref, () => cdp<{ object: { objectId: string } }>(ctx, 'DOM.resolveNode', { backendNodeId: ref }));
      const r = await cdp<{ result: { value?: string | null } }>(ctx, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: SELECT,
        arguments: [{ value: want }],
        returnByValue: true,
      });
      if (r.result.value) throw new Error(r.result.value);
      return '';
    }
    case 'scroll': {
      const dir = (o.text ?? 'down').trim().toLowerCase();
      if (dir !== 'down' && dir !== 'up') throw new Error('scroll text is up or down');
      const m = await cdp<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(ctx, 'Page.getLayoutMetrics');
      const vp = m.cssLayoutViewport;
      const at = o.ref !== undefined ? await center(ctx, o.ref) : { x: vp.clientWidth / 2, y: vp.clientHeight / 2 };
      const dy = Math.round(vp.clientHeight * 0.8) * (dir === 'down' ? 1 : -1);
      await cdp(ctx, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: dy });
      return '';
    }
    case 'back': {
      const h = await cdp<{ currentIndex: number; entries: { id: number }[] }>(ctx, 'Page.getNavigationHistory');
      const prev = h.entries[h.currentIndex - 1];
      if (!prev) throw new Error('No earlier page to go back to.');
      await cdp(ctx, 'Page.navigateToHistoryEntry', { entryId: prev.id });
      return '';
    }
  }
}

const SELECT = `function (want) {
  if (!(this instanceof HTMLSelectElement)) return 'this element is not a select (a list box): click it instead';
  const opt = [...this.options].find((o) => o.label.trim() === want.trim() || o.value === want);
  if (!opt) return 'no option ' + JSON.stringify(want) + '; options: ' + [...this.options].map((o) => JSON.stringify(o.label.trim())).join(', ');
  this.value = opt.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return null;
}`;

/** A CDP call about one element: a ref the page no longer has says so. */
async function onNode<T>(ctx: BrowserToolContext, ref: number, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (ctx.signal.aborted || e instanceof BrowserBusyError) throw e;
    throw new Error(`ref ${ref} is not on the page (any more): take a new browser_snapshot. (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** The middle of an element on screen, scrolled into view first. */
async function center(ctx: BrowserToolContext, ref: number): Promise<{ x: number; y: number }> {
  return onNode(ctx, ref, async () => {
    await cdp(ctx, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: ref });
    const { quads } = await cdp<{ quads: number[][] }>(ctx, 'DOM.getContentQuads', { backendNodeId: ref });
    const q = quads[0];
    if (!q) throw new Error('it has no box on screen');
    return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
  });
}

const KEYS: Record<string, { code: number; text?: string }> = {
  Enter: { code: 13, text: '\r' },
  Tab: { code: 9 },
  Escape: { code: 27 },
  Backspace: { code: 8 },
  Delete: { code: 46 },
  Space: { code: 32, text: ' ' },
  ArrowUp: { code: 38 },
  ArrowDown: { code: 40 },
  ArrowLeft: { code: 37 },
  ArrowRight: { code: 39 },
  Home: { code: 36 },
  End: { code: 35 },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
};
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };

/** « Enter », « a », « Meta+a »: the keyDown and keyUp events of CDP Input.dispatchKeyEvent. */
export function keyEvents(spec: string): Record<string, unknown>[] {
  const parts = spec.split('+');
  const key = parts.length > 1 && parts.at(-1) === '' ? '+' : parts.pop()!;
  let modifiers = 0;
  for (const m of parts.filter(Boolean)) {
    const bit = MODIFIERS[m];
    if (bit === undefined) throw new Error(`unknown modifier ${m} (Alt, Control, Meta, Shift)`);
    modifiers |= bit;
  }
  const named = KEYS[key];
  if (!named && [...key].length !== 1) throw new Error(`unknown key ${key}: a single character or one of ${Object.keys(KEYS).join(', ')}`);
  const code = named ? named.code : key.toUpperCase().charCodeAt(0);
  const name = key === 'Space' ? ' ' : key;
  // A character typed with Control/Meta/Alt is a shortcut, not text.
  const text = (named ? named.text : key) ?? undefined;
  const printable = text !== undefined && !(modifiers & (1 | 2 | 4));
  const base = { key: name, windowsVirtualKeyCode: code, modifiers };
  return [
    { type: printable ? 'keyDown' : 'rawKeyDown', ...base, ...(printable ? { text } : {}) },
    { type: 'keyUp', ...base },
  ];
}

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** Roles that say nothing by themselves: their children are shown in their place. */
const PLAIN = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'RootWebArea', 'WebArea', 'GenericContainer', 'Section']);
const STATES = ['checked', 'selected', 'expanded', 'pressed', 'disabled', 'focused', 'required', 'invalid', 'level'];

/** The accessibility tree as indented lines: `- role "name" [ref=N] value=… states`. */
export function renderAxTree(nodes: AxNode[]): string {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId || !byId.has(n.parentId));
  if (!root) return '(empty page)';
  const lines: string[] = [];
  const walk = (n: AxNode, depth: number, parentName: string) => {
    const role = n.role?.value ?? '';
    const name = String(n.name?.value ?? '').replace(/\s+/g, ' ').trim();
    let shown = false;
    if (!n.ignored) {
      if (role === 'StaticText') {
        if (name && !parentName.split('\n').some((said) => said.includes(name))) lines.push(`${'  '.repeat(depth)}- text ${JSON.stringify(name)}`);
        return; // its InlineTextBox children repeat it
      }
      if (role !== 'RootWebArea' && role !== 'WebArea' && (!PLAIN.has(role) || name)) {
        const value = n.value?.value;
        const states = (n.properties ?? [])
          .filter((p) => STATES.includes(p.name) && p.value.value !== false && p.value.value !== undefined && p.value.value !== 'false')
          .map((p) => (p.value.value === true || p.value.value === 'true' ? p.name : `${p.name}=${String(p.value.value)}`));
        const bits = [
          `- ${PLAIN.has(role) ? 'group' : role}`,
          name ? JSON.stringify(name) : '',
          n.backendDOMNodeId ? `[ref=${n.backendDOMNodeId}]` : '',
          value !== undefined && value !== '' && String(value) !== name ? `value=${JSON.stringify(String(value))}` : '',
          ...states,
        ].filter(Boolean);
        lines.push('  '.repeat(depth) + bits.join(' '));
        shown = true;
      }
    }
    for (const id of n.childIds ?? []) {
      const c = byId.get(id);
      // A child's text already said by its parent (a button's label, a text box's value) is not repeated.
      if (c) walk(c, shown ? depth + 1 : depth, shown ? `${name}\n${String(n.value?.value ?? '')}` : parentName);
    }
  };
  walk(root, 0, '');
  return lines.length ? lines.join('\n') : '(no readable content)';
}

/** The page as the agent reads it: title, URL, the tab's error if any, the tree (cut if long), a screenshot on demand. */
async function snapshot(ctx: BrowserToolContext, image: boolean, head: string, graceMs = 0): Promise<{ output: string; images?: ImageBlock[] }> {
  const settled = await ctx.browser.settle(ctx.chatId, { graceMs, signal: ctx.signal });
  const tab = ctx.browser.get(ctx.chatId)!;
  const hist = await cdp<{ currentIndex: number; entries: { url: string; title: string }[] }>(ctx, 'Page.getNavigationHistory');
  const cur = hist.entries[hist.currentIndex];
  const { nodes } = await cdp<{ nodes: AxNode[] }>(ctx, 'Accessibility.getFullAXTree');
  const hide = ctx.redact ?? ((t: string) => t);
  const tree = hide(renderAxTree(nodes)); // before the cut (#227)
  const lines = [
    head + `Page: ${cur?.title || tab.title || '(no title)'}`,
    `URL: ${cur?.url ?? tab.url}`,
    ...(tab.error ? [`Error: ${tab.error}`] : []),
    ...(settled ? [] : ['(still loading: the page may change)']),
    '',
    tree.length > SNAPSHOT_CHARS ? headTail(tree, SNAPSHOT_CHARS, `snapshot cut (${tree.length} chars)`) : tree,
  ];
  if (!image) return { output: lines.join('\n') };
  const { data } = await cdp<{ data: string }>(ctx, 'Page.captureScreenshot', { format: 'png' });
  const bytes = Buffer.from(data, 'base64');
  await mkdir(join(ctx.workdir, 'screenshots'), { recursive: true });
  const file = join('screenshots', `browser-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  await writeFile(join(ctx.workdir, file), bytes);
  const img = await describeImage(join(ctx.workdir, file), bytes);
  return { output: `${lines.join('\n')}\n\nScreenshot saved: ${file}\n${imageLine(img)}`, images: [img] };
}
