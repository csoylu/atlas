// changelog/ → version, release notes, the full changelog and the « one PR = one entry » check (docs/updater.md,
// #123; one file per PR since #223). Plain JS on purpose: CI runs it with `node` before `npm ci`, and the tests import it.
//
// An entry is one file `changelog/<task>-<slug>.md` whose first line is its heading
// `## <Kind> · #<task> · <one sentence>` (the task = the file's number), followed by optional details (### for
// sub-headings: a second `## ` line is refused). Kinds (Keep a Changelog, SemVer): Fixed → patch, Added / Changed →
// minor, Breaking → major. A PR adds exactly one new file and changes no other: two PRs never touch the same file, so
// they never conflict there.
//
// Order: the order the files reached the branch in git history (`git log --first-parent`: on main, the order the PRs
// were merged; the newest is the last merged). Files not committed yet come after, by name. The entries from before
// #223 are frozen in changelog/history.md (the former CHANGELOG.md, newest on top, never edited): the version is
// computed by replaying BASE (v3, cad983f), then history.md from its oldest entry to its newest, then the files from
// the oldest to the newest. The same history always gives the same version, nobody types a number. Needs the full git
// history (a shallow clone is refused).
//
//   node scripts/release/changelog.mjs version             prints the version (e.g. 0.47.0)
//   node scripts/release/changelog.mjs notes               prints the newest entry (the release notes)
//   node scripts/release/changelog.mjs full                prints the whole changelog, newest first, with versions
//   node scripts/release/changelog.mjs check <before-sha>  exit 1 unless <before-sha>..HEAD adds exactly one entry
//                                                           file and changes no other changelog file
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASE = '0.3.0';
export const KINDS = { Fixed: 'patch', Added: 'minor', Changed: 'minor', Breaking: 'major' };
export const DIR = 'changelog';
export const HISTORY = `${DIR}/history.md`;
const ENTRY_FILE = /^changelog\/(\d+)-[a-z0-9][a-z0-9-]*\.md$/;
const FORMAT = 'Fixed|Added|Changed|Breaking · #task · One plain sentence';

/**
 * @typedef {{ kind: keyof typeof KINDS, task: number | null, title: string, heading: string, body: string, line: number, path?: string }} Entry
 */

/** Entries of a markdown text, newest first. Throws on a heading that isn't a valid entry (unknown kind, missing sentence). */
export function parseChangelog(text, name = HISTORY) {
  /** @type {Entry[]} */
  const entries = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let current = null;
  let fence = false;
  lines.forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) fence = !fence;
    if (!fence && /^## /.test(raw)) {
      if (current) entries.push(finish(current));
      current = { ...parseHeading(raw, i + 1, name), bodyLines: [] };
    } else if (current) current.bodyLines.push(raw);
  });
  if (current) entries.push(finish(current));
  return entries;
}

function parseHeading(raw, line, name) {
  const heading = raw.slice(3).trim();
  const parts = heading.split(/\s+·\s+/);
  const kind = parts[0];
  if (!(kind in KINDS)) throw new Error(`${name} line ${line}: unknown kind « ${kind} » in « ${raw} » (use ${Object.keys(KINDS).join(', ')})`);
  let task = null;
  let rest = parts.slice(1);
  if (rest[0] && /^#\d+$/.test(rest[0])) {
    task = Number(rest[0].slice(1));
    rest = rest.slice(1);
  }
  const title = rest.join(' · ').trim();
  if (!title) throw new Error(`${name} line ${line}: « ${raw} » has no sentence (format: ## ${FORMAT})`);
  return { kind, task, title, heading, line };
}

function finish({ bodyLines, ...e }) {
  return { ...e, body: bodyLines.join('\n').trim() };
}

/** One entry file: its path is changelog/<task>-<slug>.md, its first line the heading, the heading's task its number. */
export function parseEntry(text, path) {
  const m = ENTRY_FILE.exec(path);
  if (!m) throw new Error(`${path} is not an entry file name: changelog/<task>-<slug>.md, lower case (e.g. changelog/223-changelog-folder.md)`);
  const t = text.replace(/\r\n/g, '\n');
  if (!/^## /.test(t)) throw new Error(`${path}: the first line must be the heading « ## ${FORMAT} »`);
  const entries = parseChangelog(t, path);
  if (entries.length !== 1) throw new Error(`${path} holds ${entries.length} entries: one per file (a « ## » line in the details starts a new one: use ###)`);
  const [e] = entries;
  if (e.task !== Number(m[1])) throw new Error(`${path}: the heading's task (${e.task == null ? 'none' : `#${e.task}`}) must be the file's number, #${m[1]}`);
  return { ...e, path };
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

/** The versions entries (newest first) give, newest first: BASE, then every entry from the oldest to the newest. */
export function versionsOf(entries) {
  const out = [];
  let v = BASE;
  for (const e of [...entries].reverse()) out.unshift((v = bump(v, e.kind)));
  return out;
}

export const versionOfEntries = (entries) => versionsOf(entries)[0] ?? BASE;

/** The version a markdown changelog gives (history.md alone, or the CHANGELOG.md of before #223). */
export const versionOf = (text) => versionOfEntries(parseChangelog(text));

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 100e6 });

/** changelog/ path → its rank in the order the files reached HEAD (0 = first), from git history. */
export function arrivalOrder(cwd = '.') {
  if (git(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true')
    throw new Error('the changelog order comes from git history and this clone is shallow: fetch it all (git fetch --unshallow; in CI, actions/checkout with fetch-depth: 0)');
  // Newest commit first; each block = the files a commit added on the first-parent chain (a merge: against its first parent).
  const out = git(cwd, ['log', '--first-parent', '--diff-merges=first-parent', '--no-renames', '--diff-filter=A', '--name-only', '--format=%x00', 'HEAD', '--', `${DIR}/`]);
  const commits = out.split('\0').slice(1).map((block) => block.split('\n').map((s) => s.trim()).filter(Boolean).sort());
  const order = new Map();
  for (const files of commits.reverse()) for (const f of files) if (!order.has(f)) order.set(f, order.size);
  return order;
}

/** Every entry of the working tree, newest first: the files of changelog/ in arrival order, then history.md. */
export function readEntries(cwd = '.') {
  const history = parseChangelog(readFileSync(join(cwd, HISTORY), 'utf8'));
  const order = arrivalOrder(cwd);
  const at = (f) => order.get(f) ?? Infinity; // not committed yet: newest, by name
  const files = readdirSync(join(cwd, DIR))
    .map((n) => `${DIR}/${n}`)
    .filter((f) => f !== HISTORY)
    .sort((a, b) => at(a) - at(b) || (a < b ? -1 : a > b ? 1 : 0));
  const added = files.map((f) => parseEntry(readFileSync(join(cwd, f), 'utf8'), f));
  return [...added.reverse(), ...history];
}

export const versionAt = (cwd = '.') => versionOfEntries(readEntries(cwd));

/** An entry as markdown: its heading line, then its details. */
const render = (e, heading = e.heading) => `## ${heading}${e.body ? `\n\n${e.body}` : ''}\n`;

/** The newest entry as release notes (markdown). */
export function notesOf(entries) {
  const [top] = entries;
  if (!top) throw new Error('the changelog has no entry');
  return render(top);
}

/** The whole changelog for reading (newest first), each heading with the version it gave. Never committed. */
export function fullOf(entries) {
  const versions = versionsOf(entries);
  const intro =
    '# Changelog\n\nGenerated by `node scripts/release/changelog.mjs full` from `changelog/` (one file per pull request, ' +
    'in merge order) and `changelog/history.md` (the entries before #223). Newest first; each heading starts with the ' +
    'version it gave. Do not edit: add a file to `changelog/`.\n';
  return [intro, ...entries.map((e, i) => render(e, `${versions[i]} · ${e.heading}`))].join('\n');
}

/**
 * The rule for one PR or one push, from its changed paths (status added | modified | removed; a rename is a removal
 * and an addition): exactly one new entry file in changelog/, and no other changelog file changed. history.md may only
 * be added (once, when the folder starts). Returns { problem } (a sentence) or { file } (the new entry, to parse).
 */
export function changelogRule(changes) {
  const mine = changes.filter((c) => c.path.startsWith(`${DIR}/`));
  const touched = mine.find((c) => c.status !== 'added');
  if (touched) return { problem: `${touched.path} is ${touched.status === 'removed' ? 'removed' : 'changed'}: existing changelog files never change, add a new one` };
  const added = mine.filter((c) => c.path !== HISTORY);
  if (!added.length) return { problem: `no new changelog entry: add one file changelog/<task>-<slug>.md whose first line is « ## ${FORMAT} »` };
  if (added.length > 1) return { problem: `${added.length} new changelog entries (${added.map((c) => c.path).join(', ')}): one PR = one entry = one release` };
  return { file: added[0].path };
}

const STATUS = { A: 'added', D: 'removed' };

/** CI, push to main: null when <before>..HEAD follows the rule (and the whole changelog still reads), else why not. */
export function checkPush(cwd, before) {
  const diff = git(cwd, ['diff', '--no-renames', '--name-status', before, 'HEAD', '--', `${DIR}/`]);
  const changes = diff
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [s, path] = l.split('\t');
      return { path, status: STATUS[s[0]] ?? 'modified' };
    });
  const r = changelogRule(changes);
  if (r.problem) return `this push: ${r.problem}`;
  try {
    parseEntry(readFileSync(join(cwd, r.file), 'utf8'), r.file);
    readEntries(cwd);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return null;
}

// CLI
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, a] = process.argv.slice(2);
  try {
    if (cmd === 'version') console.log(versionAt());
    else if (cmd === 'notes') process.stdout.write(notesOf(readEntries()));
    else if (cmd === 'full') process.stdout.write(fullOf(readEntries()));
    else if (cmd === 'check') {
      if (!a) throw new Error('usage: check <before-sha>');
      const reason = checkPush('.', a);
      if (reason) {
        console.error(`CHANGELOG check failed: ${reason}`);
        process.exit(1);
      }
      console.log(`CHANGELOG check ok: one new entry, version ${versionAt()}`);
    } else throw new Error('usage: changelog.mjs version|notes|full|check <before-sha>');
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
