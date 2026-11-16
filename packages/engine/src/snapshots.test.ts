import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FILE_BYTES, Snapshots, snapshotted } from './snapshots.ts';

let root: string;
let work: string;
let snaps: Snapshots;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atlas-snap-'));
  work = join(root, 'work');
  mkdirSync(work);
  snaps = new Snapshots(join(root, 'data', 'checkpoints'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (p: string, t: string) => {
  mkdirSync(join(work, p, '..'), { recursive: true });
  writeFileSync(join(work, p), t);
};
const read = (p: string) => (existsSync(join(work, p)) ? readFileSync(join(work, p), 'utf8') : null);

describe('Snapshots', () => {
  it('diffs two snapshots of a non-git folder: modified, deleted and created files, with their states', async () => {
    put('a.txt', 'one');
    put('src/b.ts', 'b1');
    put('gone.md', 'keep me');
    const c1 = await snaps.take(work);
    expect(existsSync(join(work, '.git'))).toBe(false); // nothing written inside the workdir
    put('a.txt', 'two');
    rmSync(join(work, 'gone.md'));
    put('new/deep/c.txt', 'new');
    const c2 = await snaps.take(work);
    const d = await snaps.diff(work, c1, c2);
    expect(d.map((x) => [x.path, !!x.before, !!x.after])).toEqual([
      ['a.txt', true, true],
      ['gone.md', true, false],
      ['new/deep/c.txt', false, true],
    ]);
    // The states match what state() reads, and put() writes them back.
    expect(d[0]!.after).toEqual(await snaps.state(work, 'a.txt'));
    for (const x of d) await snaps.put(work, x.path, x.before);
    expect([read('a.txt'), read('gone.md'), read('src/b.ts')]).toEqual(['one', 'keep me', 'b1']);
    expect(existsSync(join(work, 'new'))).toBe(false); // emptied folders go too
  });

  it('state() saves a file it can put back later, with its mode; null for an absent file', async () => {
    put('run.sh', '#!/bin/sh\n');
    chmodSync(join(work, 'run.sh'), 0o755);
    const s = await snaps.state(work, 'run.sh', true);
    expect(s).toMatchObject({ mode: '100755' });
    expect(await snaps.kept('b')).toEqual([s!.sha]);
    rmSync(join(work, 'run.sh'));
    expect(await snaps.state(work, 'run.sh')).toBeNull();
    await snaps.put(work, 'run.sh', s);
    expect(read('run.sh')).toBe('#!/bin/sh\n');
    expect(statSync(join(work, 'run.sh')).mode & 0o111).not.toBe(0);
  });

  it('leaves excluded and oversize files out of snapshots', async () => {
    put('keep.txt', 'k');
    const c1 = await snaps.take(work);
    put('node_modules/x/index.js', 'dep');
    put('.env', 'SECRET=1');
    put('app.db', 'db');
    writeFileSync(join(work, 'big.bin'), Buffer.alloc(MAX_FILE_BYTES + 1));
    put('made.txt', 'm');
    const c2 = await snaps.take(work);
    expect((await snaps.diff(work, c1, c2)).map((x) => x.path)).toEqual(['made.txt']);
    expect(['made.txt', 'src/a.ts', 'node_modules/x/index.js', '.env', 'app.db', 'dist/a.js', 'a/.git/x'].map(snapshotted)).toEqual([true, true, false, false, false, false, false]);
  });

  it('prunes: dropped snapshots go, the store reports its size', async () => {
    put('a.txt', 'x'.repeat(5000));
    const c = await snaps.take(work);
    expect(await snaps.kept()).toEqual([c]);
    await snaps.drop([c]);
    expect(await snaps.kept()).toEqual([]);
    await snaps.gc();
    expect(await snaps.size()).toBeGreaterThanOrEqual(0);
  });
});
