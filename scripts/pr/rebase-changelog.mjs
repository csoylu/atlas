// Automatic rebase of a PR whose only conflict with main is CHANGELOG.md (card #188).
//
// Every PR adds its entry at the top of CHANGELOG.md, so each merge makes every other open PR conflict there. When that
// is the only conflict, validate.mjs --ok --merge calls rebaseChangelogOnly(): the PR's commits are replayed onto main in
// a throwaway worktree, each commit's CHANGELOG.md becomes « main's file with the PR's new entry put back on top » (main's
// intro and entries byte-identical), and the result is checked before anything is pushed:
//   - every other file of the new head equals git's own 3-way merge of main and the old head (`git merge-tree`);
//   - the PR's changed lines outside CHANGELOG.md (diff -U0 against its base) are identical before and after;
//   - the new CHANGELOG.md adds exactly one entry on top of main's (checkPush), and keeps main's text byte for byte.
// Then the branch (never main) is pushed with --force-with-lease pinned to the validated head, so a commit pushed in
// between makes the push fail. Any other conflicting file, a merge commit in the PR, a PR that edits older changelog
// text, or a failed check: refused with the reason, nothing pushed. The validator's clone (working tree, index, HEAD,
// branches) is never touched: the fetched commits land under refs/pr-rebase/<pid>/ and are deleted at the end.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPush, parseChangelog } from '../release/changelog.mjs';

export const FILE = 'CHANGELOG.md';
const PROTECTED = new Set(['main', 'master']);

/** Character offset of the first entry heading (`## …`) in a changelog, or its length when it has none. */
function firstEntryOffset(text) {
  const [first] = parseChangelog(text);
  if (!first) return text.length;
  return text.split('\n').slice(0, first.line - 1).reduce((n, l) => n + l.length + 1, 0);
}

/**
 * The PR's changelog moved onto main's: `pr` must be `base` (the changelog where the branch left main) with entries
 * added just above its first entry and nothing else changed. Returns main's text with those added entries above
 * main's first entry. Throws when `pr` changed anything else (intro, older entries): that needs a human.
 */
export function moveEntry(pr, base, main) {
  const pb = firstEntryOffset(base);
  const intro = base.slice(0, pb);
  const rest = base.slice(pb);
  if (pr.length < base.length || !pr.startsWith(intro) || !pr.endsWith(rest))
    throw new Error(`${FILE}: the PR changes more than its new top entry (the intro or an older entry): rebase it by hand`);
  const added = pr.slice(pb, pr.length - rest.length);
  if (added && !/^## /.test(added)) throw new Error(`${FILE}: the PR's added text is not an entry on top: rebase it by hand`);
  const pm = firstEntryOffset(main);
  return main.slice(0, pm) + added + main.slice(pm);
}

/** git in `dir`; returns stdout trimmed of the last newline. Throws with git's stderr. */
function gitIn(dir, env) {
  return (args, opts = {}) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 50e6, env: { ...process.env, ...env, ...opts.env } });
    if (r.error) throw r.error;
    if (r.status !== 0 && !opts.allowFail) throw new Error(`git ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
    return opts.allowFail ? { status: r.status, out: r.stdout.replace(/\n$/, ''), err: r.stderr } : r.stdout.replace(/\n$/, '');
  };
}

/** Changed lines only (diff -U0 without hunk headers or index lines): what a PR does, wherever main moved it. */
function changes(git, from, to) {
  return git(['diff', '--no-color', '--no-ext-diff', '-U0', '--no-renames', from, to, '--', '.', `:(exclude)${FILE}`])
    .split('\n')
    .filter((l) => !/^(index |@@ )/.test(l))
    .join('\n');
}

/**
 * Rebase PR branch `branch` (validated at `sha`) onto `remote`/`base` when CHANGELOG.md is its only conflict, check
 * it, push it. `repo` is any clone of the repository (the validator's: left as it was).
 * Returns { oldHead, newHead, onto, commits, lines } (lines: what happened, for the output). Throws when refused.
 */
export function rebaseChangelogOnly({ repo, branch, sha, base = 'main', remote = 'origin', env = {} }) {
  if (PROTECTED.has(branch) || branch === base) throw new Error(`refused: will not rewrite "${branch}"`);
  const git = gitIn(repo, env);
  const ns = `refs/pr-rebase/${process.pid}-${Date.now()}`;
  let worktree = null;
  try {
    // From the remote's URL, not its name: a fetch by name also updates the clone's origin/<branch> refs on some git
    // versions (2.56 does even with --refmap=), and the validator's clone must stay as it was.
    const fetchUrl = git(['remote', 'get-url', remote]);
    git(['fetch', '-q', '--no-tags', fetchUrl, `+refs/heads/${base}:${ns}/base`, `+refs/heads/${branch}:${ns}/head`]);
    const onto = git(['rev-parse', `${ns}/base`]);
    const oldHead = git(['rev-parse', `${ns}/head`]);
    if (!oldHead.startsWith(sha.toLowerCase()))
      throw new Error(`refused: ${branch} is at ${oldHead.slice(0, 7)} on ${remote}, not the validated ${sha.slice(0, 7)}: a commit was pushed after the review`);
    const forkPoint = git(['merge-base', onto, oldHead]);
    if (forkPoint === onto) throw new Error(`refused: ${branch} already contains ${base} (${onto.slice(0, 7)}): nothing to rebase`);
    const merges = git(['rev-list', '--merges', `${forkPoint}..${oldHead}`]);
    if (merges) throw new Error(`refused: ${branch} has merge commits (${merges.split('\n').map((s) => s.slice(0, 7)).join(', ')}): rebase it by hand`);

    // What git's own merge says: which files conflict, and the tree every other file must end up with.
    const mt = git(['merge-tree', '--write-tree', '--name-only', '--no-messages', onto, oldHead], { allowFail: true });
    if (mt.status > 1) throw new Error(`git merge-tree failed: ${mt.err.trim()}`);
    const [mergedTree, ...conflicted] = mt.out.split('\n').filter(Boolean);
    if (mt.status === 0) throw new Error(`refused: ${branch} merges into ${base} without conflict: nothing to rebase (validate again)`);
    const others = conflicted.filter((f) => f !== FILE);
    if (others.length) throw new Error(`refused: conflicts with ${base} in ${others.join(', ')}${conflicted.includes(FILE) ? ` (and ${FILE})` : ''}: rebase it by hand`);

    const readLog = (rev) => {
      const r = spawnSync('git', ['-C', repo, 'cat-file', 'blob', `${rev}:${FILE}`], { encoding: 'utf8', maxBuffer: 50e6 }); // exact bytes
      if (r.status !== 0) throw new Error(`refused: no ${FILE} in ${rev.slice(0, 7)}: rebase it by hand`);
      return r.stdout;
    };
    const baseLog = readLog(forkPoint);
    const mainLog = readLog(onto);
    const wanted = moveEntry(readLog(oldHead), baseLog, mainLog);
    const bad = checkPush(mainLog, wanted);
    if (bad) throw new Error(`refused: after the rebase, ${FILE}: ${bad.replace(/^this push/, 'the PR')}`);

    // Replay every commit in a throwaway worktree on main.
    worktree = mkdtempSync(join(tmpdir(), 'pr-rebase-'));
    git(['worktree', 'add', '-q', '--detach', worktree, onto]);
    const wt = gitIn(worktree, env);
    const commits = git(['rev-list', '--reverse', `${forkPoint}..${oldHead}`]).split('\n').filter(Boolean);
    for (const c of commits) {
      const pick = wt(['cherry-pick', '--no-commit', c], { allowFail: true });
      const unmerged = wt(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      const stray = unmerged.filter((f) => f !== FILE);
      if (stray.length) throw new Error(`refused: replaying ${c.slice(0, 7)} conflicts in ${stray.join(', ')}: rebase it by hand`);
      if (pick.status !== 0 && !unmerged.length) throw new Error(`git cherry-pick ${c.slice(0, 7)} failed: ${pick.err.trim()}`);
      writeFileSync(join(worktree, FILE), moveEntry(readLog(c), baseLog, mainLog));
      wt(['add', '--', FILE]);
      const [name, email, date] = git(['log', '-1', '--format=%an%x00%ae%x00%aD', c]).split('\0');
      wt(['commit', '-q', '--allow-empty', '--no-verify', '--cleanup=verbatim', '-C', c], {
        env: { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date },
      });
    }
    const newHead = wt(['rev-parse', 'HEAD']);

    // Checks: nothing is pushed unless all hold.
    const fail = (why) => {
      throw new Error(`auto-rebase aborted, nothing pushed: ${why}`);
    };
    if (wt(['rev-list', '--count', `${onto}..${newHead}`]) !== String(commits.length)) fail('the commit count changed');
    const msgs = (range) => git(['log', '--format=%B%x00', range]);
    if (msgs(`${onto}..${newHead}`) !== msgs(`${forkPoint}..${oldHead}`)) fail('a commit message changed');
    const drift = git(['diff', '--name-only', mergedTree, newHead, '--', '.', `:(exclude)${FILE}`]);
    if (drift) fail(`files differ from git's merge of ${base} and the PR: ${drift.split('\n').join(', ')}`);
    if (changes(git, forkPoint, oldHead) !== changes(git, onto, newHead)) fail(`the PR's changes outside ${FILE} are not the same as before`);
    const newLog = readLog(newHead);
    if (newLog !== wanted) fail(`${FILE} is not main's with the PR's entry on top`);
    const pm = firstEntryOffset(mainLog);
    if (!newLog.startsWith(mainLog.slice(0, pm)) || !newLog.endsWith(mainLog.slice(pm))) fail(`${base}'s ${FILE} text is not kept byte for byte`);
    const recheck = checkPush(mainLog, newLog);
    if (recheck) fail(`${FILE}: ${recheck}`);

    // Push the branch only, and only if it is still the validated head.
    // To the remote's URL, not its name: a push by name would also move the clone's origin/<branch> ref.
    const url = git(['remote', 'get-url', '--push', remote]);
    const push = git(['push', '-q', '--porcelain', `--force-with-lease=refs/heads/${branch}:${oldHead}`, url, `${newHead}:refs/heads/${branch}`], { allowFail: true });
    if (push.status !== 0)
      throw new Error(`auto-rebase not pushed (${branch} moved on ${remote} since ${oldHead.slice(0, 7)}, or the push was refused): ${(push.err || push.out).trim()}`);
    const [entry] = parseChangelog(newLog);
    return {
      oldHead,
      newHead,
      onto,
      commits: commits.length,
      lines: [
        `${branch} conflicted with ${base} in ${FILE} only: rebased onto ${base} ${onto.slice(0, 7)}, its entry « ${entry.heading} » back on top, ${base}'s entries untouched`,
        `head changed ${oldHead.slice(0, 7)} → ${newHead.slice(0, 7)} (${commits.length} commit${commits.length === 1 ? '' : 's'}; changes outside ${FILE} checked identical), pushed with --force-with-lease`,
      ],
    };
  } finally {
    if (worktree) {
      git(['worktree', 'remove', '--force', worktree], { allowFail: true });
      rmSync(worktree, { recursive: true, force: true });
      git(['worktree', 'prune'], { allowFail: true });
    }
    const refs = git(['for-each-ref', '--format=%(refname)', ns], { allowFail: true }).out;
    for (const r of (refs ?? '').split('\n').filter(Boolean)) git(['update-ref', '-d', r], { allowFail: true });
  }
}
