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
  updatedAt: string;
}

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

export const BrowserOpen = z.object({ url: z.string().min(1).max(4000) });
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
