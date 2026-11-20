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
 * Where a link clicked in Atlas opens (#298 §3.2): `pane` (the chat's pane, or Master's own outside a chat), `external`
 * (the system browser: ⌘-click, non-http schemes, file://, downloads, sign-in flows) or `app` (an Atlas route: the app
 * handles it).
 */
export function linkTarget(href: string, o: { meta?: boolean; appOrigin?: string } = {}): 'pane' | 'external' | 'app' {
  let u: URL;
  try {
    u = new URL(href, o.appOrigin);
  } catch {
    return 'app';
  }
  if (o.appOrigin && u.origin === new URL(o.appOrigin).origin) return 'app';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'external';
  if (o.meta) return 'external';
  if (DOWNLOAD.test(u.pathname) || /\/releases\/download\//.test(u.pathname)) return 'external';
  const host = u.hostname.toLowerCase();
  if (LOGIN.some((l) => l.host.test(host) && (!l.path || l.path.test(u.pathname)))) return 'external';
  return 'pane';
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
