import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module (a script run with node)
import { moveEntry, rebaseChangelogOnly } from './rebase-changelog.mjs';
// @ts-expect-error plain JS module (a script run with node)
import { validate } from './validate.mjs';

const intro = '# Changelog\n\nNewest on top.\n\n';
const e = (kind: string, n: number, title: string, body = '') => `## ${kind} · #${n} · ${title}\n${body ? `\n${body}\n` : ''}`;
const log = (...entries: string[]) => intro + entries.join('\n');

// Author/committer fixed so the tests do not depend on the agent's environment (#136 sets GIT_AUTHOR_NAME).
const ENV = { GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@test', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@test' };

/** A bare « GitHub », a developer clone that makes branches, and a validator clone with work in progress. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'pr-rebase-test-'));
  const run = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...ENV } }).trim();
  const origin = join(root, 'origin.git');
  run(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const dev = join(root, 'dev');
  run(root, 'clone', '-q', origin, dev);
  const g = (...a: string[]) => run(dev, ...a);
  const write = (file: string, text: string) => writeFileSync(join(dev, file), text);
  const commit = (msg: string, files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) write(f, t);
    g('add', '-A');
    g('commit', '-q', '--cleanup=verbatim', '-m', msg);
    return g('rev-parse', 'HEAD');
  };
  g('checkout', '-q', '-b', 'main');
  commit('start', { 'CHANGELOG.md': log(e('Added', 1, 'First')), 'a.txt': 'a1\na2\na3\na4\na5\na6\na7\na8\n', 'b.txt': 'b1\n' });
  g('push', '-q', 'origin', 'main');
  const validator = join(root, 'validator');
  run(root, 'clone', '-q', origin, validator);
  writeFileSync(join(validator, 'a.txt'), 'uncommitted work\n');
  run(validator, 'checkout', '-q', '-b', 'my-work');
  const remote = (ref: string) => run(dev, 'ls-remote', origin, `refs/heads/${ref}`).split('\t')[0]!;
  const show = (rev: string, file = 'CHANGELOG.md') => execFileSync('git', ['-C', origin, 'cat-file', 'blob', `${rev}:${file}`], { encoding: 'utf8' });
  const state = () => ({
    head: run(validator, 'rev-parse', 'HEAD'),
    branch: run(validator, 'branch', '--show-current'),
    status: run(validator, 'status', '--porcelain'),
    refs: run(validator, 'for-each-ref', '--format=%(refname) %(objectname)'),
    worktrees: run(validator, 'worktree', 'list', '--porcelain'),
  });
  const rebase = (branch: string, sha: string) => rebaseChangelogOnly({ repo: validator, branch, sha, env: ENV });
  return { g, commit, remote, show, state, rebase, origin, dev, validator };
}

describe('moveEntry', () => {
  const base = log(e('Added', 1, 'First'));
  const main = log(e('Fixed', 3, 'From main', 'Main details.'), e('Added', 1, 'First'));
  it('puts the PR entry (with its details) above main’s entries, main’s text unchanged', async () => {
    const pr = log(e('Fixed', 2, 'Mine', 'Line one.\n\n- detail'), e('Added', 1, 'First'));
    expect(moveEntry(pr, base, main)).toBe(intro + e('Fixed', 2, 'Mine', 'Line one.\n\n- detail') + '\n' + e('Fixed', 3, 'From main', 'Main details.') + '\n' + e('Added', 1, 'First'));
  });
  it('a commit before the entry exists gives main’s file as it is', async () => {
    expect(moveEntry(base, base, main)).toBe(main);
  });
  it('refuses a PR that edits the intro or an older entry', async () => {
    expect(() => moveEntry(log(e('Fixed', 2, 'Mine'), e('Added', 1, 'First', 'typo fix')), base, main)).toThrow(/more than its new top entry/);
    expect(() => moveEntry(base.replace('Newest', 'Latest'), base, main)).toThrow(/more than its new top entry/);
  });
});

describe('rebaseChangelogOnly on real git repos', { timeout: 60_000 }, () => {
  it('changelog-only conflict: rebased, entry on top, older entries byte-identical, code unchanged, validator clone untouched', async () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/2-mine');
    const pr = w.commit('#2 the fix', { 'CHANGELOG.md': log(e('Fixed', 2, 'Mine'), e('Added', 1, 'First')), 'a.txt': 'a1\nPR\na3\na4\na5\na6\na7\na8\n' });
    w.g('push', '-q', 'origin', 'fix/2-mine');
    w.g('checkout', '-q', 'main');
    w.commit('#3 main moves', { 'CHANGELOG.md': log(e('Fixed', 3, 'From main', 'Main details.'), e('Added', 1, 'First')), 'a.txt': 'a1\na2\na3\na4\na5\na6\na7\nMAIN\n' });
    w.g('push', '-q', 'origin', 'main');
    const mainLog = w.show(w.remote('main'));
    const before = w.state();

    const r = await w.rebase('fix/2-mine', pr.slice(0, 7));

    expect(r.oldHead).toBe(pr);
    expect(w.remote('fix/2-mine')).toBe(r.newHead);
    expect(r.onto).toBe(w.remote('main'));
    expect(r.lines.join('\n')).toMatch(/head changed .* → /);
    const newLog = w.show(r.newHead);
    expect(newLog).toBe(intro + e('Fixed', 2, 'Mine') + '\n' + mainLog.slice(intro.length));
    expect(newLog.endsWith(mainLog.slice(intro.length))).toBe(true);
    expect(w.show(r.newHead, 'a.txt')).toBe('a1\nPR\na3\na4\na5\na6\na7\nMAIN\n');
    const parent = execFileSync('git', ['-C', w.origin, 'rev-parse', `${r.newHead}^`], { encoding: 'utf8' }).trim();
    expect(parent).toBe(w.remote('main'));
    expect(execFileSync('git', ['-C', w.origin, 'log', '-1', '--format=%an|%B', r.newHead], { encoding: 'utf8' }).trim()).toBe('dev|#2 the fix');
    expect(w.state()).toEqual(before);
  });

  it('fetches and pushes by URL, and puts back any origin/* ref the push moved (git 2.56 does, even by URL)', async () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/2-mine');
    const pr = w.commit('#2 the fix', { 'CHANGELOG.md': log(e('Fixed', 2, 'Mine'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'fix/2-mine');
    w.g('checkout', '-q', 'main');
    w.commit('#3 main moves', { 'CHANGELOG.md': log(e('Fixed', 3, 'From main'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'main');
    const remotes = () => execFileSync('git', ['-C', w.validator, 'for-each-ref', 'refs/remotes/'], { encoding: 'utf8' });
    const remotesBefore = remotes();
    // What git 2.56 does on a push, even to a URL (CI run 44272994578): it moves the clone's origin/* tracking refs.
    // A pre-push hook does the same here, so the test fails on any git version if they are not put back.
    const hook = join(w.validator, '.git', 'hooks', 'pre-push');
    writeFileSync(hook, `#!/bin/sh\ngit update-ref refs/remotes/origin/fix/2-mine ${pr}\ngit update-ref refs/remotes/origin/main ${pr}\ngit update-ref -d refs/remotes/origin/HEAD\n`);
    chmodSync(hook, 0o755);
    const trace = join(w.dev, '..', 'trace.txt');
    await rebaseChangelogOnly({ repo: w.validator, branch: 'fix/2-mine', sha: pr, env: { ...ENV, GIT_TRACE: trace } });
    const cmds = readFileSync(trace, 'utf8').split('\n').filter((l) => /built-in: git (-C \S+ )?(fetch|push) /.test(l));
    expect(cmds.filter((c) => / fetch /.test(c))).toHaveLength(1);
    expect(cmds.filter((c) => / push /.test(c))).toHaveLength(1);
    for (const c of cmds) {
      expect(c).toContain(w.origin);
      expect(c).not.toMatch(/ 'origin' | origin /);
    }
    expect(remotes()).toBe(remotesBefore);
  });

  it('several commits, an entry with details written then edited: every commit replayed, the final entry on top', async () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'feat/4-big');
    w.commit('#4 part one', { 'b.txt': 'b1\nb2\n' });
    w.commit('#4 entry', { 'CHANGELOG.md': log(e('Added', 4, 'Big thing', 'First draft.'), e('Added', 1, 'First')) });
    const head = w.commit('#4 part two and details', {
      'c.txt': 'new file\n',
      'CHANGELOG.md': log(e('Added', 4, 'Big thing', 'Details line one.\n\n- and a list\n- of two'), e('Added', 1, 'First')),
    });
    w.g('push', '-q', 'origin', 'feat/4-big');
    w.g('checkout', '-q', 'main');
    w.commit('#5', { 'CHANGELOG.md': log(e('Fixed', 5, 'Five'), e('Added', 1, 'First')) });
    w.commit('#6', { 'CHANGELOG.md': log(e('Fixed', 6, 'Six'), e('Fixed', 5, 'Five'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'main');

    const r = await w.rebase('feat/4-big', head);

    expect(r.commits).toBe(3);
    const subjects = execFileSync('git', ['-C', w.origin, 'log', '--format=%s', `${r.onto}..${r.newHead}`], { encoding: 'utf8' }).trim().split('\n');
    expect(subjects).toEqual(['#4 part two and details', '#4 entry', '#4 part one']);
    expect(w.show(r.newHead)).toBe(log(e('Added', 4, 'Big thing', 'Details line one.\n\n- and a list\n- of two'), e('Fixed', 6, 'Six'), e('Fixed', 5, 'Five'), e('Added', 1, 'First')));
    expect(w.show(`${r.newHead}~1`)).toBe(log(e('Added', 4, 'Big thing', 'First draft.'), e('Fixed', 6, 'Six'), e('Fixed', 5, 'Five'), e('Added', 1, 'First')));
    expect(w.show(`${r.newHead}~2`)).toBe(w.show(r.onto)); // before the entry: main's file
    expect(w.show(r.newHead, 'c.txt')).toBe('new file\n');
    expect(w.show(r.newHead, 'b.txt')).toBe('b1\nb2\n');
  });

  it('another file conflicts too: refused, nothing pushed, validator clone untouched', async () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/7-x');
    const pr = w.commit('#7', { 'CHANGELOG.md': log(e('Fixed', 7, 'Seven'), e('Added', 1, 'First')), 'b.txt': 'from PR\n' });
    w.g('push', '-q', 'origin', 'fix/7-x');
    w.g('checkout', '-q', 'main');
    w.commit('#8', { 'CHANGELOG.md': log(e('Fixed', 8, 'Eight'), e('Added', 1, 'First')), 'b.txt': 'from main\n' });
    w.g('push', '-q', 'origin', 'main');
    const before = w.state();
    await expect(w.rebase('fix/7-x', pr)).rejects.toThrow(/conflicts with main in b\.txt \(and CHANGELOG\.md\): rebase it by hand/);
    expect(w.remote('fix/7-x')).toBe(pr);
    expect(w.state()).toEqual(before);
  });

  it('the head moved since the validation: refused, nothing pushed', async () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/9-x');
    const reviewed = w.commit('#9', { 'CHANGELOG.md': log(e('Fixed', 9, 'Nine'), e('Added', 1, 'First')) });
    const later = w.commit('#9 more', { 'b.txt': 'later\n' });
    w.g('push', '-q', 'origin', 'fix/9-x');
    w.g('checkout', '-q', 'main');
    w.commit('#10', { 'CHANGELOG.md': log(e('Fixed', 10, 'Ten'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'main');
    await expect(w.rebase('fix/9-x', reviewed)).rejects.toThrow(/not the validated .*pushed after the review/);
    expect(w.remote('fix/9-x')).toBe(later);
  });

  it('the head moves while it is being rebased: the push is refused (lease), the new commit stays', async () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/16-x');
    const reviewed = w.commit('#16', { 'CHANGELOG.md': log(e('Fixed', 16, 'Sixteen'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'fix/16-x');
    const sneaky = w.commit('#16 pushed during the rebase', { 'b.txt': 'sneaky\n' });
    w.g('checkout', '-q', 'main');
    w.commit('#17', { 'CHANGELOG.md': log(e('Fixed', 17, 'Seventeen'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'main');
    // The author pushes at the last moment: from the validator's pre-push hook, after the rebase was built.
    const hook = join(w.validator, '.git/hooks/pre-push');
    writeFileSync(hook, `#!/bin/sh\ngit -C "${w.dev}" push -q origin ${sneaky}:refs/heads/fix/16-x\n`, { mode: 0o755 });
    await expect(w.rebase('fix/16-x', reviewed)).rejects.toThrow(/not pushed .*moved/);
    expect(w.remote('fix/16-x')).toBe(sneaky);
  });

  it('refuses a PR that also edits an older entry, a PR with a merge commit, and main itself', async () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/11-x');
    const edits = w.commit('#11', { 'CHANGELOG.md': log(e('Fixed', 11, 'Eleven'), e('Added', 1, 'First', 'edited body')) });
    w.g('push', '-q', 'origin', 'fix/11-x');
    w.g('checkout', '-q', 'main');
    w.commit('#12', { 'CHANGELOG.md': log(e('Fixed', 12, 'Twelve'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'main');
    await expect(w.rebase('fix/11-x', edits)).rejects.toThrow(/more than its new top entry/);
    expect(w.remote('fix/11-x')).toBe(edits);

    w.g('checkout', '-q', '-b', 'fix/13-x', 'main~1');
    w.commit('#13 side', { 'b.txt': 'side\n' });
    w.g('merge', '-q', '--no-ff', '-m', 'merge', 'fix/11-x');
    const merged = w.g('rev-parse', 'HEAD');
    w.g('push', '-q', 'origin', 'fix/13-x');
    await expect(w.rebase('fix/13-x', merged)).rejects.toThrow(/merge commits/);

    await expect(w.rebase('main', w.remote('main'))).rejects.toThrow(/will not rewrite "main"/);
  });

  it('a PR without conflict, or already on main: refused (nothing to rebase)', async () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/14-x');
    const pr = w.commit('#14', { 'CHANGELOG.md': log(e('Fixed', 14, 'Fourteen'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'fix/14-x');
    await expect(w.rebase('fix/14-x', pr)).rejects.toThrow(/already contains main/);
    w.g('checkout', '-q', 'main');
    w.commit('#15 code only', { 'c.txt': 'x\n' });
    w.g('push', '-q', 'origin', 'main');
    await expect(w.rebase('fix/14-x', pr)).rejects.toThrow(/without conflict/);
    expect(readFileSync(join(w.dev, 'c.txt'), 'utf8')).toBe('x\n');
  });
});

/**
 * A fake `gh` backed by the world's bare « GitHub » (#195): the PR is read from the real refs, GitHub runs no CI on a
 * conflicting head (no check run on the old head), and CI on any other head is green after `pollsBeforeGreen` polls.
 * Merge = a real merge commit pushed to main from the dev clone, pinned to the sha like GitHub's.
 */
function fakeGitHub(w: ReturnType<typeof world>, branch: string, opts: { oldHeadCi?: unknown[]; pollsBeforeGreen?: number } = {}) {
  const calls: string[][] = [];
  const git = (...a: string[]) => execFileSync('git', ['-C', w.origin, ...a], { encoding: 'utf8', env: { ...process.env, ...ENV } }).trim();
  const oldHead = w.remote(branch);
  const polls = new Map<string, number>();
  // git merge-tree exits 1 when the merge conflicts: GitHub's `mergeable: false`.
  const mergeable = (head: string) => spawnSync('git', ['-C', w.origin, 'merge-tree', '--write-tree', 'main', head], { stdio: 'ignore' }).status === 0;
  const gh = (args: string[]) => {
    calls.push(args);
    const path = args[1]!;
    const head = w.remote(branch);
    if (/\/pulls\/2$/.test(path))
      return JSON.stringify({ state: 'open', draft: false, merged: false, mergeable: mergeable(head), base: { ref: 'main' }, head: { sha: head, ref: branch, repo: { full_name: 'csoylu/atlas' } }, number: 2 });
    const runs = path.match(/commits\/([0-9a-f]{40})\/check-runs/);
    if (runs) {
      const sha = runs[1]!;
      if (sha === oldHead) return JSON.stringify({ check_runs: opts.oldHeadCi ?? [] });
      const n = (polls.get(sha) ?? 0) + 1;
      polls.set(sha, n);
      return JSON.stringify({ check_runs: n > (opts.pollsBeforeGreen ?? 1) ? [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] : [] });
    }
    const cmp = path.match(/compare\/main\.\.\.([0-9a-f]{40})$/);
    if (cmp) return JSON.stringify({ merge_base_commit: { sha: git('merge-base', 'main', cmp[1]!) } });
    const file = path.match(/contents\/CHANGELOG\.md\?ref=([0-9a-f]{40})$/);
    if (file) return w.show(file[1]!);
    if (/\/statuses\//.test(path)) return '{}';
    if (/\/pulls\/2\/merge$/.test(path)) {
      const sha = args.find((a) => a.startsWith('sha='))!.slice(4);
      if (sha !== head) throw new Error('409 head changed');
      w.g('fetch', '-q', 'origin');
      w.g('checkout', '-q', 'main');
      w.g('reset', '-q', '--hard', 'origin/main');
      w.g('merge', '-q', '--no-ff', '-m', `Merge pull request #2`, sha);
      w.g('push', '-q', 'origin', 'main');
      return JSON.stringify({ sha: w.g('rev-parse', 'HEAD'), merged: true });
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { gh, calls, oldHead, statuses: () => calls.filter((c) => /\/statuses\//.test(c[1]!)) };
}

describe('validate.mjs --ok --merge on real git repos: no CI on a conflicting head (#195)', { timeout: 60_000 }, () => {
  const conflicting = () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/2-mine');
    w.commit('#2 the fix', { 'CHANGELOG.md': log(e('Fixed', 2, 'Mine'), e('Added', 1, 'First')), 'a.txt': 'a1\nPR\na3\na4\na5\na6\na7\na8\n' });
    w.g('push', '-q', 'origin', 'fix/2-mine');
    w.g('checkout', '-q', 'main');
    w.commit('#3 main moves', { 'CHANGELOG.md': log(e('Fixed', 3, 'From main'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'main');
    return w;
  };
  const opts = (sha: string, merge = true) => ({ pr: 2, verdict: 'success', sha, as: 'zurich', reason: 'read it', merge, base: 'main' });
  const deps = (w: ReturnType<typeof world>) => ({
    rebase: (a: Record<string, string>) => rebaseChangelogOnly({ repo: w.validator, env: ENV, ...a }),
    wait: { sleep: () => {}, everyMs: 0 },
    log: () => {},
  });

  it('changelog-only conflict, CI never ran on the head: rebases, waits for CI on the new head, validates and merges it', async () => {
    const w = conflicting();
    const f = fakeGitHub(w, 'fix/2-mine', { pollsBeforeGreen: 2 });
    const out = (await validate(opts(f.oldHead), f.gh, deps(w))).join('\n');
    const newHead = w.remote('fix/2-mine');
    expect(newHead).not.toBe(f.oldHead);
    expect(f.calls.filter((c) => c[1]!.includes(`commits/${newHead}/check-runs`))).toHaveLength(3); // not run, not run, green
    expect(f.statuses()).toHaveLength(1);
    expect(f.statuses()[0]![1]).toBe(`repos/csoylu/atlas/statuses/${newHead}`);
    expect(f.statuses()[0]).toContain('state=success');
    expect(out).toMatch(/merged PR #2/);
    const main = w.remote('main');
    expect(execFileSync('git', ['-C', w.origin, 'rev-parse', `${main}^2`], { encoding: 'utf8' }).trim()).toBe(newHead);
    expect(w.show(main)).toBe(log(e('Fixed', 2, 'Mine'), e('Fixed', 3, 'From main'), e('Added', 1, 'First')));
  });

  it('CI that did run on the old head still counts: red or running there is refused, nothing rebased', async () => {
    for (const ci of [
      [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }],
      [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }],
    ]) {
      const w = conflicting();
      const f = fakeGitHub(w, 'fix/2-mine', { oldHeadCi: ci });
      await expect(validate(opts(f.oldHead), f.gh, deps(w))).rejects.toThrow(/refused: CI job "test" is (failure|still running)/);
      expect(w.remote('fix/2-mine')).toBe(f.oldHead);
      expect(f.statuses()).toHaveLength(0);
    }
  });

  it('without --merge a conflicting PR is refused as before', async () => {
    const w = conflicting();
    const f = fakeGitHub(w, 'fix/2-mine');
    await expect(validate(opts(f.oldHead, false), f.gh, deps(w))).rejects.toThrow(/conflicts with main: rebase it/);
    expect(w.remote('fix/2-mine')).toBe(f.oldHead);
    expect(f.statuses()).toHaveLength(0);
  });

  it('a PR without conflict and without CI is refused as before, with or without --merge', async () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/2-mine');
    w.commit('#2 the fix', { 'CHANGELOG.md': log(e('Fixed', 2, 'Mine'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'fix/2-mine');
    const f = fakeGitHub(w, 'fix/2-mine', { oldHeadCi: [] });
    for (const merge of [true, false]) await expect(validate(opts(f.oldHead, merge), f.gh, deps(w))).rejects.toThrow(/has not run on .* yet/);
    expect(f.statuses()).toHaveLength(0);
    expect(f.calls.some((c) => /\/merge$/.test(c[1]!))).toBe(false);
  });
});
