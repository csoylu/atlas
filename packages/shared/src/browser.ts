import { z } from 'zod';

/**
 * The shared browser (#298 §3, S6): one tab per chat or task, persistent, shown in that chat's pane; Master's own pane
 * (MASTER_PANE) for links clicked outside a chat, which no agent drives. Desktop only (an Electron view); a UI opened
 * in a normal web browser opens links in a new tab.
 */

/** The chat id of Master's own pane (links clicked in the Library, Settings, the Inbox). */
export const MASTER_PANE = 'master';

/** Who has the browser: the agent (Master's input is blocked) or Master (the agent's calls are refused). */
export type BrowserOwner = 'agent' | 'master';

export interface BrowserTab {
  chatId: string;
  /** The workspace whose profile and internet level the tab uses; null for Master's own pane. */
  projectId: string | null;
  agentId: string | null;
  /** Last address (null = nothing opened yet). */
  url: string | null;
  title: string;
  owner: BrowserOwner;
  /** Live state of the view (not stored): a page is loading, the last load failed (why), the page crashed. */
  loading: boolean;
  error: string | null;
  crashed: boolean;
  /** The agent has opened or driven this tab (#306): once Master takes it, the bar offers Hand back. */
  agentUsed: boolean;
  /** The agent asked Master to act on the page (a login wall), with why; cleared when Master hands it back (#306). */
  needs: string | null;
  /** How Master opened the page (live, #306): from a link in Atlas or typed; null when the agent opened it. */
  via: 'link' | 'typed' | null;
  /** The agent's last action on the page (live): the tab shows it is driving for a while after. */
  action: BrowserAction | null;
  updatedAt: string;
}

/**
 * One action of the agent on the page (#306), shown as a pulse on the spot and a caption (« paris clicked « Search » »).
 * `target` names what was acted on (an accessible name, a field's label, an address), never a typed value.
 */
export interface BrowserAction {
  verb: 'opened' | 'clicked' | 'typed in' | 'pressed' | 'selected' | 'scrolled' | 'went back';
  target: string;
  /** The spot, in CSS px of the page's viewport (a click, the field typed in); null for actions without one. */
  point: { x: number; y: number } | null;
  at: string;
  /** Master had the input: the action was not done (« paris tried to click « Search »: you have control »). */
  refused?: boolean;
}

/** The caption under the page: « paris clicked « Search » », « paris opened localhost:5173 ». */
export function actionCaption(agent: string, a: Pick<BrowserAction, 'verb' | 'target' | 'refused'>): string {
  const t = a.target.replace(/\s+/g, ' ').trim();
  const shown = t.length > 60 ? t.slice(0, 59).trimEnd() + '…' : t;
  if (a.refused) {
    const what = a.verb === 'opened' ? (shown ? `open ${shown}` : 'open a page') : `${TRIED[a.verb]}${shown ? ` « ${shown} »` : ''}`;
    return `${agent} tried to ${what}: you have control`;
  }
  if (!shown) return `${agent} ${a.verb}`;
  return a.verb === 'opened' ? `${agent} opened ${shown}` : `${agent} ${a.verb} « ${shown} »`;
}
const TRIED: Record<BrowserAction['verb'], string> = {
  opened: 'open',
  clicked: 'click',
  'typed in': 'type in',
  pressed: 'press',
  selected: 'select',
  scrolled: 'scroll',
  'went back': 'go back',
};

/** How long after its last action the agent still counts as driving (live dot, accent edge, pane-button dot). */
export const DRIVING_MS = 20_000;

/** The agent is driving the tab now: it has the input and acted in the last DRIVING_MS. */
export const isDriving = (t: Pick<BrowserTab, 'owner' | 'action'>, now = Date.now()): boolean =>
  t.owner === 'agent' && !!t.action && !t.action.refused && now - Date.parse(t.action.at) < DRIVING_MS;

/** Where the view sits in the window, in CSS px of the Atlas page (the pane's page area). */
export const BrowserBounds = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type BrowserBounds = z.infer<typeof BrowserBounds>;

/** PUT /api/browser/view: the tab on screen and its place; chatId null = no browser on screen. */
export const BrowserView = z.object({ chatId: z.string().min(1).max(100).nullable(), bounds: BrowserBounds.nullable().default(null) });
export type BrowserView = z.infer<typeof BrowserView>;

/**
 * A text selection on the page (#368), read by the host in an isolated world the page can't see: the text, where it
 * starts (CSS px of the viewport), the element it is in, and whether a field has the focus (then Q is the page's).
 */
export const BrowserSelection = z.object({
  text: z.string().min(1).max(20_000),
  rect: z.object({ x: z.number().finite(), y: z.number().finite(), w: z.number().finite(), h: z.number().finite() }),
  selector: z.string().max(1000).nullable(),
  code: z.boolean(),
});
export type BrowserSelection = z.infer<typeof BrowserSelection>;

/**
 * PUT /api/browser/tabs/:chatId/pill: the « Quote Q » pill drawn by Atlas over the page (its own little view, #368),
 * at x, y in CSS px of the Atlas page, in the app's colours; null hides it.
 */
export const BrowserPill = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    /** The app's tokens now (theme and accent are Master's): --raised, --line-2, --text, --accent, --chip, --faint. */
    colors: z.object({ bg: z.string().max(80), border: z.string().max(80), text: z.string().max(80), accent: z.string().max(80), chip: z.string().max(80), faint: z.string().max(80) }),
    /** --font and --mono. */
    sans: z.string().max(300),
    mono: z.string().max(300),
  })
  .nullable();
export type BrowserPill = z.infer<typeof BrowserPill>;

/** POST /api/browser/tabs/:chatId/flash: a quoted passage to light again on the page (#368). */
export const BrowserFlash = z.object({ passage: z.string().min(1).max(20_000), selector: z.string().max(1000).nullable().default(null) });

export const BrowserOpen = z.object({ url: z.string().min(1).max(4000), via: z.enum(['link', 'typed']).default('typed') });

/** What is under a point or in an area of the page (comment mode, #306): CSS px of the viewport. */
export const BrowserInspect = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().nonnegative().default(0),
  h: z.number().finite().nonnegative().default(0),
});
export interface BrowserInspected {
  /** The element under the point (a click), or the element around the area. */
  element: { selector: string; text: string; tag: string; box: { x: number; y: number; w: number; h: number } } | null;
  /** Elements inside the area (an area), at most 12. */
  inside: { selector: string; text: string }[];
  /** The viewport's size, CSS px. */
  viewport: { w: number; h: number };
}

/** A picture of the page as it is now (comment mode freezes the pane on it): a data: URL and its size in CSS px. */
export interface BrowserShot {
  image: string;
  width: number;
  height: number;
}
export const BrowserNav = z.object({ action: z.enum(['back', 'forward', 'reload', 'stop']) });
export const BrowserSetOwner = z.object({ owner: z.enum(['agent', 'master']) });

/** GET /api/browser: whether this engine has a browser (the desktop app) and, if not, why. */
export interface BrowserStatus {
  available: boolean;
  reason: string | null;
}

/** The workspace's internet setting refused the page (engine network.ts: OFFLINE, notAllowed): the pane says why. */
export const networkRefusal = (error: string | null): 'offline' | 'host' | null =>
  !error || !error.endsWith('(Settings → Workspaces)') ? null : error.startsWith('This workspace is offline') ? 'offline' : 'host';

/** Files Atlas never opens in the pane: they download, in the system browser. */
const DOWNLOAD = /\.(dmg|pkg|zip|tar|gz|tgz|bz2|xz|7z|rar|exe|msi|deb|rpm|appimage|iso)$/i;

/** Sign-in pages of model and plan accounts (OAuth): they must run in the system browser, with Master's own logins. */
const LOGIN: { host: RegExp; path?: RegExp }[] = [
  { host: /^auth\.openai\.com$/ },
  { host: /^(claude\.ai|console\.anthropic\.com)$/, path: /^\/(oauth|login)/ },
  { host: /^accounts\.google\.com$/ },
  { host: /^github\.com$/, path: /^\/(login|session)(\/|$)/ },
];

/**
 * A file Atlas serves from a workspace (`/api/files/<root>/<path>`, #339): its root (`<agent>` or `<agent>@<project>`)
 * and its path, decoded; null for any other address. `appOrigin`: the app's own origin (the file must be on it).
 */
export function servedFile(href: string, appOrigin?: string): { root: string; path: string } | null {
  let u: URL;
  try {
    u = new URL(href, appOrigin);
  } catch {
    return null;
  }
  if (appOrigin && u.origin !== new URL(appOrigin).origin) return null;
  const m = /^\/api\/files\/([^/]+)\/(.+)$/.exec(u.pathname);
  if (!m) return null;
  try {
    const path = m[2]!.split('/').map(decodeURIComponent).join('/');
    return path.split('/').every((s) => s && s !== '.' && s !== '..') ? { root: decodeURIComponent(m[1]!), path } : null;
  } catch {
    return null; // a malformed %-escape: not a file link
  }
}

/**
 * Where a link clicked in Atlas opens (#298 §3.2): `pane` (the chat's pane, or Master's own outside a chat), `external`
 * (the system browser: ⌘-click, non-http schemes, file://, downloads, sign-in flows), `file` (a workspace file Atlas
 * serves, #339: the side panel shows it) or `app` (an Atlas route: the app handles it).
 */
export function linkTarget(href: string, o: { meta?: boolean; appOrigin?: string } = {}): 'pane' | 'external' | 'file' | 'app' {
  let u: URL;
  try {
    u = new URL(href, o.appOrigin);
  } catch {
    return 'app';
  }
  if (o.appOrigin && u.origin === new URL(o.appOrigin).origin) return !o.meta && servedFile(u.href, o.appOrigin) ? 'file' : 'app';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'external';
  if (o.meta) return 'external';
  if (DOWNLOAD.test(u.pathname) || /\/releases\/download\//.test(u.pathname)) return 'external';
  const host = u.hostname.toLowerCase();
  if (LOGIN.some((l) => l.host.test(host) && (!l.path || l.path.test(u.pathname)))) return 'external';
  return 'pane';
}

/**
 * The Atlas window asked to load `target` in place of the app at `appUrl` (#339): `stay` (the app's own page, a
 * reload), `external` (an http(s) page or a file Atlas serves: the system browser shows it) or `refuse` (any other
 * scheme). The window never leaves the app: only `stay` lets the navigation happen.
 */
export function appNavigation(target: string, appUrl: string): 'stay' | 'external' | 'refuse' {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return 'refuse';
  }
  const app = new URL(appUrl);
  if (u.origin === app.origin && u.pathname === app.pathname && u.search === app.search) return 'stay';
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? 'external' : 'refuse';
}

/** An address as typed (« localhost:5173/x », « github.com »): http:// for local hosts, https:// otherwise. */
export function normalizeAddress(typed: string): string {
  const t = typed.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(mailto|tel|data|javascript|about):/i.test(t)) return t;
  return (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(t) ? 'http://' : 'https://') + t;
}

/** Only http(s) pages open in the pane; anything else is refused with this reason (or null when fine). */
export function paneUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `not a web address: ${url.slice(0, 200)}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${u.protocol} addresses never open in the browser pane (only http and https)`;
  return null;
}
