import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module (run by CI with node before npm ci)
import { bump, changelogRule, fullOf, notesOf, parseChangelog, parseEntry, versionOf, versionsOf } from './changelog.mjs';

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

  it('the frozen history gives exactly the version the last CHANGELOG.md gave on main before #223 (0.48.1)', () => {
    const text = readFileSync(join(import.meta.dirname, '../../changelog/history.md'), 'utf8');
    expect(versionOf(text)).toBe('0.48.1');
    const entries = parseChangelog(text);
    expect(entries.length).toBe(72);
    expect(entries[0].heading).toMatch(/^Fixed · #224 · /); // the newest entry of CHANGELOG.md at e51cfd0
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

  it('notes = the newest entry; full = every entry newest first, with the version each gave', () => {
    const entries = parseChangelog(file('## Fixed · #2 · New\n\nBody', '## Added · Old'));
    expect(notesOf(entries)).toBe('## Fixed · #2 · New\n\nBody\n');
    expect(versionsOf(entries)).toEqual(['0.4.1', '0.4.0']);
    const full = fullOf(entries);
    expect(full).toMatch(/^# Changelog\n/);
    expect(full.indexOf('## 0.4.1 · Fixed · #2 · New\n\nBody')).toBeLessThan(full.indexOf('## 0.4.0 · Added · Old'));
  });
});

describe('entry files (#223)', () => {
  it('reads one entry: heading on the first line, task = the file number', () => {
    expect(parseEntry('## Fixed · #12 · It works\n\nDetails\n\n### More\n', 'changelog/12-it-works.md')).toMatchObject({ kind: 'Fixed', task: 12, title: 'It works', body: 'Details\n\n### More', path: 'changelog/12-it-works.md' });
  });
  it('refuses a bad name, no heading first, two entries, another task or none', () => {
    expect(() => parseEntry('## Fixed · #12 · a\n', 'changelog/It-Works.md')).toThrow(/not an entry file name/);
    expect(() => parseEntry('## Fixed · #12 · a\n', 'changelog/12-a.txt')).toThrow(/not an entry file name/);
    expect(() => parseEntry('Intro\n\n## Fixed · #12 · a\n', 'changelog/12-a.md')).toThrow(/first line must be the heading/);
    expect(() => parseEntry('## Fixed · #12 · a\n\n## Details\n', 'changelog/12-a.md')).toThrow(/unknown kind « Details »/);
    expect(() => parseEntry('## Fixed · #12 · a\n\n## Fixed · #12 · b\n', 'changelog/12-a.md')).toThrow(/holds 2 entries/);
    expect(() => parseEntry('## Fixed · #13 · a\n', 'changelog/12-a.md')).toThrow(/task \(#13\) must be the file's number, #12/);
    expect(() => parseEntry('## Fixed · a\n', 'changelog/12-a.md')).toThrow(/task \(none\)/);
  });
  it('the rule: exactly one new file in changelog/, no other changelog file touched', () => {
    const add = (path: string) => ({ path, status: 'added' });
    expect(changelogRule([{ path: 'src/a.ts', status: 'modified' }, add('changelog/2-b.md')])).toEqual({ file: 'changelog/2-b.md' });
    expect(changelogRule([add('changelog/history.md'), add('changelog/2-b.md'), { path: 'CHANGELOG.md', status: 'removed' }])).toEqual({ file: 'changelog/2-b.md' });
    expect(changelogRule([{ path: 'src/a.ts', status: 'modified' }]).problem).toMatch(/no new changelog entry/);
    expect(changelogRule([{ path: 'CHANGELOG.md', status: 'modified' }]).problem).toMatch(/no new changelog entry/);
    expect(changelogRule([add('changelog/2-b.md'), add('changelog/3-c.md')]).problem).toMatch(/2 new changelog entries/);
    expect(changelogRule([add('changelog/2-b.md'), { path: 'changelog/1-a.md', status: 'modified' }]).problem).toMatch(/1-a\.md is changed/);
    expect(changelogRule([add('changelog/2-b.md'), { path: 'changelog/1-a.md', status: 'removed' }]).problem).toMatch(/1-a\.md is removed/);
    expect(changelogRule([add('changelog/2-b.md'), { path: 'changelog/history.md', status: 'modified' }]).problem).toMatch(/history\.md is changed/);
  });
});
