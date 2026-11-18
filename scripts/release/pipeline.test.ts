import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module (run by CI with node before npm ci)
import { versionOf, versionAt } from './changelog.mjs';
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

  it('the release notes are the newest entry, the whole changelog is a release file, and the version given to the build is the changelog\'s', () => {
    expect(j.release!.text).toContain('node scripts/release/changelog.mjs notes');
    expect(j.release!.text).toContain('--notes-file');
    expect(j.release!.text).toContain('node scripts/release/changelog.mjs full > out/CHANGELOG.md');
    expect(j.release!.text).toContain('fetch-depth: 0'); // the entries' order comes from git history (#223)
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

/**
 * A throwaway repo that has the real release scripts, a frozen history (one entry: 0.4.0) and a changelog/ folder that
 * grows one file per push (#223).
 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-pipeline-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'qa@test');
  git('config', 'user.name', 'qa');
  mkdirSync(join(dir, 'scripts/release'), { recursive: true });
  mkdirSync(join(dir, 'changelog'));
  for (const f of ['changelog.mjs', 'check-push.sh']) writeFileSync(join(dir, 'scripts/release', f), readFileSync(join(root, 'scripts/release', f)), { mode: 0o755 });
  writeFileSync(join(dir, 'changelog/history.md'), '# History\n\nFrozen.\n\n## Added · #1 · The first entry\n');
  git('add', '-A');
  git('commit', '-qm', 'start');
  const sha = () => git('rev-parse', 'HEAD');
  let n = 99; // entry() numbers; tests that name a task use smaller ones
  /** One entry file: changelog/<n>-x.md. */
  const entry = (kind: string, title = 'something', task = ++n) => ({ [`changelog/${task}-x.md`]: `## ${kind} · #${task} · ${title}\n` });
  /** Write (or delete: null) files and commit them. */
  const write = (files: Record<string, string | null>) => {
    for (const [f, text] of Object.entries(files)) {
      if (text == null) git('rm', '-q', f);
      else writeFileSync(join(dir, f), text);
    }
    git('add', '-A');
  };
  const check = (before: string) => spawnSync('scripts/release/check-push.sh', [before], { cwd: dir, encoding: 'utf8' });
  const cli = (...a: string[]) => spawnSync('node', ['scripts/release/changelog.mjs', ...a], { cwd: dir, encoding: 'utf8' });
  /** A push: files, one commit; returns { before, after, check, version }. */
  const push = (files: Record<string, string | null>, message = 'push') => {
    const before = sha();
    write(files);
    git('commit', '-qm', message, '--allow-empty');
    return { before, after: sha(), check: check(before), version: cli('version').stdout.trim() };
  };
  return { dir, git, push, entry, write, check, cli, sha };
}

// Real git repos + bash: slow when the machine is loaded (load 50-90 gave >5 s), so a generous timeout for the whole block.
describe('releases from real git history (docs/updater.md steps 1-3, #223)', { timeout: 60_000 }, () => {
  it('a push with exactly one entry file passes and gets the next version; the notes are that entry', () => {
    const r = repo();
    const p = r.push(r.entry('Fixed', 'Something is fixed', 2));
    expect(p.check.stderr).toBe('');
    expect(p.check.status).toBe(0);
    expect(p.version).toBe('0.4.1');
    expect(r.cli('notes').stdout).toBe('## Fixed · #2 · Something is fixed\n');
    expect(r.cli('full').stdout).toMatch(/## 0\.4\.1 · Fixed · #2 · Something is fixed\n\n## 0\.4\.0 · Added · #1 · The first entry\n/);
  });

  it('refused: no entry, two entries, an edited old entry, a removed one, an edited history, a bad file', () => {
    const r = repo();
    const first = r.push(r.entry('Fixed', 'a', 2));
    expect(first.check.status).toBe(0);
    const none = r.push({ 'other.txt': 'x' });
    expect(none.check.status).toBe(1);
    expect(none.check.stderr).toMatch(/this push: no new changelog entry/);
    const two = r.push({ ...r.entry('Fixed'), ...r.entry('Fixed') });
    expect(two.check.status).toBe(1);
    expect(two.check.stderr).toMatch(/2 new changelog entries/);
    const edited = r.push({ ...r.entry('Fixed'), 'changelog/2-x.md': '## Fixed · #2 · a, reworded\n' });
    expect(edited.check.status).toBe(1);
    expect(edited.check.stderr).toMatch(/changelog\/2-x\.md is changed: existing changelog files never change/);
    const removed = r.push({ ...r.entry('Fixed'), 'changelog/2-x.md': null });
    expect(removed.check.stderr).toMatch(/changelog\/2-x\.md is removed/);
    const history = r.push({ ...r.entry('Fixed'), 'changelog/history.md': '# History\n\n## Fixed · #1 · rewritten\n' });
    expect(history.check.stderr).toMatch(/changelog\/history\.md is changed/);
    const kind = r.push(r.entry('Improved'));
    expect(kind.check.status).toBe(1);
    expect(kind.check.stderr).toMatch(/unknown kind « Improved »/);
    const sub = r.push({ 'changelog/40-x.md': '## Fixed · #40 · With details\n\n## Details\n\ntext\n' });
    expect(sub.check.stderr).toMatch(/unknown kind « Details »/); // agents: ### for sub-headings
    const name = r.push({ 'changelog/Notes.md': '## Fixed · #41 · x\n' });
    expect(name.check.stderr).toMatch(/not an entry file name/);
  });

  it('each kind raises the right part: Fixed patch, Added and Changed minor (patch back to 0), Breaking major', () => {
    const r = repo();
    const seen = ['Fixed', 'Fixed', 'Added', 'Fixed', 'Changed', 'Breaking', 'Added'].map((k) => r.push(r.entry(k)).version);
    expect(seen).toEqual(['0.4.1', '0.4.2', '0.5.0', '0.5.1', '0.6.0', '1.0.0', '1.1.0']);
  });

  it('pushes close together: every push gets its own version, strictly increasing in merge order, recomputed from each commit', () => {
    const r = repo();
    const pushes = ['Fixed', 'Added', 'Fixed', 'Fixed'].map((k) => r.push(r.entry(k)));
    expect(pushes.every((p) => p.check.status === 0)).toBe(true);
    const versions = pushes.map((p) => p.version);
    expect(versions).toEqual(['0.4.1', '0.5.0', '0.5.1', '0.5.2']);
    // CI recomputes the version from the pushed commit's own history: builds finishing in another order change nothing
    const fromTree = pushes.map((p) => (r.git('checkout', '-q', p.after), versionAt(r.dir)));
    expect(fromTree).toEqual(versions);
  });

  it('two branches that each add an entry merge without conflict, in either order; the order of the merges is the order of the entries', () => {
    for (const order of [['a', 'b'], ['b', 'a']]) {
      const r = repo();
      r.git('checkout', '-q', '-b', 'a');
      r.write({ 'changelog/10-from-a.md': '## Added · #10 · from a\n', 'a.txt': 'a' });
      r.git('commit', '-qm', 'a');
      r.git('checkout', '-q', 'main');
      r.git('checkout', '-q', '-b', 'b');
      r.write({ 'changelog/9-from-b.md': '## Fixed · #9 · from b\n', 'b.txt': 'b' });
      r.git('commit', '-qm', 'b');
      r.git('checkout', '-q', 'main');
      const versions: string[] = [];
      for (const branch of order) {
        const before = r.sha();
        const merge = spawnSync('git', ['merge', '--no-ff', '-m', `merge ${branch}`, branch], { cwd: r.dir, encoding: 'utf8' });
        expect(merge.status).toBe(0);
        const check = r.check(before);
        expect(check.status).toBe(0);
        versions.push(r.cli('version').stdout.trim());
        expect(r.cli('notes').stdout).toBe(branch === 'a' ? '## Added · #10 · from a\n' : '## Fixed · #9 · from b\n');
      }
      // a then b: 0.5.0 (Added) → 0.5.1 (Fixed). b then a: 0.4.1 (Fixed) → 0.5.0 (Added). Same files, merge order decides.
      expect(versions).toEqual(order[0] === 'a' ? ['0.5.0', '0.5.1'] : ['0.4.1', '0.5.0']);
    }
  });

  it('a branch that merged main in, then merges back: main\'s entries stay where they reached main, the branch\'s is newest', () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'feature');
    r.write({ 'changelog/20-feature.md': '## Added · #20 · feature\n' });
    r.git('commit', '-qm', 'feature');
    r.git('checkout', '-q', 'main');
    r.push({ 'changelog/21-fix.md': '## Fixed · #21 · fix\n' });
    r.git('checkout', '-q', 'feature');
    r.git('merge', '-q', '--no-ff', '-m', 'main into feature', 'main');
    r.git('checkout', '-q', 'main');
    const before = r.sha();
    r.git('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
    expect(r.check(before).status).toBe(0);
    expect(r.cli('notes').stdout).toBe('## Added · #20 · feature\n');
    expect(r.cli('version').stdout.trim()).toBe('0.5.0'); // 0.4.0 → fix 0.4.1 → feature 0.5.0
  });

  it('a merge that carries three branch commits, each with an entry, is three entries: refused', () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'feature');
    for (const t of [30, 31, 32]) {
      r.write(r.entry('Fixed', 'x', t));
      r.git('commit', '-qm', String(t));
    }
    r.git('checkout', '-q', 'main');
    const before = r.sha();
    r.git('merge', '-q', '--no-ff', '-m', 'merge feature', 'feature');
    const check = r.check(before);
    expect(check.status).toBe(1);
    expect(check.stderr).toMatch(/3 new changelog entries/);
  });

  it('a file not committed yet counts as the newest (a local build); a shallow clone is refused, not guessed', () => {
    const r = repo();
    r.push(r.entry('Added', 'merged', 2));
    writeFileSync(join(r.dir, 'changelog/3-mine.md'), '## Fixed · #3 · mine\n');
    expect(r.cli('version').stdout.trim()).toBe('0.5.1');
    const shallow = mkdtempSync(join(tmpdir(), 'atlas-shallow-'));
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${r.dir}`, shallow]);
    const v = spawnSync('node', ['scripts/release/changelog.mjs', 'version'], { cwd: shallow, encoding: 'utf8' });
    expect(v.status).toBe(1);
    expect(v.stderr).toMatch(/shallow/);
  });

  it('the push that starts the folder (CHANGELOG.md moved to changelog/history.md, one entry added) passes and continues the version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-start-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'qa@test');
    git('config', 'user.name', 'qa');
    mkdirSync(join(dir, 'scripts/release'), { recursive: true });
    writeFileSync(join(dir, 'scripts/release/changelog.mjs'), '// the old script');
    writeFileSync(join(dir, 'CHANGELOG.md'), '# Changelog\n\n## Fixed · #2 · b\n\n## Added · #1 · a\n');
    git('add', '-A');
    git('commit', '-qm', 'old world');
    const before = git('rev-parse', 'HEAD');
    const old = versionOf(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8'));
    for (const f of ['changelog.mjs', 'check-push.sh']) writeFileSync(join(dir, 'scripts/release', f), readFileSync(join(root, 'scripts/release', f)), { mode: 0o755 });
    mkdirSync(join(dir, 'changelog'));
    git('mv', 'CHANGELOG.md', 'changelog/history.md');
    writeFileSync(join(dir, 'changelog/3-folder.md'), '## Changed · #3 · one file per PR\n');
    git('add', '-A');
    git('commit', '-qm', 'new world');
    const check = spawnSync('scripts/release/check-push.sh', [before], { cwd: dir, encoding: 'utf8' });
    expect(check.stderr).toBe('');
    expect(check.status).toBe(0);
    expect(old).toBe('0.4.1');
    expect(versionAt(dir)).toBe('0.5.0');
  });

  it('first release and new-branch pushes: nothing to compare with', () => {
    const r = repo();
    expect(r.check('0000000000000000000000000000000000000000').stdout).toContain('first release');
  });

  it('the real history of this repo: dropping the newest entry always lowers the version (a push never goes backwards or repeats)', () => {
    const parts = readFileSync(join(root, 'changelog/history.md'), 'utf8').split(/^(?=## )/m);
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
