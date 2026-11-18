import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module (run by CI with node before npm ci)
import { versionOf } from './changelog.mjs';
import { zipName } from '../../packages/engine/src/updater.ts';

/**
 * QA of the release pipeline (#124): the rules in docs/updater.md as tests that need no GitHub. The workflow file is read
 * as text (its job graph), the version and the one-entry check are run against real git history. What only the real
 * CI can show (timings, tags, the release page) is in docs/qa/124-updater-report.md with the run ids.
 */
const root = join(import.meta.dirname, '..', '..');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

/** job id → { needs, if, text } from the workflow (jobs are the 2-space-indented keys under « jobs: »). */
function jobs(): Record<string, { needs: string[]; cond: string | null; text: string }> {
  const body = ci.slice(ci.indexOf('\njobs:\n') + 6);
  const out: Record<string, { needs: string[]; cond: string | null; text: string }> = {};
  for (const m of body.matchAll(/^ {2}([a-z][\w-]*):\n((?: {4}.*\n|\s*\n|\s*#.*\n)*)/gm)) {
    const text = m[2]!;
    const needs = /^ {4}needs: \[([^\]]*)\]/m.exec(text)?.[1]?.split(',').map((s) => s.trim()) ?? [];
    out[m[1]!] = { needs, cond: /^ {4}if: (.*)$/m.exec(text)?.[1] ?? null, text };
  }
  return out;
}

describe('CI job graph (docs/updater.md step 3)', () => {
  const j = jobs();

  it('has the jobs the design names', () => {
    expect(Object.keys(j)).toEqual(['changelog', 'test', 'mac', 'release', 'windows']);
  });

  it('no release without green tests: the Mac build needs `test` and `changelog`, the release needs the Mac build', () => {
    expect(j.mac!.needs).toEqual(expect.arrayContaining(['changelog', 'test']));
    expect(j.release!.needs).toContain('mac');
    expect(j.windows!.needs).toContain('release'); // a Windows failure comes after the Mac release, it cannot block it
  });

  it('tests run typecheck and the test suite, on pull requests too (they only run `test`)', () => {
    expect(j.test!.cond).toBeNull();
    expect(j.test!.text).toContain('npm run typecheck');
    expect(j.test!.text).toMatch(/npm test\b/);
    // every job that builds or publishes hangs off `changelog`, which is skipped on pull requests
    expect(j.changelog!.cond).toBe("github.event_name != 'pull_request'");
    for (const id of ['mac', 'release', 'windows']) expect(j[id]!.needs.length).toBeGreaterThan(0);
    expect(j.mac!.needs).toContain('changelog');
    expect(j.release!.needs).toContain('changelog');
    expect(j.windows!.needs).toContain('changelog');
    expect(j.release!.cond).toBeNull(); // no `if: always()` that would let it run after a skipped dependency
    expect(ci).not.toMatch(/always\(\)|continue-on-error/);
  });

  it('only a push to main publishes; a manual run makes a pre-release the app ignores', () => {
    expect(ci).toMatch(/on:\n {2}push:\n {4}branches: \[main\]/);
    expect(j.changelog!.text).toContain('-test.');
    expect(j.changelog!.text).toContain('prerelease=true');
    expect(j.release!.text).toContain('--prerelease');
  });

  it('the one-entry check runs on pushes only, before anything is built, with the push\'s « before » commit and full history', () => {
    expect(j.changelog!.text).toContain('fetch-depth: 0');
    expect(j.changelog!.text).toMatch(/if: github\.event_name == 'push'[\s\S]*check-push\.sh "\$BEFORE"/);
    expect(j.changelog!.text).toContain('github.event.before');
  });

  it('a version that already has a tag fails the push (no silent overwrite of a release)', () => {
    expect(j.changelog!.text).toMatch(/refs\/tags\/v\$v[\s\S]*already exists/);
  });

  it('the release notes are the newest entry, and the version given to the build is the changelog\'s', () => {
    expect(j.release!.text).toContain('node scripts/release/changelog.mjs notes');
    expect(j.release!.text).toContain('--notes-file');
    expect(j.mac!.text).toContain('extraMetadata.version=${{ needs.changelog.outputs.version }}');
  });

  it('each chip is built on its own runner, and the files the updater downloads are uploaded', () => {
    expect(j.mac!.text).toContain('arch: arm64');
    expect(j.mac!.text).toContain('arch: x64');
    expect(j.mac!.text).toMatch(/--mac dmg zip/);
    expect(j.mac!.text).toContain('Atlas-*.zip');
    expect(j.release!.text).toContain('SHA256SUMS.txt');
  });

  it('the zip name the updater asks for is the one electron-builder produces (artifactName template)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')) as { build: { productName?: string; mac: { artifactName: string } } };
    const name = pkg.build.mac.artifactName.replace('${productName}', pkg.build.productName ?? 'Atlas').replace('${version}', '0.5.0').replace('${arch}', 'arm64').replace('${ext}', 'zip');
    expect(name).toBe(zipName('0.5.0', 'arm64'));
    expect(pkg.build.mac.artifactName).toContain('${arch}'); // two chips: the names must differ
  });
});

/** A throwaway repo that has the real release scripts, and a changelog that grows one push at a time. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-pipeline-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'qa@test');
  git('config', 'user.name', 'qa');
  mkdirSync(join(dir, 'scripts/release'), { recursive: true });
  for (const f of ['changelog.mjs', 'check-push.sh']) writeFileSync(join(dir, 'scripts/release', f), readFileSync(join(root, 'scripts/release', f)), { mode: 0o755 });
  const log = join(dir, 'CHANGELOG.md');
  writeFileSync(log, '# Changelog\n\nIntro.\n\n## Added · #1 · The first entry\n');
  git('add', '-A');
  git('commit', '-qm', 'start');
  const sha = () => git('rev-parse', 'HEAD');
  /** A push: new content, one commit; returns { before, after, check, version }. */
  const push = (edit: (text: string) => string, message = 'push') => {
    const before = sha();
    writeFileSync(log, edit(readFileSync(log, 'utf8')));
    git('add', '-A');
    git('commit', '-qm', message);
    const check = spawnSync('scripts/release/check-push.sh', [before], { cwd: dir, encoding: 'utf8' });
    const v = spawnSync('node', ['scripts/release/changelog.mjs', 'version'], { cwd: dir, encoding: 'utf8' });
    return { before, after: sha(), check, version: v.stdout.trim() };
  };
  const entry = (kind: string, title: string) => (t: string) => t.replace('## ', `## ${kind} · ${title}\n\n## `);
  return { dir, git, push, entry, log };
}

// Real git repos + bash: slow when the machine is loaded (load 50-90 gave >5 s), so a generous timeout for the whole block.
describe('releases from real git history (docs/updater.md steps 1-3)', { timeout: 60_000 }, () => {
  it('a push with exactly one entry passes and gets the next version; the notes are that entry', () => {
    const r = repo();
    const p = r.push(r.entry('Fixed', '#2 · Something is fixed'));
    expect(p.check.status).toBe(0);
    expect(p.version).toBe('0.4.1');
    const notes = spawnSync('node', ['scripts/release/changelog.mjs', 'notes'], { cwd: r.dir, encoding: 'utf8' }).stdout;
    expect(notes).toBe('## Fixed · #2 · Something is fixed\n');
  });

  it('a push with no entry fails, a push with two entries fails (even if both are valid), a push that only edits the intro fails', () => {
    const r = repo();
    const none = r.push((t) => t + '\nmore body text\n');
    expect(none.check.status).toBe(1);
    expect(none.check.stderr).toMatch(/adds no CHANGELOG.md entry/);
    const intro = r.push((t) => t.replace('Intro.', 'A new intro.'));
    expect(intro.check.status).toBe(1);
    const two = r.push((t) => r.entry('Fixed', 'b')(r.entry('Fixed', 'a')(t)));
    expect(two.check.status).toBe(1);
    expect(two.check.stderr).toMatch(/adds 2 CHANGELOG.md entries/);
  });

  it('a push that deletes CHANGELOG.md, or leaves a heading with an unknown kind, fails with a message', () => {
    const r = repo();
    const bad = r.push(r.entry('Improved', 'x'));
    expect(bad.check.status).toBe(1);
    expect(bad.check.stderr).toMatch(/unknown kind « Improved »/);
    r.git('reset', '-q', '--hard', 'HEAD~1');
    r.git('rm', '-q', 'CHANGELOG.md');
    r.git('commit', '-qm', 'rm');
    const before = r.git('rev-parse', 'HEAD~1');
    const del = spawnSync('scripts/release/check-push.sh', [before], { cwd: r.dir, encoding: 'utf8' });
    expect(del.status).not.toBe(0);
  });

  it('a heading level 2 inside an entry\'s body is read as a new entry: the push fails and says why (agents: use ###)', () => {
    const r = repo();
    const p = r.push(r.entry('Fixed', '#3 · With details\n\n## Details\n\ntext'));
    expect(p.check.status).toBe(1);
    expect(p.check.stderr).toMatch(/unknown kind « Details »/);
  });

  it('each kind raises the right part: Fixed patch, Added and Changed minor (patch back to 0), Breaking major (minor and patch back to 0)', () => {
    const r = repo();
    const seen: Record<string, string> = {};
    seen.start = r.push(r.entry('Fixed', 'a')).version; // 0.4.0 → 0.4.1
    seen.fixed = r.push(r.entry('Fixed', 'b')).version;
    seen.added = r.push(r.entry('Added', 'c')).version;
    seen.fixedAgain = r.push(r.entry('Fixed', 'd')).version;
    seen.changed = r.push(r.entry('Changed', 'e')).version;
    seen.breaking = r.push(r.entry('Breaking', 'f')).version;
    seen.afterBreaking = r.push(r.entry('Added', 'g')).version;
    expect(seen).toEqual({ start: '0.4.1', fixed: '0.4.2', added: '0.5.0', fixedAgain: '0.5.1', changed: '0.6.0', breaking: '1.0.0', afterBreaking: '1.1.0' });
  });

  it('pushes close together: every push gets its own version, strictly increasing in merge order, whichever build finishes first', () => {
    const r = repo();
    const pushes = [r.push(r.entry('Fixed', 'a')), r.push(r.entry('Added', 'b')), r.push(r.entry('Fixed', 'c')), r.push(r.entry('Fixed', 'd'))];
    expect(pushes.every((p) => p.check.status === 0)).toBe(true);
    const versions = pushes.map((p) => p.version);
    expect(new Set(versions).size).toBe(4);
    expect(versions).toEqual(['0.4.1', '0.5.0', '0.5.1', '0.5.2']);
    // CI recomputes the version from the pushed commit's own file: builds finishing in another order change nothing
    const fromTree = pushes.map((p) => versionOf(r.git('show', `${p.after}:CHANGELOG.md`)));
    expect(fromTree).toEqual(versions);
    // and the order is the order of the numbers, so « latest » is the newest push whatever the release timestamps say
    const num = (v: string) => v.split('.').map(Number).reduce((a, n) => a * 1000 + n, 0);
    expect([...versions].sort((a, b) => num(a) - num(b))).toEqual(versions);
  });

  it('two branches that each add an entry on top cannot both merge: the second conflicts, so its author re-bases and gets the next version', () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'a');
    writeFileSync(r.log, r.entry('Fixed', 'from a')(readFileSync(r.log, 'utf8')));
    r.git('commit', '-qam', 'a');
    r.git('checkout', '-q', 'main');
    r.git('checkout', '-q', '-b', 'b');
    writeFileSync(r.log, r.entry('Fixed', 'from b')(readFileSync(r.log, 'utf8')));
    r.git('commit', '-qam', 'b');
    r.git('checkout', '-q', 'main');
    r.git('merge', '-q', '--no-ff', '-m', 'merge a', 'a');
    const merge = spawnSync('git', ['merge', '--no-ff', '-m', 'merge b', 'b'], { cwd: r.dir, encoding: 'utf8' });
    expect(merge.status).not.toBe(0);
    expect(merge.stdout + merge.stderr).toMatch(/CONFLICT/);
  });

  it('a pull request merged with a merge commit that carries three branch commits, each with an entry, is three entries: refused', () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'feature');
    for (const t of ['x', 'y', 'z']) {
      writeFileSync(r.log, r.entry('Fixed', t)(readFileSync(r.log, 'utf8')));
      r.git('commit', '-qam', t);
    }
    r.git('checkout', '-q', 'main');
    const before = r.git('rev-parse', 'HEAD');
    r.git('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
    const check = spawnSync('scripts/release/check-push.sh', [before], { cwd: r.dir, encoding: 'utf8' });
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/adds 3 CHANGELOG.md entries/);
  });

  it('the real CHANGELOG.md of this repo: dropping the newest entry always lowers the version (a push never goes backwards or repeats)', () => {
    const parts = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/^(?=## )/m);
    const [intro, ...entries] = parts as [string, ...string[]];
    expect(entries.length).toBeGreaterThan(10);
    const num = (v: string) => v.split('.').map(Number).reduce((x, n) => x * 1000 + n, 0);
    let last = num(versionOf(intro + entries.join('')));
    for (let i = 1; i <= entries.length; i++) {
      const v = num(versionOf(intro + entries.slice(i).join('')));
      expect(v).toBeLessThan(last);
      last = v;
    }
  });
});
