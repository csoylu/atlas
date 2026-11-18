import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module (a script run with node)
import { moveEntry, rebaseChangelogOnly } from './rebase-changelog.mjs';

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
  it('puts the PR entry (with its details) above main’s entries, main’s text unchanged', () => {
    const pr = log(e('Fixed', 2, 'Mine', 'Line one.\n\n- detail'), e('Added', 1, 'First'));
    expect(moveEntry(pr, base, main)).toBe(intro + e('Fixed', 2, 'Mine', 'Line one.\n\n- detail') + '\n' + e('Fixed', 3, 'From main', 'Main details.') + '\n' + e('Added', 1, 'First'));
  });
  it('a commit before the entry exists gives main’s file as it is', () => {
    expect(moveEntry(base, base, main)).toBe(main);
  });
  it('refuses a PR that edits the intro or an older entry', () => {
    expect(() => moveEntry(log(e('Fixed', 2, 'Mine'), e('Added', 1, 'First', 'typo fix')), base, main)).toThrow(/more than its new top entry/);
    expect(() => moveEntry(base.replace('Newest', 'Latest'), base, main)).toThrow(/more than its new top entry/);
  });
});

describe('rebaseChangelogOnly on real git repos', { timeout: 60_000 }, () => {
  it('changelog-only conflict: rebased, entry on top, older entries byte-identical, code unchanged, validator clone untouched', () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/2-mine');
    const pr = w.commit('#2 the fix', { 'CHANGELOG.md': log(e('Fixed', 2, 'Mine'), e('Added', 1, 'First')), 'a.txt': 'a1\nPR\na3\na4\na5\na6\na7\na8\n' });
    w.g('push', '-q', 'origin', 'fix/2-mine');
    w.g('checkout', '-q', 'main');
    w.commit('#3 main moves', { 'CHANGELOG.md': log(e('Fixed', 3, 'From main', 'Main details.'), e('Added', 1, 'First')), 'a.txt': 'a1\na2\na3\na4\na5\na6\na7\nMAIN\n' });
    w.g('push', '-q', 'origin', 'main');
    const mainLog = w.show(w.remote('main'));
    const before = w.state();

    const r = w.rebase('fix/2-mine', pr.slice(0, 7));

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

  it('several commits, an entry with details written then edited: every commit replayed, the final entry on top', () => {
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

    const r = w.rebase('feat/4-big', head);

    expect(r.commits).toBe(3);
    const subjects = execFileSync('git', ['-C', w.origin, 'log', '--format=%s', `${r.onto}..${r.newHead}`], { encoding: 'utf8' }).trim().split('\n');
    expect(subjects).toEqual(['#4 part two and details', '#4 entry', '#4 part one']);
    expect(w.show(r.newHead)).toBe(log(e('Added', 4, 'Big thing', 'Details line one.\n\n- and a list\n- of two'), e('Fixed', 6, 'Six'), e('Fixed', 5, 'Five'), e('Added', 1, 'First')));
    expect(w.show(`${r.newHead}~1`)).toBe(log(e('Added', 4, 'Big thing', 'First draft.'), e('Fixed', 6, 'Six'), e('Fixed', 5, 'Five'), e('Added', 1, 'First')));
    expect(w.show(`${r.newHead}~2`)).toBe(w.show(r.onto)); // before the entry: main's file
    expect(w.show(r.newHead, 'c.txt')).toBe('new file\n');
    expect(w.show(r.newHead, 'b.txt')).toBe('b1\nb2\n');
  });

  it('another file conflicts too: refused, nothing pushed, validator clone untouched', () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/7-x');
    const pr = w.commit('#7', { 'CHANGELOG.md': log(e('Fixed', 7, 'Seven'), e('Added', 1, 'First')), 'b.txt': 'from PR\n' });
    w.g('push', '-q', 'origin', 'fix/7-x');
    w.g('checkout', '-q', 'main');
    w.commit('#8', { 'CHANGELOG.md': log(e('Fixed', 8, 'Eight'), e('Added', 1, 'First')), 'b.txt': 'from main\n' });
    w.g('push', '-q', 'origin', 'main');
    const before = w.state();
    expect(() => w.rebase('fix/7-x', pr)).toThrow(/conflicts with main in b\.txt \(and CHANGELOG\.md\): rebase it by hand/);
    expect(w.remote('fix/7-x')).toBe(pr);
    expect(w.state()).toEqual(before);
  });

  it('the head moved since the validation: refused, nothing pushed', () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/9-x');
    const reviewed = w.commit('#9', { 'CHANGELOG.md': log(e('Fixed', 9, 'Nine'), e('Added', 1, 'First')) });
    const later = w.commit('#9 more', { 'b.txt': 'later\n' });
    w.g('push', '-q', 'origin', 'fix/9-x');
    w.g('checkout', '-q', 'main');
    w.commit('#10', { 'CHANGELOG.md': log(e('Fixed', 10, 'Ten'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'main');
    expect(() => w.rebase('fix/9-x', reviewed)).toThrow(/not the validated .*pushed after the review/);
    expect(w.remote('fix/9-x')).toBe(later);
  });

  it('the head moves while it is being rebased: the push is refused (lease), the new commit stays', () => {
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
    expect(() => w.rebase('fix/16-x', reviewed)).toThrow(/not pushed .*moved/);
    expect(w.remote('fix/16-x')).toBe(sneaky);
  });

  it('refuses a PR that also edits an older entry, a PR with a merge commit, and main itself', () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/11-x');
    const edits = w.commit('#11', { 'CHANGELOG.md': log(e('Fixed', 11, 'Eleven'), e('Added', 1, 'First', 'edited body')) });
    w.g('push', '-q', 'origin', 'fix/11-x');
    w.g('checkout', '-q', 'main');
    w.commit('#12', { 'CHANGELOG.md': log(e('Fixed', 12, 'Twelve'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'main');
    expect(() => w.rebase('fix/11-x', edits)).toThrow(/more than its new top entry/);
    expect(w.remote('fix/11-x')).toBe(edits);

    w.g('checkout', '-q', '-b', 'fix/13-x', 'main~1');
    w.commit('#13 side', { 'b.txt': 'side\n' });
    w.g('merge', '-q', '--no-ff', '-m', 'merge', 'fix/11-x');
    const merged = w.g('rev-parse', 'HEAD');
    w.g('push', '-q', 'origin', 'fix/13-x');
    expect(() => w.rebase('fix/13-x', merged)).toThrow(/merge commits/);

    expect(() => w.rebase('main', w.remote('main'))).toThrow(/will not rewrite "main"/);
  });

  it('a PR without conflict, or already on main: refused (nothing to rebase)', () => {
    const w = world();
    w.g('checkout', '-q', '-b', 'fix/14-x');
    const pr = w.commit('#14', { 'CHANGELOG.md': log(e('Fixed', 14, 'Fourteen'), e('Added', 1, 'First')) });
    w.g('push', '-q', 'origin', 'fix/14-x');
    expect(() => w.rebase('fix/14-x', pr)).toThrow(/already contains main/);
    w.g('checkout', '-q', 'main');
    w.commit('#15 code only', { 'c.txt': 'x\n' });
    w.g('push', '-q', 'origin', 'main');
    expect(() => w.rebase('fix/14-x', pr)).toThrow(/without conflict/);
    expect(readFileSync(join(w.dev, 'c.txt'), 'utf8')).toBe('x\n');
  });
});
