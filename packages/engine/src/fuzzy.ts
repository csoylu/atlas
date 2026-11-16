/**
 * Cheap fallbacks for edit_file when old_text is not found exactly (after Hermes' fuzzy_match.py, strategies 2 and 3):
 * models often get indentation or runs of spaces slightly wrong. Each returns [start, end) spans in the original text.
 * Nothing similarity-based: a wrong edit is worse than a refused one.
 */
export type Span = [number, number];

export function exactSpans(text: string, pattern: string): Span[] {
  const out: Span[] = [];
  for (let i = text.indexOf(pattern); i >= 0; i = text.indexOf(pattern, i + pattern.length)) out.push([i, i + pattern.length]);
  return out;
}

/** Every line compared with leading/trailing whitespace stripped. A match spans whole lines (indentation included). */
export function lineTrimmedSpans(text: string, pattern: string): Span[] {
  const lines = text.split('\n');
  const want = pattern.split('\n').map((l) => l.trim());
  // A pattern ending in a newline gives an empty last line: drop it, it matches nothing in particular.
  if (want.length > 1 && want.at(-1) === '') want.pop();
  if (want.every((l) => l === '')) return [];
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const out: Span[] = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length && ok; j++) ok = lines[i + j]!.trim() === want[j];
    if (!ok) continue;
    const last = i + want.length - 1;
    out.push([starts[i]!, starts[last]! + lines[last]!.length]);
    i = last; // no overlapping matches
  }
  return out;
}

/** Runs of spaces and tabs collapsed to one space on both sides. */
export function whitespaceNormalizedSpans(text: string, pattern: string): Span[] {
  const norm = (s: string) => s.replace(/[ \t]+/g, ' ');
  // Normalized text with, for each of its characters, the index of the original character it came from.
  let n = '';
  const map: number[] = [];
  const blank = (c: string | undefined) => c === ' ' || c === '\t';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (blank(c) && blank(text[i - 1])) continue; // rest of a run: already one space
    n += blank(c) ? ' ' : c;
    map.push(i);
  }
  const p = norm(pattern);
  if (!p.trim()) return [];
  return exactSpans(n, p).map(([s, e]) => {
    let end = map[e - 1]! + 1;
    // A match ending in a collapsed run takes the whole run.
    if (p.endsWith(' ')) while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
    return [map[s]!, end] as Span;
  });
}

export const STRATEGIES: [string, (text: string, pattern: string) => Span[]][] = [
  ['exact', exactSpans],
  ['line-trimmed', lineTrimmedSpans],
  ['whitespace-normalized', whitespaceNormalizedSpans],
];

/** The first strategy that finds old_text at least once. */
export function findSpans(text: string, pattern: string): { strategy: string; spans: Span[] } {
  for (const [strategy, f] of STRATEGIES) {
    const spans = f(text, pattern);
    if (spans.length) return { strategy, spans };
  }
  return { strategy: 'none', spans: [] };
}

/** Replace the spans (non-overlapping, ascending) with `replacement`. */
export function replaceSpans(text: string, spans: Span[], replacement: string): string {
  let out = '';
  let pos = 0;
  for (const [s, e] of spans) {
    out += text.slice(pos, s) + replacement;
    pos = e;
  }
  return out + text.slice(pos);
}
