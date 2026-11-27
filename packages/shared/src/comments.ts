import { z } from 'zod';

/*
 * Comment mode (#304, mockup « the right pane as a workbench »): Master clicks a spot or drags an area on the open tab
 * of the pane, writes a comment, and sends one or several with the next message. Each kind of tab only says what is
 * under the point or in the area (an anchor); the engine turns every comment into one text block the model reads
 * (formatComment), stored with the message. The UI shows that block as a card (parseComment); the metadata line is for
 * the agent. It replaces « Ask about this » (❝, formatDocRef): old messages keep rendering through parseDocRef.
 */

const Num = z.number().finite();
const Box = z.object({ x: Num, y: Num, w: Num.nonnegative(), h: Num.nonnegative() });
const Size = z.object({ w: Num.positive(), h: Num.positive() });
/** An element of a page or a diagram: a CSS selector that finds it again, and its text. */
export const CommentShape = z.object({ selector: z.string().min(1).max(600), text: z.string().max(400).default('') });
export type CommentShape = z.infer<typeof CommentShape>;
/** Units of an area or a spot: CSS px of the page (html, a link's frame, an image's natural pixels) or the svg's own (viewBox). */
const Unit = z.enum(['px', 'svg']);

/** What is under the point or in the area, as precise as the kind can tell. */
export const CommentAnchor = z.discriminatedUnion('type', [
  /**
   * Selected text (markdown, or a quote on any pane tab, #368), or a whole markdown block: its section and its source
   * lines when the kind knows them, the element it sits in on a page (html, the browser).
   */
  z.object({
    type: z.literal('text'),
    quote: z.string().trim().min(1).max(20_000),
    section: z.string().max(200).nullable().default(null),
    lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).nullable().default(null),
    selector: z.string().max(600).nullable().default(null),
  }),
  /** An html or svg element that was clicked. */
  z.object({ type: z.literal('element'), selector: z.string().min(1).max(600), text: z.string().max(1000).default(''), tag: z.string().max(40).default('') }),
  /** A dragged area, in the document's own coordinates (`of` = the whole document), and the shapes inside it. */
  z.object({ type: z.literal('area'), box: Box, of: Size, unit: Unit, inside: z.array(CommentShape).max(12).default([]) }),
  /** A click on a spot that is not an element (an image, a link's frame, an empty part of a diagram). */
  z.object({ type: z.literal('spot'), x: Num, y: Num, of: Size, unit: Unit, under: CommentShape.nullable().default(null) }),
  /** Lines of a file (the code tab, workbench 2/5). */
  z.object({ type: z.literal('lines'), from: z.number().int().positive(), to: z.number().int().positive() }),
]);
export type CommentAnchor = z.infer<typeof CommentAnchor>;

/** The tab commented on: an artifact at the version shown, or a file of the agent's workspace. */
export const CommentTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('doc'), docId: z.string().min(1), version: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(1000) }),
  /** The chat's browser (#306): the page at that address, as it was on screen when the comment was picked. */
  z.object({ kind: z.literal('browser'), url: z.string().min(1).max(4000), title: z.string().max(300).default('') }),
]);
export type CommentTarget = z.infer<typeof CommentTarget>;

/**
 * `n`: its number in the message, shared with quotes (#367); absent: its place among the comments. `text`: Master's
 * words; only a selected passage (a quote of a pane tab, #368) may come without them, its note being optional.
 */
export const PostComment = z
  .object({ target: CommentTarget, anchor: CommentAnchor, text: z.string().trim().max(5000).default(''), n: z.number().int().positive().optional() })
  .refine((c) => c.text.length > 0 || c.anchor.type === 'text', { message: 'a comment needs words', path: ['text'] });
export type PostComment = z.infer<typeof PostComment>;
export const COMMENTS_MAX = 20;

const QUOTE_CAP = 80;
const short = (s: string, n = QUOTE_CAP) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
};
const r = (n: number) => String(Math.round(n));
const pct = (v: number, of: number) => `${Math.round((v / of) * 100)} %`;
const range = (a: number, b: number) => (a === b ? `line ${a}` : `lines ${a}–${b}`);

/** The few words a chip and a card show for an anchor: « quote », « text » button, an area around « X », lines 5–6. */
export function anchorLabel(a: CommentAnchor): string {
  switch (a.type) {
    case 'text':
      return `« ${short(a.quote, 40)} »`;
    case 'element': {
      const word = ELEMENT_WORD[a.tag.toLowerCase()];
      const t = short(a.text, 40);
      return t ? `« ${t} »${word ? ' ' + word : ''}` : word ? `a ${word}` : `<${a.tag || 'element'}>`;
    }
    case 'area': {
      const t = a.inside.find((s) => s.text.trim())?.text;
      return t ? `an area around « ${short(t, 30)} »` : 'an area';
    }
    case 'spot':
      return a.under?.text.trim() ? `« ${short(a.under.text, 30)} »` : `a spot at ${pct(a.x, a.of.w)}, ${pct(a.y, a.of.h)}`;
    case 'lines':
      return range(a.from, a.to);
  }
}
const ELEMENT_WORD: Record<string, string> = { button: 'button', a: 'link', input: 'field', textarea: 'field', select: 'menu', img: 'image', table: 'table', tr: 'row', li: 'item', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', p: 'paragraph', text: 'text', rect: 'box', g: 'group' };

/** Where the comment is, for the agent: the kind and the path, the artifact id and version, or the file. */
export interface CommentWhere {
  /** Title shown on the card: the artifact's title or the file's name. */
  title: string;
  /** « markdown docs/plan.md, doc_ab12 v3 », « file packages/ui/src/x.ts », « link links/app.url, doc_x v2, address http://… ». */
  what: string;
}

/** What the engine adds: the quoted source lines, and the cropped picture (or why there is none). */
export interface CommentExtra {
  source?: { from: number; lines: string[] } | null;
  picture?: string | null;
  noPicture?: string | null;
  /** How the area's coordinates read (« of the frame as shown, scroll unknown » for a link's page). */
  coords?: string | null;
}

const SOURCE_CAP = 40;

/**
 * One comment as the model reads it (and as the message stores it):
 *   [comment 1] Plan · « with a changelog… »
 *   (on markdown docs/plan.md, doc_ab12 v3, section #intro, lines 5–5)
 *   Selected: « … » / Element text: « … » / Inside: sel « text »; …
 *   > the source lines
 *   Picture of the area: uploads/…png (attached below)
 *   Comment: the words
 * The first two lines are what parseComment reads back; the rest is for the agent.
 */
export function formatComment(n: number, where: CommentWhere, a: CommentAnchor, text: string, x: CommentExtra = {}): string {
  const unit = (u: 'px' | 'svg') => (u === 'px' ? 'px' : 'svg units');
  const at: string[] = [];
  const body: string[] = [];
  switch (a.type) {
    case 'text':
      if (a.section !== null) at.push(`section #${a.section || 'top'}`);
      if (a.lines) at.push(range(a.lines[0], a.lines[1]));
      if (a.selector) at.push(`in element ${a.selector}`);
      body.push(`Selected: « ${short(a.quote, 20_000)} »`);
      break;
    case 'element':
      at.push(`element ${a.selector}`);
      if (a.text.trim()) body.push(`Element text: « ${short(a.text, 400)} »`);
      break;
    case 'area':
      at.push(`area x=${r(a.box.x)} y=${r(a.box.y)} w=${r(a.box.w)} h=${r(a.box.h)} ${unit(a.unit)} of ${r(a.of.w)}×${r(a.of.h)}${x.coords ? ' ' + x.coords : ''}`);
      if (a.inside.length) body.push('Inside: ' + a.inside.map((s) => s.selector + (s.text.trim() ? ` « ${short(s.text, 60)} »` : '')).join('; '));
      break;
    case 'spot':
      at.push(`spot x=${r(a.x)} y=${r(a.y)} ${unit(a.unit)} of ${r(a.of.w)}×${r(a.of.h)} (${pct(a.x, a.of.w)}, ${pct(a.y, a.of.h)})${x.coords ? ' ' + x.coords : ''}`);
      if (a.under) body.push(`Under it: ${a.under.selector}${a.under.text.trim() ? ` « ${short(a.under.text, 60)} »` : ''}`);
      break;
    case 'lines':
      at.push(range(a.from, a.to));
      break;
  }
  if (x.source?.lines.length) {
    const shown = x.source.lines.slice(0, SOURCE_CAP);
    body.push(...shown.map((l) => '> ' + l));
    if (x.source.lines.length > shown.length) body.push(`> … (${x.source.lines.length - shown.length} more lines)`);
  }
  if (x.picture) body.push(`Picture of the area: ${x.picture} (attached below)`);
  else if (x.noPicture) body.push(`No picture: ${x.noPicture}`);
  const head = `[comment ${n}] ${where.title} · ${anchorLabel(a)}\n(on ${where.what}${at.length ? ', ' + at.join(', ') : ''})`;
  // A quoted passage with no note (#368) has no Comment line.
  return [head, ...body, ...(text.trim() ? [`Comment: ${text.trim()}`] : [])].join('\n');
}

/** A comment block read back for its card: what it shows, and where a click opens. */
export interface ParsedComment {
  n: number;
  /** « Title · anchor ». */
  label: string;
  docId: string | null;
  version: number | null;
  /** A markdown section to scroll to. */
  section: string | null;
  /** A file's path (code tab). */
  path: string | null;
  lines: [number, number] | null;
  /** The quoted source lines (code and markdown source). */
  quoted: string[];
  /** Markdown: the selected text (the sent card quotes it when there are no source lines). */
  selected: string | null;
  /** A page in the chat's browser (#368: its passage can be lit again there). */
  url: string | null;
  /** The element a passage or a click is in (pages). */
  selector: string | null;
  /** Master's words; '' for a passage quoted with no note (#368). */
  comment: string;
}

/** Parse a block written by formatComment; null for anything else. */
export function parseComment(text: string): ParsedComment | null {
  const m = /^\[comment (\d+)\] (.+)\n\(on (.+)\)\n/.exec(text);
  if (!m) return null;
  const c = /\nComment: ([\s\S]*)$/.exec(text);
  const selected = /\nSelected: « ([\s\S]*?) »(?:\n|$)/.exec(text)?.[1] ?? null;
  if (!c && selected === null) return null;
  const on = m[3]!;
  const doc = /, (doc_[\w-]+) v(\d+)/.exec(on);
  const sec = /, section #([^,\s]+)/.exec(on);
  const file = /^file (.+?)(?:, line|$)/.exec(on);
  // « page http://… in paris's browser, … »: no file, no artifact (the card shows it, a click opens nothing).
  const ln = /, lines? (\d+)(?:–(\d+))?/.exec(on);
  return {
    n: Number(m[1]),
    label: m[2]!,
    docId: doc?.[1] ?? null,
    version: doc ? Number(doc[2]) : null,
    section: sec ? (sec[1] === 'top' ? '' : sec[1]!) : null,
    path: file?.[1] ?? null,
    lines: ln ? [Number(ln[1]), Number(ln[2] ?? ln[1])] : null,
    quoted: text
      .slice(m[0].length, text.length - (c?.[0].length ?? 0))
      .split('\n')
      .filter((l) => l.startsWith('> '))
      .map((l) => l.slice(2)),
    selected,
    url: /^page (\S+) in the chat's browser/.exec(on)?.[1] ?? null,
    selector: /, (?:in )?element (.+?)(?:, |$)/.exec(on)?.[1] ?? null,
    comment: c?.[1] ?? '',
  };
}

/** A link to an image file: shown with <img>, commented on in its own pixels. */
export const isImageAddress = (url: string) => /\.(png|jpe?g|gif|webp|avif|bmp|svg)(?:[?#].*)?$/i.test(url);
