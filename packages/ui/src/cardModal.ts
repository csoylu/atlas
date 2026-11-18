import { CARD_REF_RE, parseCardRef, type Card, type Run, type TodoItem } from '@atlas/shared';

/**
 * Pure helpers for the ticket modal (CardModal): the `?card=` hash parameter that opens it over any view, the live
 * status pill, dangerous tool calls (drawn red in the activity), card ids in system lines, and the focus trap.
 */

/** "#/chat/c_1?card=c_2" → { path: "#/chat/c_1", card: "c_2" }. */
export function splitHash(hash: string): { path: string; card: string | null } {
  const q = hash.indexOf('?');
  if (q < 0) return { path: hash, card: null };
  const card = new URLSearchParams(hash.slice(q + 1)).get('card');
  return { path: hash.slice(0, q), card: card || null };
}

/** The same hash with the modal opened on `card` (or closed for null). */
export function withCard(hash: string, card: string | null): string {
  const { path } = splitHash(hash);
  const base = path || '#/board';
  return card ? `${base}?card=${encodeURIComponent(card)}` : base;
}

export type PillStatus = Card['status'] | 'stopped';

/** What the pill says: the card's status, except a card blocked by the user's Stop reads "stopped". */
export function pillStatus(card: Pick<Card, 'status' | 'block'>, run: Pick<Run, 'status'> | null): PillStatus {
  if (card.status === 'blocked' && run?.status === 'stopped') return 'stopped';
  if (card.status === 'blocked' && card.block?.reason.startsWith('Stopped by you')) return 'stopped';
  return card.status;
}

/** The task view's status as a coloured chip (#104): Working, Blocked, Done; null keeps the neutral pill. */
export function statusChip(status: PillStatus): { kind: 'working' | 'blocked' | 'done'; label: string } | null {
  if (status === 'running') return { kind: 'working', label: 'Working' };
  if (status === 'blocked') return { kind: 'blocked', label: 'Blocked' };
  if (status === 'done') return { kind: 'done', label: 'Done' };
  return null;
}

const DANGEROUS_COMMANDS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, // rm -rf, rm -r, rm -f …
  /\bgit\s+push\b[^\n]*\s(--force\b|--force-with-lease\b|-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+[^\n]*\bof=/,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
  /\b(curl|wget)\b[^|\n]*\|\s*(ba|z)?sh\b/,
  /\bkill(all)?\s+-9\b/,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  />\s*\/dev\/(sd|disk)/,
];
const DANGEROUS_PATHS = /(^|\/)\.ssh\/|^\/etc\/|^\/usr\/|^\/System\//;

/** A tool call worth noticing before it finishes: destructive shell commands, writes to system or ssh paths. */
export function isDangerous(name: string, input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const o = input as Record<string, unknown>;
  if (name === 'shell' && typeof o.command === 'string') return DANGEROUS_COMMANDS.some((r) => r.test(o.command as string));
  if ((name === 'write_file' || name === 'edit_file') && typeof o.path === 'string') return DANGEROUS_PATHS.test(o.path.replace(/^~/, ''));
  return false;
}

/** The card a reference names ("#12", "12" or an id), among the cards the UI has. */
export function findCard(cards: Card[], ref: string): Card | undefined {
  const p = parseCardRef(ref);
  if (!p) return undefined;
  return 'number' in p ? cards.find((c) => c.number === p.number) : cards.find((c) => c.id === p.id);
}

/** Split text on card references (#12, or old c_ + 8 hex ids) so they can be links: ["Card ", {card:"#12"}, " done"]. */
export function linkCardIds(text: string): (string | { card: string })[] {
  const out: (string | { card: string })[] = [];
  const re = new RegExp(CARD_REF_RE.source, 'g');
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push({ card: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Focus trap: where Tab (or Shift+Tab) goes from `current` among the modal's focusable elements; null = let it be. */
export function trapFocus<T>(items: T[], current: T | null, back: boolean): T | null {
  if (!items.length) return null;
  const i = current === null ? -1 : items.indexOf(current);
  if (i < 0) return back ? items[items.length - 1]! : items[0]!;
  if (back && i === 0) return items[items.length - 1]!;
  if (!back && i === items.length - 1) return items[0]!;
  return null;
}

/** Prefix of the hrefs linkCardRefsMd writes: "#card:#12". */
export const CARD_HREF = '#card:';

/**
 * Markdown with the card references that `known` accepts turned into links ([#12](#card:#12)), leaving code, existing
 * links and html tags alone. A message renderer opens CARD_HREF links as cards.
 */
export function linkCardRefsMd(md: string, known: (ref: string) => boolean): string {
  const skip = /```[\s\S]*?(?:```|$)|`[^`\n]*`|!?\[[^\]]*\]\([^)]*\)|<[^>\n]+>|https?:\/\/\S+/g;
  const ref = new RegExp(CARD_REF_RE.source, 'g');
  const link = (t: string) => t.replace(ref, (m) => (known(m) ? `[${m}](${CARD_HREF}${encodeURIComponent(m)})` : m));
  let out = '';
  let last = 0;
  for (let m = skip.exec(md); m; m = skip.exec(md)) {
    out += link(md.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + link(md.slice(last));
}

/**
 * A #N reference inside running text (#140) shows as plain « #N »; the title and status live in the hover title and
 * the accessible name instead of a chip. `status` is the status's display label.
 */
export function proseRefLabel(ref: string, card?: { title: string; status: string }): { title: string; label: string } {
  if (!card) return { title: 'Open the task', label: `${ref}: open the task` };
  return { title: `${ref} ${card.title} · ${card.status}`, label: `${ref} ${card.title}, ${card.status}: open the task` };
}

/** todo_write({ todos }) → its list, or null if the input isn't one (then it shows as a plain tool line). */
export function todoList(input: unknown): TodoItem[] | null {
  const todos = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return null;
  const ok = (t: unknown): t is TodoItem =>
    !!t && typeof (t as TodoItem).content === 'string' && ['pending', 'in_progress', 'completed'].includes((t as TodoItem).status);
  return todos.every(ok) ? todos : null;
}

/** A document an agent showed with panel_open, read from the tool's result line: the chat shows it as a chip. */
export interface Artifact {
  docId: string;
  version: number;
  title: string;
  /** Workspace path, or « canvas <id> » for a whiteboard. */
  where: string;
  kind: 'doc' | 'page' | 'diagram' | 'whiteboard';
  section: string | null;
}
export function artifactOf(name: string, input: unknown, result: string | undefined): Artifact | null {
  if (name !== 'panel_open' || !result) return null;
  // « opened <title> (doc_x, <path | canvas id>, vN) in the side panel… » or « <title> (…) is indexed… »
  const m = /^(?:opened )?(.*) \((doc_[\w-]+), ([^()]+), v(\d+)\)/.exec(result);
  if (!m) return null;
  const where = m[3]!;
  const kind = where.startsWith('canvas ') ? 'whiteboard' : /\.html?$/i.test(where) ? 'page' : /\.svg$/i.test(where) ? 'diagram' : 'doc';
  const section = input && typeof input === 'object' && typeof (input as { section?: unknown }).section === 'string' ? (input as { section: string }).section : null;
  return { docId: m[2]!, version: Number(m[4]), title: m[1]!, where, kind, section };
}
