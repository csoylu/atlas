/**
 * The ⌘K palette (design §16 « Keyboard »): fuzzy matcher and ranking, pure and tested in palette.test.ts.
 * Palette.tsx builds the items and draws them.
 */

export type Section = 'Artifacts' | 'Chats' | 'Tasks' | 'Navigation' | 'Actions';

export interface PaletteItem {
  id: string;
  section: Section;
  title: string;
  /** Searched too, not highlighted (a path, an agent, « #12 »). */
  keywords?: string;
  /** Card number: « 12 » or « #12 » finds it first. */
  number?: number | null;
  /** Ranked above its section's others (it belongs to the current context). */
  boost?: number;
}

export interface Match {
  score: number;
  /** Indices of the matched characters in the title, for highlighting. */
  hits: number[];
}

const isWordStart = (text: string, i: number) => i === 0 || /[\s\-_/.:#·,()]/.test(text[i - 1]!) || (/[a-z]/.test(text[i - 1]!) && /[A-Z]/.test(text[i]!));

/** One query word against a text: substring (best at a word start), else letters in order. null = no match. */
function matchWord(word: string, text: string): Match | null {
  const t = text.toLowerCase();
  const at = t.indexOf(word);
  if (at >= 0) {
    // Prefer a later occurrence at a word start over an earlier one mid-word.
    let best = at;
    for (let i = at; i >= 0; i = t.indexOf(word, i + 1)) if (isWordStart(text, i)) { best = i; break; }
    const score = 100 + (best === 0 ? 40 : 0) + (isWordStart(text, best) ? 30 : 0) + word.length * 4;
    return { score, hits: Array.from({ length: word.length }, (_, k) => best + k) };
  }
  // Subsequence: each letter after the previous one; runs and word starts score, gaps cost.
  const hits: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of word) {
    const i = t.indexOf(ch, from); // earliest: never misses a match that exists
    if (i < 0) return null;
    const prev = hits[hits.length - 1];
    score += 2 + (prev !== undefined && i === prev + 1 ? 6 : 0) + (isWordStart(text, i) ? 8 : 0) - Math.min(i - from, 10) * 0.5;
    hits.push(i);
    from = i + 1;
  }
  // Letters scattered far apart are noise, not a match.
  const span = hits[hits.length - 1]! - hits[0]! + 1;
  return score >= word.length && span <= Math.max(word.length * 3, 8) ? { score, hits } : null;
}

/**
 * Fuzzy match of a query against a text: every word of the query must match (in any order). Empty query: score 0.
 * Shorter texts win ties.
 */
export function fuzzy(query: string, text: string): Match | null {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, hits: [] };
  let score = 0;
  const hits = new Set<number>();
  for (const w of words) {
    const m = matchWord(w, text);
    if (!m) return null;
    score += m.score;
    m.hits.forEach((h) => hits.add(h));
  }
  return { score: score - text.length * 0.05, hits: [...hits].sort((a, b) => a - b) };
}

/** One item's match: its card number, its title (highlighted), else its keywords (a little lower). */
export function matchItem(item: PaletteItem, query: string): Match | null {
  const q = query.trim();
  const num = /^#?(\d+)$/.exec(q);
  if (num && item.number != null) {
    const n = String(item.number);
    if (n === num[1]) return { score: 1000, hits: [] };
    if (n.startsWith(num[1]!)) return { score: 500 - n.length, hits: [] };
  }
  const t = fuzzy(q, item.title);
  if (t) return t;
  if (!item.keywords) return null;
  // Keywords (path, agent, status) match by whole substrings only: scattered letters across them are noise.
  const hay = (item.title + ' ' + item.keywords).toLowerCase();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.every((w) => hay.includes(w))) return null;
  return { score: words.reduce((n, w) => n + 60 + w.length * 4, 0) - hay.length * 0.05, hits: [] };
}

/** Which sections come first on each screen (the palette is scoped to where you are). */
export function sectionOrder(view: string): Section[] {
  switch (view) {
    case 'chat':
      return ['Artifacts', 'Chats', 'Tasks', 'Navigation', 'Actions'];
    case 'board':
    case 'inbox':
      return ['Tasks', 'Actions', 'Navigation', 'Artifacts', 'Chats'];
    case 'library':
      return ['Artifacts', 'Navigation', 'Actions', 'Tasks', 'Chats'];
    default:
      return ['Navigation', 'Actions', 'Artifacts', 'Tasks', 'Chats'];
  }
}

/** Points a section loses per place down the screen's order, when sections are ordered by their best match. */
const SCOPE = 25;

export interface Group<T extends PaletteItem> {
  section: Section;
  items: { item: T; match: Match }[];
}

/**
 * The palette's result: sections with their matches, best first. Empty query: each section in the given order (items
 * are passed latest first), boosted ones on top, `emptyLimit` per section. With a query: sections ordered by their best
 * match (ties: the screen's order), `limit` per section.
 */
export function rank<T extends PaletteItem>(items: T[], query: string, order: Section[], limit = 6, emptyLimit = 4): Group<T>[] {
  const empty = !query.trim();
  const groups: (Group<T> & { best: number; at: number })[] = order.map((section, at) => {
    const rows = items
      .filter((i) => i.section === section)
      .map((item, n) => ({ item, match: matchItem(item, query), n }))
      .filter((r): r is { item: T; match: Match; n: number } => r.match !== null)
      .sort((a, b) => b.match.score + (b.item.boost ?? 0) - (a.match.score + (a.item.boost ?? 0)) || a.n - b.n)
      .slice(0, empty ? (section === 'Navigation' || section === 'Actions' ? 99 : emptyLimit) : limit)
      .map(({ item, match }) => ({ item, match }));
    const best = rows.length ? Math.max(...rows.map((r) => r.match.score)) : -Infinity;
    return { section, items: rows, best, at };
  });
  return groups
    .filter((g) => g.items.length)
    // With a query, the best match leads, but the screen's own sections get a head start (SCOPE per place).
    .sort((a, b) => (empty ? a.at - b.at : b.best - b.at * SCOPE - (a.best - a.at * SCOPE) || a.at - b.at))
    .map(({ section, items }) => ({ section, items }));
}

/** ↑ / ↓ in the palette: wraps around. */
export const moveSel = (count: number, current: number, dir: 1 | -1) => (count ? (current + dir + count) % count : 0);
