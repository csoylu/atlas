// CHANGELOG.md → version, release notes and the « one push = one entry » check (docs/updater.md, card #123).
// Plain JS on purpose: CI runs it with `node` before `npm ci`, and the tests import it.
//
// An entry is a level-2 heading `## <Kind> · #<task> · <one sentence>` (the task part is optional), newest on top,
// followed by an optional body up to the next `## `. Kinds (Keep a Changelog, SemVer): Fixed → patch,
// Added / Changed → minor, Breaking → major. The version is computed by replaying the entries from the oldest to the
// newest, starting from BASE (v3, cad983f): the same file always gives the same version, nobody types a number.
//
//   node scripts/release/changelog.mjs version [CHANGELOG.md]       prints the version (e.g. 0.17.2)
//   node scripts/release/changelog.mjs notes [CHANGELOG.md]         prints the newest entry (the release notes)
//   node scripts/release/changelog.mjs check <before> <after>       exit 1 unless <after> adds exactly one entry on top
//                                                                    (<before> = '-' when the file did not exist)
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BASE = '0.3.0';
export const KINDS = { Fixed: 'patch', Added: 'minor', Changed: 'minor', Breaking: 'major' };

/**
 * @typedef {{ kind: keyof typeof KINDS, task: number | null, title: string, heading: string, body: string, line: number }} Entry
 */

/** Entries newest first. Throws on a heading that isn't a valid entry (unknown kind, missing sentence). */
export function parseChangelog(text) {
  /** @type {Entry[]} */
  const entries = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let current = null;
  let fence = false;
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    if (!fence && /^## /.test(raw)) {
      if (current) entries.push(finish(current));
      current = { ...parseHeading(raw, i + 1), bodyLines: [] };
    } else if (current) current.bodyLines.push(raw);
  });
  if (current) entries.push(finish(current));
  return entries;
}

function parseHeading(raw, line) {
  const heading = raw.slice(3).trim();
  const parts = heading.split(/\s+·\s+/);
  const kind = parts[0];
  if (!(kind in KINDS)) throw new Error(`CHANGELOG.md line ${line}: unknown kind « ${kind} » in « ${raw} » (use ${Object.keys(KINDS).join(', ')})`);
  let task = null;
  let rest = parts.slice(1);
  if (rest[0] && /^#\d+$/.test(rest[0])) {
    task = Number(rest[0].slice(1));
    rest = rest.slice(1);
  }
  const title = rest.join(' · ').trim();
  if (!title) throw new Error(`CHANGELOG.md line ${line}: « ${raw} » has no sentence (format: ## Kind · #task · One plain sentence)`);
  return { kind, task, title, heading, line };
}

function finish({ bodyLines, ...e }) {
  return { ...e, body: bodyLines.join('\n').trim() };
}

/** a.b.c → [a, b, c] (pre-release suffixes are ignored by the caller). */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`not a version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function bump(version, kind) {
  const [major, minor, patch] = parseVersion(version);
  const step = KINDS[kind];
  if (step === 'major') return `${major + 1}.0.0`;
  if (step === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The version a changelog gives: BASE, then every entry from the oldest to the newest. */
export function versionOf(text) {
  return parseChangelog(text).reverse().reduce((v, e) => bump(v, e.kind), BASE);
}

/** The newest entry as release notes (markdown): its heading line, then its body. */
export function notesOf(text) {
  const [top] = parseChangelog(text);
  if (!top) throw new Error('CHANGELOG.md has no entry');
  return `## ${top.heading}${top.body ? `\n\n${top.body}` : ''}\n`;
}

/**
 * The CI rule: `after` is `before` with exactly one new entry added on top, and every older entry unchanged.
 * Returns null when it holds, else the reason (one plain sentence for the task).
 * `before` null = the file did not exist: then `after` must hold exactly one entry.
 */
export function checkPush(before, after) {
  let older, newer;
  try {
    older = before == null ? [] : parseChangelog(before);
  } catch (e) {
    older = null; // a broken file before this push: only the new one has to be valid
  }
  try {
    newer = parseChangelog(after);
  } catch (e) {
    return e.message;
  }
  if (older) {
    const added = newer.length - older.length;
    if (added === 0) return 'this push adds no CHANGELOG.md entry: add one at the top (## Fixed|Added|Changed|Breaking · #task · sentence)';
    if (added < 0) return `this push removes ${-added} CHANGELOG.md entr${added === -1 ? 'y' : 'ies'}: older entries must stay`;
    if (added > 1) return `this push adds ${added} CHANGELOG.md entries: one push to main is one entry (merge the work into one entry, or push separately)`;
    const changed = older.findIndex((e, i) => e.heading !== newer[i + 1].heading);
    if (changed >= 0) return `the new CHANGELOG.md entry must be on top, and older ones unchanged ("${older[changed].heading}" moved or changed)`;
  }
  return null;
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, a, b] = process.argv.slice(2);
  const read = (f) => readFileSync(f, 'utf8');
  try {
    if (cmd === 'version') console.log(versionOf(read(a ?? 'CHANGELOG.md')));
    else if (cmd === 'notes') process.stdout.write(notesOf(read(a ?? 'CHANGELOG.md')));
    else if (cmd === 'check') {
      if (!a || !b) throw new Error('usage: check <before|-> <after>');
      const reason = checkPush(a === '-' ? null : read(a), read(b));
      if (reason) {
        console.error(`CHANGELOG check failed: ${reason}`);
        process.exit(1);
      }
      console.log(`CHANGELOG check ok: one new entry, version ${versionOf(read(b))}`);
    } else throw new Error('usage: changelog.mjs version|notes|check');
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
