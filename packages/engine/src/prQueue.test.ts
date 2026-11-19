import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { launch, type LaunchOptions } from '../test/kit/index.ts';
import type { GhPr } from './prs.ts';
import { syncBranch } from './prSync.ts';
import { repoKit } from '../test/repoKit.ts';

/**
 * The merge queue (#236) end to end: a FakeProvider reviewer, a fake GitHub that reads PR heads from a local bare repo
 * (« merging » = a merge commit on its main), and the real rebase (prSync.ts) in a reviewer clone of that repo.
 */
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const M = 'pkg/migrations';
const urlOf = (n: number) => `https://github.com/csoylu/atlas/pull/${n}`;

function world() {
  const k = repoKit();
  const prs = new Map<number, { branch: string; state: 'open' | 'merged' | 'closed'; mergeSha: string | null }>();
  /** Heads CI has passed (a new head is pending until the test turns it green). */
  const green = new Set<string>();
  const read = async (_repo: string, n: number): Promise<GhPr> => {
    const p = prs.get(n)!;
    const head = k.head(p.branch);
    return { state: p.state, mergeSha: p.mergeSha, headSha: head, branch: p.branch, base: 'main', mergeable: true, ci: green.has(head) ? 'success' : 'pending', qa: null, qaDescription: null } as GhPr;
  };
  const open = (n: number, files: Record<string, string>) => {
    const branch = `feat/${n}-x`;
    green.add(k.commit(branch, files));
    prs.set(n, { branch, state: 'open', mergeSha: null });
  };
  const merge = (n: number) => {
    const p = prs.get(n)!;
    p.mergeSha = k.merge(p.branch);
    p.state = 'merged';
  };
  /** The reviews, in order: which PR, on which head, and whether that head already contained main. */
  const reviewed: { pr: number; head: string; upToDate: boolean }[] = [];
  return { k, prs, green, read, open, merge, reviewed };
}

type World = ReturnType<typeof world>;

async function start(w: World, o: { dbFile?: string; dataDir?: string; script?: LaunchOptions['script'] } = {}) {
  const t = await launch({
    script: o.script ?? [],
    dispatch: false,
    ...(o.dbFile ? { dbFile: o.dbFile, dataDir: o.dataDir } : {}),
    prs: { read: w.read, sync: (a) => syncBranch({ clone: w.k.clone, branch: a.branch, sha: a.sha, base: a.base, env: w.k.env }), intervalMs: false },
  });
  const e = t.engine;
  if (!e.agents.list().some((a) => a.id === 'zurich')) e.agents.create({ id: 'zurich', modelId: e.agents.get('atlas').modelId });
  e.settings.update({ reviewAgent: 'zurich', triageAgent: 'atlas' });
  return { ...t, e };
}

/** A reviewer run: records what it reviews (the head of the queue's PR) and merges it. */
function reviewAndMerge(w: World, e: () => Awaited<ReturnType<typeof start>>['e'], prOf: Map<string, number>) {
  return () => {
    const headCard = e().prs.queue('atlas')[0]!;
    const n = prOf.get(headCard)!;
    const head = w.k.head(w.prs.get(n)!.branch);
    w.reviewed.push({ pr: n, head, upToDate: w.k.sh(w.k.bare, 'merge-base', 'main', head) === w.k.head('main') });
    w.merge(n);
    return text(`validated and merged PR #${n}`);
  };
}

type E = Awaited<ReturnType<typeof start>>['e'];
/** Tasks In review for PRs `ns`, asked in that order. */
function ask(e: E, ns: number[], prOf?: Map<string, number>): { id: string }[] {
  return ns.map((n) => {
    const x = e.kanban.create({ title: `PR ${n}`, status: 'running', assignee: 'atlas' }, 'user');
    e.kanban.requestReview(x.id, [urlOf(n)], 'atlas', 'built');
    prOf?.set(x.id, n);
    return { id: x.id };
  });
}

describe('merge queue per project (#236)', () => {
  it('three PRs asked in order are reviewed and merged in that order, one reviewer run at a time; the next is rebased and reviewed on its new head', async () => {
    const w = world();
    const prOf = new Map<string, number>();
    let eng: E;
    const t = await start(w, { script: [reviewAndMerge(w, () => eng, prOf), reviewAndMerge(w, () => eng, prOf), reviewAndMerge(w, () => eng, prOf)] });
    const e = (eng = t.e);
    for (const n of [1, 2, 3]) w.open(n, { [`src/f${n}.ts`]: `${n}\n` });
    const [a, b, c] = ask(e, [1, 2, 3], prOf) as [{ id: string }, { id: string }, { id: string }];
    const ref = (x: { id: string }) => e.kanban.ref(x.id);

    await e.prs.poll();
    // Only the head is reviewed; the others wait and say where they are.
    expect(e.runner.runs(a.id)).toHaveLength(1);
    expect(e.runner.runs(b.id)).toHaveLength(0);
    expect(e.kanban.get(b.id).waiting).toBe(`2nd in the queue, behind ${ref(a)}`);
    expect(e.kanban.get(c.id).waiting).toBe(`3rd in the queue, behind ${ref(a)} and ${ref(b)}`);
    await t.idle(a.id);

    // A merged: A done, B brought up to date with main (rebased, pushed), not reviewed before CI on its new head.
    await e.prs.poll();
    expect(e.kanban.get(a.id).status).toBe('done');
    const bHead = w.k.head('feat/2-x');
    expect(w.k.sh(w.k.bare, 'merge-base', 'main', bHead)).toBe(w.k.head('main'));
    expect(JSON.stringify(e.kanban.messages(b.id).at(-1)!.content)).toMatch(/Merge queue: PR #2 rebased onto main [0-9a-f]{7}\. New head/);
    expect(e.runner.runs(b.id)).toHaveLength(0);
    await e.prs.poll();
    expect(e.runner.runs(b.id)).toHaveLength(0);
    expect(e.kanban.get(b.id).waiting).toMatch(/^1st in the queue for \d+ min · QA starts when CI is green$/);
    expect(e.kanban.get(c.id).waiting).toBe(`2nd in the queue, behind ${ref(b)}`);
    w.green.add(bHead);
    await e.prs.poll();
    expect(e.runner.runs(b.id)).toHaveLength(1);
    expect(e.runner.runs(c.id)).toHaveLength(0);
    await t.idle(b.id);

    await e.prs.poll(); // B merged, C rebased
    w.green.add(w.k.head('feat/3-x'));
    await e.prs.poll(); // C's new head read
    await t.idle(c.id);
    await e.prs.poll();
    expect([a, b, c].map((x) => e.kanban.get(x.id).status)).toEqual(['done', 'done', 'done']);
    expect(w.reviewed.map((r) => r.pr)).toEqual([1, 2, 3]);
    expect(w.reviewed.every((r) => r.upToDate)).toBe(true);
    expect(w.reviewed[1]!.head).toBe(bHead);
    expect(w.k.files('main')).toEqual(expect.arrayContaining(['src/f1.ts', 'src/f2.ts', 'src/f3.ts']));
  });

  it('a PR whose rebase conflicts goes back to its builder with the files named; the third proceeds in the same poll', async () => {
    const w = world();
    const prOf = new Map<string, number>();
    let eng: E;
    const t = await start(w, { script: [reviewAndMerge(w, () => eng, prOf), reviewAndMerge(w, () => eng, prOf)] });
    const e = (eng = t.e);
    w.open(1, { 'src/a.ts': 'export const a = 2;\n' });
    w.open(2, { 'src/a.ts': 'export const a = 3;\n' });
    w.open(3, { 'src/c.ts': 'c\n' });
    const [a, b, c] = ask(e, [1, 2, 3], prOf) as [{ id: string }, { id: string }, { id: string }];
    await e.prs.poll();
    await t.idle(a.id);
    const bBefore = w.k.head('feat/2-x');
    await e.prs.poll();
    expect(e.kanban.get(b.id).status).toBe('ready');
    expect(JSON.stringify(e.kanban.messages(b.id).at(-1)!.content)).toMatch(/PR #2 conflicts with main in src\/a\.ts: rebase it on main\. Back to Ready/);
    expect(w.k.head('feat/2-x')).toBe(bBefore); // nothing forced
    // The queue moved on in the same poll: C was rebased onto the new main.
    expect(JSON.stringify(e.kanban.messages(c.id).at(-1)!.content)).toMatch(/Merge queue: PR #3 rebased/);
    expect(e.kanban.get(c.id).waiting).toMatch(/^1st in the queue/);
    // B fixed and asked again: at the end of the queue, behind C.
    e.kanban.update(b.id, { status: 'running' }, 'dispatcher');
    e.kanban.requestReview(b.id, [urlOf(2)], 'atlas', 'rebased');
    expect(e.prs.queue('atlas')).toEqual([c.id, b.id]);
  });

  it('two PRs with the same migration number both merge, the second renumbered (thread note), across restarts at each step', async () => {
    const w = world();
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-queue-'));
    const dbFile = join(dataDir, 'atlas.db');
    const prOf = new Map<string, number>();
    let eng: E;
    const step = () => reviewAndMerge(w, () => eng, prOf);
    let t = await start(w, { dbFile, dataDir, script: [step()] });
    eng = t.e;
    w.open(1, { [`${M}/0002_cards.sql`]: 'CREATE TABLE c (x);\n' });
    w.open(2, { [`${M}/0002_users.sql`]: '-- 0002_users\nCREATE TABLE u (x);\n', 'src/db.test.ts': "expect(names).toContain('0002_users');\n" });
    const [a, b] = ask(eng, [1, 2], prOf) as [{ id: string }, { id: string }];
    const restart = async (script: LaunchOptions['script'] = []) => {
      await t.e.stop();
      t = await start(w, { dbFile, dataDir, script });
      eng = t.e;
    };

    await restart([step()]); // queued, nothing read yet
    expect(eng.prs.queue('atlas')).toEqual([a.id, b.id]);
    await eng.prs.poll();
    await t.idle(a.id);
    await restart([step()]); // A merged on GitHub, not read yet
    expect(eng.kanban.get(a.id).status).toBe('review');
    await eng.prs.poll();
    expect(eng.kanban.get(a.id).status).toBe('done');
    const note = JSON.stringify(eng.kanban.messages(b.id).at(-1)!.content);
    expect(note).toMatch(/migration 0002_users renamed 0003_users/);
    const bHead = w.k.head('feat/2-x');
    expect(w.k.files(bHead)).toEqual(expect.arrayContaining([`${M}/0002_cards.sql`, `${M}/0003_users.sql`]));
    expect(w.k.show(bHead, 'src/db.test.ts')).toBe("expect(names).toContain('0003_users');");
    await restart([step()]); // rebased and pushed, CI pending: no review, no second push
    await eng.prs.poll();
    expect(w.k.head('feat/2-x')).toBe(bHead);
    expect(eng.runner.runs(b.id)).toHaveLength(0);
    w.green.add(bHead);
    await restart([step()]);
    await eng.prs.poll();
    expect(eng.runner.runs(b.id)).toHaveLength(1);
    await t.idle(b.id);
    await restart();
    await eng.prs.poll();
    expect(eng.runner.runs(b.id)).toHaveLength(1); // the restart did not start it again
    expect([a, b].map((x) => eng.kanban.get(x.id).status)).toEqual(['done', 'done']);
    expect(w.k.files('main').filter((f) => f.startsWith(M))).toEqual([`${M}/0001_init.sql`, `${M}/0002_cards.sql`, `${M}/0003_users.sql`]);
    expect(eng.kanban.messages(b.id).filter((m) => JSON.stringify(m.content).includes('renamed 0003_users'))).toHaveLength(1);
  });

  it('a merge from Master’s terminal jumps the queue; a sync that fails is shown on the head and tried again; a project without a repo has no queue', async () => {
    const w = world();
    let fail: string | null = 'no clone of csoylu/atlas in /x';
    const t = await launch({
      script: [],
      dispatch: false,
      prs: {
        read: w.read,
        sync: async (a) => {
          if (fail) throw new Error(fail);
          return syncBranch({ clone: w.k.clone, branch: a.branch, sha: a.sha, base: a.base, env: w.k.env });
        },
        intervalMs: false,
      },
    });
    const e = t.engine;
    if (!e.agents.list().some((a) => a.id === 'zurich')) e.agents.create({ id: 'zurich', modelId: e.agents.get('atlas').modelId });
    e.settings.update({ reviewAgent: 'zurich', triageAgent: 'atlas' });
    w.open(1, { 'src/a1.ts': '1\n' });
    w.open(2, { 'src/a2.ts': '2\n' });
    const [a, b] = ask(e, [1, 2]) as [{ id: string }, { id: string }];
    await e.prs.poll();
    expect(e.runner.runs(a.id)).toHaveLength(0);
    expect(e.kanban.get(a.id).waiting).toMatch(/^1st in the queue for \d+ min · can't bring PR #1 up to date with main: no clone of csoylu\/atlas in \/x \(tried again every minute\)$/);
    // Master merges #2 from a terminal: done at the next read, and #1 is then brought up to date with the new main.
    w.merge(2);
    fail = null;
    await e.prs.poll();
    expect(e.kanban.get(b.id).status).toBe('done');
    expect(JSON.stringify(e.kanban.messages(a.id).at(-1)!.content)).toMatch(/PR #1 rebased onto main/);
    expect(e.prs.queue('nope')).toEqual([]);
  });
});
