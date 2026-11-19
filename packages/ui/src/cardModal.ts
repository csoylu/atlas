import { CARD_REF_RE, docKindOf, parseCardRef, type Card, type DocKind, type Run, type TodoItem } from '@atlas/shared';

/**
 * Pure helpers for the task view (CardView): the `?card=` hash parameter that opens it beside any view, the live
 * status pill, dangerous tool calls (drawn red in the activity) and card ids in system lines.
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

/**
 * An artifact an agent created, updated or showed (artifact_create / artifact_update / panel_open, #120), read from the
 * tool's result line « created|updated|unchanged|opened Title (doc_x, path, vN) … »: the chat shows it as a card that
 * stays on that version.
 */
export interface Artifact {
  docId: string;
  version: number;
  title: string;
  /** Workspace path. */
  where: string;
  kind: DocKind;
  section: string | null;
  /** artifact_update made this version: the card says « Updated to vN ». */
  updated: boolean;
}
const ARTIFACT_TOOLS = new Set(['artifact_create', 'artifact_update', 'panel_open']);
export function artifactOf(name: string, input: unknown, result: string | undefined): Artifact | null {
  if (!ARTIFACT_TOOLS.has(name) || !result) return null;
  const m = /^(created|updated|unchanged|opened) (.*) \((doc_[\w-]+), ([^()]+), v(\d+)\)/.exec(result);
  if (!m) return null;
  const where = m[4]!;
  const kind = docKindOf(where) ?? 'markdown';
  const section = input && typeof input === 'object' && typeof (input as { section?: unknown }).section === 'string' ? (input as { section: string }).section : null;
  return { docId: m[3]!, version: Number(m[5]), title: m[2]!, where, kind, section, updated: m[1] === 'updated' };
}
