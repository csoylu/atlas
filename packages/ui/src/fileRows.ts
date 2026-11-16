/**
 * Files & shell detail views (#63, mockup pages/chat-activity.html §4): pure parsing of the tools' outputs and a line
 * diff. Each function is unit-tested; FileStepDetail.tsx draws the results.
 */

/** One line of a diff: unchanged, added or removed, with its line numbers (old file, new file) when known. */
export interface DiffLine {
  t: ' ' | '+' | '-';
  text: string;
  old?: number;
  new?: number;
}

/** A diff as shown: hunk headers between runs of lines. */
export type DiffItem = DiffLine | { t: '@'; text: string };

const split = (s: string) => {
  if (!s) return [];
  const ls = s.split('\n');
  if (ls.at(-1) === '') ls.pop();
  return ls;
};

/** Edits beyond this make the diff a plain « all removed, all added » (Myers is O((N+M)·D)). */
const MAX_EDITS = 1500;

/** Line diff of `a` → `b` (Myers, shortest edit script), numbered from 1 in each. */
export function diffLines(a: string, b: string): DiffLine[] {
  const A = split(a);
  const B = split(b);
  // Common prefix and suffix: cheap, and most edits are small.
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const mid = myers(a2, b2) ?? [...a2.map((text) => ({ t: '-' as const, text })), ...b2.map((text) => ({ t: '+' as const, text }))];
  const out: DiffLine[] = [];
  let o = 1;
  let n = 1;
  const same = (text: string) => out.push({ t: ' ', text, old: o++, new: n++ });
  A.slice(0, pre).forEach(same);
  for (const l of mid) {
    if (l.t === ' ') same(l.text);
    else if (l.t === '-') out.push({ t: '-', text: l.text, old: o++ });
    else out.push({ t: '+', text: l.text, new: n++ });
  }
  A.slice(A.length - suf).forEach(same);
  return out;
}

type Op = { t: ' ' | '+' | '-'; text: string };

function myers(a: string[], b: string[]): Op[] | null {
  const N = a.length;
  const M = b.length;
  const max = N + M;
  if (!max) return [];
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // Per d, only the diagonals it can reach (memory O(D²), not O(D·(N+M))).
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) return backtrack(trace, a, b, d);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], dEnd: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d > 0; d--) {
    const v = trace[d]!; // the furthest x per diagonal after d − 1 edits, diagonal k at k + d + 1
    const o = d + 1;
    const k = x - y;
    const down = k === -d || (k !== d && v[o + k - 1]! < v[o + k + 1]!);
    const px = v[o + (down ? k + 1 : k - 1)]!;
    const py = px - (down ? k + 1 : k - 1);
    while (x > px && y > py) {
      x--;
      y--;
      ops.push({ t: ' ', text: a[x]! });
    }
    if (down) ops.push({ t: '+', text: b[--y]! });
    else ops.push({ t: '-', text: a[--x]! });
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ t: ' ', text: a[x]! });
  }
  return ops.reverse();
}

/** Lines added / removed in a diff. */
export function diffCount(lines: DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.t === '+') add++;
    else if (l.t === '-') del++;
  }
  return { add, del };
}

/** Only the changes and `context` lines around them, with « @@ -a,b +c,d @@ » headers between far-apart runs. */
export function hunks(lines: DiffLine[], context = 3): DiffItem[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.t === ' ') return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep[j] = true;
  });
  const out: DiffItem[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!keep[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && keep[j]) j++;
    const run = lines.slice(i, j);
    const olds = run.filter((l) => l.old !== undefined);
    const news = run.filter((l) => l.new !== undefined);
    const oldStart = olds[0]?.old ?? (lines.slice(0, i).findLast((l) => l.old !== undefined)?.old ?? 0);
    const newStart = news[0]?.new ?? (lines.slice(0, i).findLast((l) => l.new !== undefined)?.new ?? 0);
    out.push({ t: '@', text: `@@ -${oldStart},${olds.length} +${newStart},${news.length} @@` });
    out.push(...run);
    i = j;
  }
  return out;
}

/**
 * edit_file's diff from old_text → new_text. `at` = the line where the edit landed (engine detail): numbers start there
 * (the file before it is unchanged, so both sides start on the same line). Without it, no numbers.
 */
export function editDiff(oldText: string, newText: string, at?: number): DiffLine[] {
  const lines = diffLines(oldText, newText);
  if (at === undefined) return lines.map(({ t, text }) => ({ t, text }));
  const s = at - 1;
  return lines.map((l) => ({ ...l, ...(l.old !== undefined ? { old: l.old + s } : {}), ...(l.new !== undefined ? { new: l.new + s } : {}) }));
}

/** read_file's `N|text` lines and the paging footer. */
export function parseNumbered(out: string): { lines: { n: number; text: string }[]; note?: string } {
  const lines: { n: number; text: string }[] = [];
  let note: string | undefined;
  for (const l of out.split('\n')) {
    const m = /^ *(\d+)\|(.*)$/.exec(l);
    if (m) lines.push({ n: Number(m[1]), text: m[2]! });
    else if (/^\[.*\]$/.test(l.trim())) note = l.trim().slice(1, -1);
  }
  return { lines, note };
}

export interface GrepLine {
  n?: number;
  text: string;
  /** A context line (not a match). */
  ctx?: boolean;
  /** count mode: matches in the file. */
  count?: number;
}
export interface GrepFile {
  path: string;
  lines: GrepLine[];
}

/** grep's output grouped by file. files mode: no lines; count mode: one line with the count. `note`: the « more » footer. */
export function grepGroups(out: string, mode: unknown = 'content'): { files: GrepFile[]; note?: string } {
  const files: GrepFile[] = [];
  let note: string | undefined;
  const fileOf = (path: string) => {
    let f = files.at(-1);
    if (f?.path !== path) files.push((f = { path, lines: [] }));
    return f;
  };
  if (out.trim() === 'no matches') return { files };
  for (const l of out.split('\n')) {
    if (!l || l === '--') continue;
    if (/^\[.*\]$/.test(l)) {
      note = l.slice(1, -1);
      continue;
    }
    if (mode === 'files') {
      fileOf(l);
      continue;
    }
    if (mode === 'count') {
      const m = /^(.*):(\d+)$/.exec(l);
      if (m) fileOf(m[1]!).lines.push({ text: '', count: Number(m[2]) });
      continue;
    }
    const m = /^(.+?):(\d+):(.*)$/.exec(l);
    if (m) {
      fileOf(m[1]!).lines.push({ n: Number(m[2]), text: m[3]! });
      continue;
    }
    // Context line: the current file's path, then -N-.
    const cur = files.at(-1);
    if (cur && l.startsWith(cur.path + '-')) {
      const c = /^-(\d+)-(.*)$/.exec(l.slice(cur.path.length));
      if (c) {
        cur.lines.push({ n: Number(c[1]), text: c[2]!, ctx: true });
        continue;
      }
    }
    const c = /^(.+?)-(\d+)-(.*)$/.exec(l);
    if (c) fileOf(c[1]!).lines.push({ n: Number(c[2]), text: c[3]!, ctx: true });
  }
  return { files, note };
}

/** Split `text` on the matches of `pattern` (a ripgrep regex; one JS can't compile is left unmarked). */
export function markMatches(text: string, pattern: string, ignoreCase = false): (string | { hit: string })[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
  } catch {
    return [text]; // not a JS regex (rare ripgrep syntax): the line shows unmarked
  }
  const out: (string | { hit: string })[] = [];
  let pos = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    if (m.index > pos) out.push(text.slice(pos, m.index));
    out.push({ hit: m[0] });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out.length ? out : [text];
}

/** glob / list_files output → paths (without the footer and the empty markers). */
export function fileList(out: string): { paths: string[]; note?: string } {
  const paths: string[] = [];
  let note: string | undefined;
  for (const l of out.split('\n')) {
    const t = l.trim();
    if (!t || t === '(empty)' || t === 'no matches' || t === 'no files') continue;
    if (/^\[.*\]$/.test(t)) note = t.slice(1, -1);
    else paths.push(t);
  }
  return { paths, note };
}

/** shell's output: « exit N » head, the « output is N chars » note, the text. */
export function shellOutput(out: string): { exit?: string; killed?: string; note?: string; text: string } {
  const m = /^exit (\S+)( \(killed after [^)]*\))?\n?/.exec(out);
  let rest = m ? out.slice(m[0].length) : out;
  const n = /^\[output is [^\n]*\]\n/.exec(rest);
  if (n) rest = rest.slice(n[0].length);
  return { exit: m?.[1], killed: m?.[2]?.trim().slice(1, -1), note: n?.[0].trim().slice(1, -1), text: rest };
}

/** shell_output's output: « bg_x: running (…) », the byte range, the new text. */
export function bgOutput(out: string): { head: string; text: string; note?: string } {
  const [head = '', ...rest] = out.split('\n');
  const lines = rest.filter((l) => !/^\[output bytes [^\]]*\]$/.test(l) && !/^\(no new output; .*\)$/.test(l));
  const empty = rest.find((l) => /^\(no new output; .*\)$/.test(l));
  return { head, text: lines.join('\n'), note: empty?.slice(1, -1) };
}

/** shell background start: the log path. */
export const bgLog = (out: string) => /its output goes to (\S+?)\.( |$)/.exec(out)?.[1];

export interface AnsiSpan {
  text: string;
  /** Classes: fg colour (ansi-red…), ansi-bold, ansi-dim. */
  cls?: string;
}

const COLOURS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/**
 * Terminal text → coloured spans: SGR colours (30–37, 90–97), bold, dim, reset. Other escape sequences are dropped, and
 * a line redrawn with \r keeps only its last state (progress bars).
 */
export function ansi(text: string): AnsiSpan[] {
  const clean = text
    .split('\n')
    .map((l) => {
      const parts = l.replace(/\r$/, '').split('\r');
      return parts.at(-1)!;
    })
    .join('\n')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-La-ln-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]/g, '');
  const out: AnsiSpan[] = [];
  let fg = '';
  let bold = false;
  let dim = false;
  let pos = 0;
  const push = (s: string) => {
    if (!s) return;
    const cls = [fg && 'ansi-' + fg, bold && 'ansi-bold', dim && 'ansi-dim'].filter(Boolean).join(' ');
    const prev = out.at(-1);
    if (prev && (prev.cls ?? '') === cls) prev.text += s;
    else out.push(cls ? { text: s, cls } : { text: s });
  };
  // eslint-disable-next-line no-control-regex
  for (const m of clean.matchAll(/\x1b\[([0-9;]*)m/g)) {
    push(clean.slice(pos, m.index));
    pos = m.index + m[0].length;
    const codes = m[1] ? m[1].split(';').map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      if (c === 0) [fg, bold, dim] = ['', false, false];
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) [bold, dim] = [false, false];
      else if (c === 39) fg = '';
      else if (c >= 30 && c <= 37) fg = COLOURS[c - 30]!;
      else if (c >= 90 && c <= 97) fg = 'bright-' + COLOURS[c - 90]!;
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0; // 256 / rgb: skipped
    }
  }
  push(clean.slice(pos));
  return out;
}

/** The text without escape codes (Copy). */
export const plainText = (text: string) =>
  ansi(text)
    .map((s) => s.text)
    .join('');
