import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findClone, repoOfUrl, syncBranch } from './prSync.ts';
import { repoKit } from '../test/repoKit.ts';

const M = 'pkg/migrations';

describe('merge queue: bring a PR up to date with main (#236)', { timeout: 30_000 }, () => {
  it('a PR that already contains main: nothing pushed', async () => {
    const k = repoKit();
    const sha = k.commit('feat/1-a', { 'src/b.ts': 'b\n' });
    expect(await syncBranch({ clone: k.clone, branch: 'feat/1-a', sha, env: k.env })).toEqual({ kind: 'current' });
    expect(k.head('feat/1-a')).toBe(sha);
  });

  it('rebases a PR behind main when it applies cleanly, pushes it, leaves the clone as it was', async () => {
    const k = repoKit();
    const sha = k.commit('feat/2-b', { 'src/b.ts': 'b\n' });
    const main = k.commit('main', { 'src/c.ts': 'c\n' });
    const refsBefore = k.sh(k.clone, 'for-each-ref');
    const statusBefore = k.sh(k.clone, 'status', '--porcelain=v2', '--branch');
    const r = await syncBranch({ clone: k.clone, branch: 'feat/2-b', sha: sha.slice(0, 7), env: k.env });
    expect(r).toMatchObject({ kind: 'pushed', oldHead: sha, onto: main, rebased: true, renamed: [] });
    const now = k.head('feat/2-b');
    expect(now).toBe(r.kind === 'pushed' && r.newHead);
    expect(k.sh(k.bare, 'merge-base', main, now)).toBe(main);
    expect(k.files(now)).toEqual(expect.arrayContaining(['src/b.ts', 'src/c.ts']));
    expect(k.sh(k.bare, 'log', '-1', '--format=%an %s', now)).toBe('csoylu change');
    expect(k.sh(k.clone, 'for-each-ref')).toBe(refsBefore);
    expect(k.sh(k.clone, 'status', '--porcelain=v2', '--branch')).toBe(statusBefore);
    expect(k.sh(k.clone, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  it('a real conflict: nothing pushed, the files named', async () => {
    const k = repoKit();
    const sha = k.commit('feat/3-c', { 'src/a.ts': 'export const a = 2;\n' });
    k.commit('main', { 'src/a.ts': 'export const a = 3;\n' });
    expect(await syncBranch({ clone: k.clone, branch: 'feat/3-c', sha, env: k.env })).toMatchObject({ kind: 'conflict', files: ['src/a.ts'] });
    expect(k.head('feat/3-c')).toBe(sha);
  });

  it('renumbers a new migration whose number main took, and its references in the PR, in one pushed commit', async () => {
    const k = repoKit();
    const sha = k.commit('feat/4-d', { [`${M}/0002_cards.sql`]: '-- 0002_cards: cards\nCREATE TABLE c (x);\n', 'src/db.test.ts': "expect(applied).toContain('0002_cards');\n" });
    k.commit('main', { [`${M}/0002_users.sql`]: 'CREATE TABLE u (x);\n' });
    const r = await syncBranch({ clone: k.clone, branch: 'feat/4-d', sha, env: k.env });
    expect(r).toMatchObject({ kind: 'pushed', rebased: true, renamed: [{ from: `${M}/0002_cards.sql`, to: `${M}/0003_cards.sql`, fromStem: '0002_cards', toStem: '0003_cards' }] });
    const now = k.head('feat/4-d');
    expect(k.files(now)).toEqual(expect.arrayContaining([`${M}/0002_users.sql`, `${M}/0003_cards.sql`]));
    expect(k.files(now)).not.toContain(`${M}/0002_cards.sql`);
    expect(k.show(now, 'src/db.test.ts')).toBe("expect(applied).toContain('0003_cards');");
    expect(k.show(now, `${M}/0003_cards.sql`)).toContain('-- 0003_cards: cards');
    expect(k.show(now, `${M}/0002_users.sql`)).toBe('CREATE TABLE u (x);'); // main's migration never edited
    expect(k.sh(k.bare, 'log', '-1', '--format=%s', now)).toBe("Renumber migration above main's: 0002_cards → 0003_cards (merge queue)");
  });

  it('renumbers a clash even when the PR already contains main', async () => {
    const k = repoKit();
    k.commit('main', { [`${M}/0002_users.sql`]: 'u\n' });
    const sha = k.commit('feat/5-e', { [`${M}/0002_cards.sql`]: 'c\n' });
    expect(await syncBranch({ clone: k.clone, branch: 'feat/5-e', sha, env: k.env })).toMatchObject({ kind: 'pushed', rebased: false, renamed: [{ toStem: '0003_cards' }] });
  });

  it('the branch moved since the read: nothing pushed, wait for the next read', async () => {
    const k = repoKit();
    const old = k.commit('feat/6-f', { 'src/b.ts': 'b\n' });
    k.commit('main', { 'src/c.ts': 'c\n' });
    const now = k.commit('feat/6-f', { 'src/b.ts': 'b2\n' });
    expect(await syncBranch({ clone: k.clone, branch: 'feat/6-f', sha: old, env: k.env })).toEqual({ kind: 'moved', head: now });
    expect(k.head('feat/6-f')).toBe(now);
    await expect(syncBranch({ clone: k.clone, branch: 'main', sha: now, env: k.env })).rejects.toThrow(/will not rewrite/);
  });

  it('finds the reviewer clone of the repo in its workspace', async () => {
    const k = repoKit();
    expect(repoOfUrl('git@github.com:csoylu/atlas.git')).toBe('csoylu/atlas');
    expect(repoOfUrl('https://github.com/Csoylu/Atlas')).toBe('csoylu/atlas');
    expect(await findClone(k.ws, 'o/atlas', k.env, (u) => (u.trim() === k.bare ? 'o/atlas' : null))).toBe(k.clone);
    await expect(findClone(k.ws, 'csoylu/atlas', k.env)).rejects.toThrow(/no clone of csoylu\/atlas/);
    expect(readFileSync(join(k.clone, 'README.md'), 'utf8')).toBe('atlas\n');
  });
});
