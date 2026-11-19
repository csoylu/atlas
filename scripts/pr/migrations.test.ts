import { describe as group, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clashes, describe, parseMigration, renumber } from './migrations.mjs';

const D = 'packages/engine/src/store/migrations';
const main = [`${D}/0050_a.sql`, `${D}/0051_b.sql`, 'README.md', 'other/migrations/0003_z.sql'];

group('migration numbers of a PR (#236)', () => {
  it('parses NNNN_name.sql in a migrations folder only', () => {
    expect(parseMigration(`${D}/0051_b.sql`)).toEqual({ path: `${D}/0051_b.sql`, dir: D, number: 51, stem: '0051_b' });
    expect(parseMigration('migrations/0001_x.sql')).toMatchObject({ dir: 'migrations', number: 1 });
    expect(parseMigration(`${D}/README.md`)).toBe(null);
    expect(parseMigration('src/0051_b.sql')).toBe(null);
  });
  it('a new migration must be above every number on main in its folder', () => {
    expect(clashes([`${D}/0052_c.sql`, 'x.ts'], main)).toEqual([]);
    expect(clashes([`${D}/0051_c.sql`], main)).toEqual([{ path: `${D}/0051_c.sql`, number: 51, max: 51 }]);
    expect(clashes([`${D}/0049_c.sql`], main)).toHaveLength(1);
    expect(clashes(['other/migrations/0004_y.sql', 'new/migrations/0001_q.sql'], main)).toEqual([]);
    expect(describe(clashes([`${D}/0051_c.sql`], main)[0]!)).toMatch(/0051 is not above 0051/);
  });
  it('renumbers only the clashing folder, keeping the PR order', () => {
    expect(renumber([`${D}/0052_c.sql`], main)).toEqual([]);
    expect(renumber([`${D}/0051_c.sql`], main)).toEqual([{ from: `${D}/0051_c.sql`, to: `${D}/0052_c.sql`, fromStem: '0051_c', toStem: '0052_c' }]);
    expect(renumber([`${D}/0052_d.sql`, `${D}/0051_c.sql`, 'other/migrations/0004_y.sql'], main)).toEqual([
      { from: `${D}/0051_c.sql`, to: `${D}/0052_c.sql`, fromStem: '0051_c', toStem: '0052_c' },
      { from: `${D}/0052_d.sql`, to: `${D}/0053_d.sql`, fromStem: '0052_d', toStem: '0053_d' },
    ]);
  });
  it('the CI check fails on a clash, passes otherwise', { timeout: 30_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'm/migrations'), { recursive: true });
    writeFileSync(join(dir, 'm/migrations/0001_a.sql'), 'a');
    git('add', '.');
    git('commit', '-qm', 'base');
    git('switch', '-qc', 'pr');
    writeFileSync(join(dir, 'm/migrations/0002_b.sql'), 'b');
    git('add', '.');
    git('commit', '-qm', 'pr');
    const script = join(import.meta.dirname, 'migrations.mjs');
    const check = () => execFileSync('node', [script, 'check', 'main', 'pr'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    expect(check()).toMatch(/1 new, all numbered above/);
    git('switch', '-q', 'main');
    writeFileSync(join(dir, 'm/migrations/0002_other.sql'), 'o');
    git('add', '.');
    git('commit', '-qm', 'main moved');
    expect(check).toThrow(/0002 is not above 0002/);
  });
});
