// Quotes in a chat (#367): the pure parts. A passage waiting in the composer is underlined in its message with its
// number; the one a click jumped to is lit for 2 s. Both are marks a rehype plugin puts around the passage's text, so
// React draws them like the rest of the message (no DOM surgery on rendered markdown).
import type { Element, ElementContent, Root, Text } from 'hast';

export interface QuoteMark {
  /** The chip's number (shown after the passage); null: no number (the jump's light). */
  n: number | null;
  passage: string;
  flash?: boolean;
}

const WS = /\s/;
const strip = (s: string) => s.replace(/\s+/g, '');

interface Spot {
  parent: Root | Element;
  index: number;
  node: Text;
}

/** The text nodes in order, a quote's number left out (it is not part of the message). */
function textNodes(node: Root | Element, out: Spot[] = []): Spot[] {
  node.children.forEach((k, index) => {
    if (k.type === 'text') out.push({ parent: node, index, node: k });
    else if (k.type === 'element' && !classes(k).includes('qt-n')) textNodes(k, out);
  });
  return out;
}
const classes = (e: Element): string[] => {
  const c: unknown = e.properties?.className;
  return Array.isArray(c) ? c.map(String) : typeof c === 'string' ? c.split(' ') : [];
};

/**
 * Wrap the passage's text (its first occurrence, whitespace ignored: a selection's text has line breaks where the
 * blocks end) in <mark class="qt-mark"> pieces, one per text node it covers, the number after the last. False when the
 * passage isn't in this text.
 */
export function markPassage(tree: Root, m: QuoteMark): boolean {
  const want = strip(m.passage);
  if (!want) return false;
  const spots = textNodes(tree);
  // Every non-space character: which text node, where in it.
  const chars: { spot: number; at: number }[] = [];
  let flat = '';
  spots.forEach((s, i) => {
    for (let at = 0; at < s.node.value.length; at++) {
      const ch = s.node.value[at]!;
      if (WS.test(ch)) continue;
      chars.push({ spot: i, at });
      flat += ch;
    }
  });
  const from = flat.indexOf(want);
  if (from === -1) return false;
  const first = chars[from]!;
  const last = chars[from + want.length - 1]!;
  // From the last text node back, so the indexes of the earlier ones stay right.
  for (let i = last.spot; i >= first.spot; i--) {
    const { parent, index, node } = spots[i]!;
    const a = i === first.spot ? first.at : 0;
    const b = i === last.spot ? last.at + 1 : node.value.length;
    if (!node.value.slice(a, b).trim()) continue; // the line break between two blocks: nothing to mark
    const piece: Element = { type: 'element', tagName: 'mark', properties: { className: [m.flash ? 'qt-flash' : 'qt-mark'] }, children: [{ type: 'text', value: node.value.slice(a, b) }] };
    const parts: ElementContent[] = [];
    if (a > 0) parts.push({ type: 'text', value: node.value.slice(0, a) });
    parts.push(piece);
    if (i === last.spot && m.n !== null)
      parts.push({ type: 'element', tagName: 'span', properties: { className: ['cm-num', 'qt-n'], dataQn: String(m.n), title: `Quote ${m.n}: show its chip`, role: 'button' }, children: [{ type: 'text', value: String(m.n) }] });
    if (b < node.value.length) parts.push({ type: 'text', value: node.value.slice(b) });
    (parent.children as ElementContent[]).splice(index, 1, ...parts);
  }
  return true;
}

/** Rehype plugin: the marks of one text block, the lit one last (it sits inside an underlined one if both). */
export function rehypeQuoteMarks(marks: QuoteMark[]) {
  return (tree: Root) => {
    for (const m of [...marks].sort((a, b) => Number(!!a.flash) - Number(!!b.flash))) markPassage(tree, m);
  };
}

/** « atlas · « the passage » »: the passage on one line, for the box's head and the chip. */
export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Up to 3 lines of a code passage for a sent card's code box, « … » when cut. */
export function codeLines(passage: string, max = 3): string {
  const lines = passage.replace(/\n+$/, '').split('\n');
  return lines.slice(0, max).join('\n') + (lines.length > max ? '\n…' : '');
}

/** The Q shortcut (#367): plain q, no modifier, not while typing. */
export const isQuoteKey = (e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>) =>
  (e.key === 'q' || e.key === 'Q') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat;
