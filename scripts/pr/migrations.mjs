#!/usr/bin/env node
// Migration numbers of a pull request (#236, CLAUDE.md rule 4). Schema migrations are files `NNNN_name.sql` in a
// folder named `migrations` (Atlas: packages/engine/src/store/migrations), applied in number order and never edited
// once applied. Two PRs written at the same time may take the same number; the one that merges second must move above.
// - clashes(): the PR's new migrations whose number is not above every number already on main in the same folder.
//   CI (`node scripts/pr/migrations.mjs check HEAD^1 HEAD` on the PR) refuses such a PR; its builder renumbers it.
// Plain JS: run with node by CI.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RE = /^(?:(.*)\/)?migrations\/(\d{4})_([^/]+)\.sql$/;

/** `dir/migrations/0051_x.sql` → { dir: 'dir/migrations', number: 51, stem: '0051_x', path }; anything else → null. */
export function parseMigration(path) {
  const m = RE.exec(path);
  if (!m) return null;
  const dir = m[1] ? `${m[1]}/migrations` : 'migrations';
  return { path, dir, number: Number(m[2]), stem: `${m[2]}_${m[3]}` };
}

const pad = (n) => String(n).padStart(4, '0');

/** The highest number per migrations folder among `paths` (main's files). */
function highest(paths) {
  const max = new Map();
  for (const p of paths) {
    const m = parseMigration(p);
    if (m) max.set(m.dir, Math.max(max.get(m.dir) ?? 0, m.number));
  }
  return max;
}

/**
 * The PR's added migrations (`added`: paths added by the PR) whose number is not above main's highest in their folder
 * (`main`: every path on main, or at least its migrations). [{ path, number, max }]
 */
export function clashes(added, main) {
  const max = highest(main);
  return added.map(parseMigration).filter((m) => m && m.number <= (max.get(m.dir) ?? -1)).map((m) => ({ path: m.path, number: m.number, max: max.get(m.dir) }));
}

/** One line per clash, for CI: why the PR cannot merge. */
export const describe = (c) => `${c.path}: number ${pad(c.number)} is not above ${pad(c.max)}, the highest on main in that folder: renumber it above`;

// CLI: node scripts/pr/migrations.mjs check <main-ref> <head-ref>  (exit 1 on a clash)
if (/migrations\.mjs$/.test(process.argv[1] ?? '') && import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, base, head] = process.argv.slice(2);
  if (cmd !== 'check' || !base || !head) {
    console.error('usage: migrations.mjs check <main-ref> <head-ref>');
    process.exit(2);
  }
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
  // Two-dot tree diff: on a pull_request CI checks out the PR merged into main, so this is what the PR adds.
  const added = git('diff', '--name-only', '--no-renames', '--diff-filter=A', base, head);
  const bad = clashes(added, git('ls-tree', '-r', '--name-only', base));
  if (bad.length) {
    for (const c of bad) console.error(describe(c));
    process.exit(1);
  }
  console.log(`migrations: ${added.filter((p) => parseMigration(p)).length} new, all numbered above main's`);
}
