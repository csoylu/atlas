import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module (run by CI with node before npm ci)
import { bump, checkPush, notesOf, parseChangelog, versionOf } from './changelog.mjs';

const head = '# Changelog\n\nIntro text.\n\n';
const file = (...entries: string[]) => head + entries.join('\n\n') + '\n';

describe('changelog version', () => {
  it('starts at 0.3.0 and replays from the oldest entry to the newest', () => {
    expect(versionOf(head)).toBe('0.3.0');
    expect(versionOf(file('## Fixed · #1 · a'))).toBe('0.3.1');
    expect(versionOf(file('## Added · #2 · b', '## Fixed · #1 · a'))).toBe('0.4.0');
    expect(versionOf(file('## Fixed · c', '## Changed · #2 · b', '## Fixed · #1 · a'))).toBe('0.4.1');
    expect(versionOf(file('## Breaking · d', '## Fixed · c', '## Added · b'))).toBe('1.0.0');
  });

  it('bumps per kind (Semantic Versioning)', () => {
    expect(bump('0.3.1', 'Fixed')).toBe('0.3.2');
    expect(bump('0.3.2', 'Added')).toBe('0.4.0');
    expect(bump('0.3.2', 'Changed')).toBe('0.4.0');
    expect(bump('1.4.2', 'Breaking')).toBe('2.0.0');
  });

  it('the same file always gives the same version, and the real CHANGELOG.md parses', () => {
    const text = readFileSync(join(import.meta.dirname, '../../CHANGELOG.md'), 'utf8');
    expect(versionOf(text)).toBe(versionOf(text));
    expect(versionOf(text)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(parseChangelog(text).length).toBeGreaterThan(10);
  });

  it('parses kind, task, sentence and body; ignores ## inside code fences', () => {
    const [e] = parseChangelog(file('## Fixed · #12 · The thing works\n\nDetails\n```\n## not a heading\n```'));
    expect(e).toMatchObject({ kind: 'Fixed', task: 12, title: 'The thing works' });
    expect(e.body).toContain('## not a heading');
    expect(parseChangelog(file('## Added · No task here'))[0]).toMatchObject({ task: null, title: 'No task here' });
  });

  it('refuses an unknown kind or a heading without a sentence', () => {
    expect(() => versionOf(file('## Removed · #1 · x'))).toThrow(/unknown kind « Removed »/);
    expect(() => versionOf(file('## Fixed · #1'))).toThrow(/has no sentence/);
  });

  it('notes = the newest entry', () => {
    expect(notesOf(file('## Fixed · #2 · New\n\nBody', '## Added · Old'))).toBe('## Fixed · #2 · New\n\nBody\n');
    expect(notesOf(file('## Fixed · Only'))).toBe('## Fixed · Only\n');
  });
});

describe('CI entry check (one push = one entry)', () => {
  const before = file('## Added · #1 · a');
  it('accepts exactly one new entry on top', () => {
    expect(checkPush(before, file('## Fixed · #2 · b', '## Added · #1 · a'))).toBeNull();
    expect(checkPush(null, file('## Fixed · first'))).toBeNull();
  });
  it('refuses no entry, two entries, a removed entry, an entry not on top, an edited heading', () => {
    expect(checkPush(before, before)).toMatch(/adds no CHANGELOG.md entry/);
    expect(checkPush(before, file('## Fixed · c', '## Fixed · b', '## Added · #1 · a'))).toMatch(/adds 2 CHANGELOG.md entries/);
    expect(checkPush(file('## Fixed · b', '## Added · #1 · a'), before)).toMatch(/removes 1 CHANGELOG.md entry/);
    expect(checkPush(before, file('## Added · #1 · a', '## Fixed · b'))).toMatch(/must be on top/);
    expect(checkPush(before, file('## Fixed · b', '## Changed · #1 · a'))).toMatch(/must be on top/);
    expect(checkPush(before, file('## Bogus · b', '## Added · #1 · a'))).toMatch(/unknown kind/);
  });
  it('body edits of older entries are allowed (typos), headings are not', () => {
    expect(checkPush(file('## Added · #1 · a\n\nold'), file('## Fixed · b', '## Added · #1 · a\n\nfixed typo'))).toBeNull();
  });

  it('check-push.sh against real git history: first release, one entry, none, two', () => {
    const repo = mkdtempSync(join(tmpdir(), 'atlas-changelog-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    const script = join(import.meta.dirname, 'check-push.sh');
    const commit = (text: string, withScript = true) => {
      writeFileSync(join(repo, 'CHANGELOG.md'), text);
      execFileSync('mkdir', ['-p', join(repo, 'scripts/release')]);
      if (withScript) writeFileSync(join(repo, 'scripts/release/changelog.mjs'), '// marker');
      git('add', '-A');
      git('commit', '-qm', 'c');
      return git('rev-parse', 'HEAD');
    };
    const run = (beforeSha: string) => spawnSync(script, [beforeSha], { cwd: repo, encoding: 'utf8' });
    const c0 = commit(file('## Added · a', '## Added · b', '## Fixed · c'), false); // history before the check existed
    const c1 = commit(file('## Fixed · d', '## Added · a', '## Added · b', '## Fixed · c'));
    expect(run(c0).status).toBe(0); // bootstrap: no check before this push
    expect(run(c0).stdout).toContain('first release');
    commit(file('## Fixed · e', '## Fixed · d', '## Added · a', '## Added · b', '## Fixed · c'));
    expect(run(c1).status).toBe(0);
    const c3 = git('rev-parse', 'HEAD');
    commit(file('## Fixed · e', '## Fixed · d', '## Added · a', '## Added · b', '## Fixed · c') + '\nmore text\n');
    expect(run(c3).status).toBe(1);
    expect(run(c3).stderr).toMatch(/adds no CHANGELOG.md entry/);
    expect(run(c1).status).toBe(0); // c1..HEAD still adds one (e)
    commit(file('## Fixed · g', '## Fixed · f', '## Fixed · e', '## Fixed · d', '## Added · a', '## Added · b', '## Fixed · c'));
    expect(run(c3).stderr).toMatch(/adds 2 CHANGELOG.md entries/);
    expect(run('0000000000000000000000000000000000000000').status).toBe(0); // new branch push: nothing to compare
  });
});
