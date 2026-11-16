import { useEffect, useRef, useState } from 'react';
import type { Element, ElementContent, Root, RootContent } from 'hast';

/**
 * The draft as rendered: follows the live one at most every `draftInterval` ms, so a long reply isn't re-parsed on
 * every token (a 5k-word reply costs ~40 ms per parse). Cleared at once when the draft is.
 */
export function useThrottledDraft(draft: string): string {
  const [shown, setShown] = useState(draft);
  const latest = useRef(draft);
  latest.current = draft;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!draft) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setShown('');
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setShown(latest.current);
    }, draftInterval(draft.length));
  }, [draft]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return shown;
}

/** ms between draft renders: ~20 fps for a short reply, slower as it grows (parse cost is linear). */
export function draftInterval(chars: number): number {
  return Math.min(250, 50 + Math.floor(chars / 300));
}

/**
 * A streaming reply rendered as markdown (#79): the draft so far, with an unclosed code fence closed for now (code
 * shows as a code block while it streams) and a caret marker at the end of the text, which `rehypeCaret` turns into
 * the blinking caret element, inline after the last character (inside the last paragraph, list item, cell or code).
 */

/** Private-use character: never typed by a model, survives markdown parsing as plain text. */
export const CARET = '\uE000';

export function draftMarkdown(draft: string): string {
  const fence = openFence(draft);
  if (!fence) return draft + CARET;
  // The caret goes inside the code, on the last line (a new one while the opening line streams: not in the info
  // string); the fence closes on its own line after it.
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*$/.test(draft.slice(draft.lastIndexOf('\n') + 1));
  return draft + (opening ? '\n' : '') + CARET + '\n' + fence;
}

/** The opening fence (``` or ~~~, 3+) still waiting for its close at the end of `md`, or null. */
export function openFence(md: string): string | null {
  let open: { char: string; len: number; indent: number } | null = null;
  for (const line of md.split('\n')) {
    const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const char = m[2]![0]!;
    const len = m[2]!.length;
    if (!open) {
      // A backtick fence's info string can't contain a backtick (CommonMark): then it isn't a fence.
      if (char === '`' && m[3]!.includes('`')) continue;
      open = { char, len, indent: m[1]!.length };
    } else if (char === open.char && len >= open.len && !m[3]!.trim()) open = null;
  }
  return open ? ' '.repeat(open.indent) + open.char.repeat(open.len) : null;
}

/** Rehype plugin: the CARET character becomes <span class="caret">, wherever it ended up. */
export function rehypeCaret() {
  return (tree: Root) => {
    replaceIn(tree);
  };
}

function replaceIn(node: Root | Element): boolean {
  const kids = node.children as (RootContent | ElementContent)[];
  for (let i = kids.length - 1; i >= 0; i--) {
    const k = kids[i]!;
    if (k.type === 'text' && k.value.includes(CARET)) {
      const [before, after] = splitOnce(k.value);
      const caret: Element = { type: 'element', tagName: 'span', properties: { className: ['caret'], ariaHidden: 'true' }, children: [] };
      const parts: ElementContent[] = [];
      if (before) parts.push({ type: 'text', value: before });
      parts.push(caret);
      if (after) parts.push({ type: 'text', value: after });
      kids.splice(i, 1, ...parts);
      return true;
    }
    if (k.type === 'element' && replaceIn(k)) return true;
  }
  return false;
}

function splitOnce(s: string): [string, string] {
  const i = s.indexOf(CARET);
  return [s.slice(0, i), s.slice(i + 1).split(CARET).join('')];
}
