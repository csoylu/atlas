// The chat's browser tab (#306): the words the pane shows, kept apart from BrowserPane.tsx so they are tested alone.
import type { BrowserTab } from '@atlas/shared';

/** The tab's title in the head row: the page's title, else its host, else « New tab ». */
export function browserTitle(t: Pick<BrowserTab, 'title' | 'url'>): string {
  if (t.title.trim()) return t.title.trim();
  if (!t.url) return 'New tab';
  return hostOf(t.url);
}

/** « localhost:5173 » from an address; the address itself when it is not a full one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url; // not a full address: shown as it is
  }
}

/** The empty tab's recent pages: those of the same agent's other tabs (same profile), latest first, each address once, 4 at most. */
export function recentPages(tabs: BrowserTab[], chatId: string, agent: string | null): BrowserTab[] {
  const seen = new Set<string>();
  return tabs
    .filter((t) => t.chatId !== chatId && !!t.url && (t.agentId ?? null) === agent)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .filter((t) => !seen.has(t.url!) && !!seen.add(t.url!))
    .slice(0, 4);
}

/** When a recent page was last seen: « just now », « today », « yesterday », else the day. */
export function whenText(iso: string, now = Date.now()): string {
  const d = (now - Date.parse(iso)) / 60_000;
  if (d < 60) return 'just now';
  if (d < 24 * 60) return 'today';
  if (d < 48 * 60) return 'yesterday';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
