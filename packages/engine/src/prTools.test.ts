import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from '../test/kit/index.ts';
import { findClone, prToolSpecs, repoOfUrl, runPrTool } from './prTools.ts';

const SHA = 'a'.repeat(40);
const NEW = 'e'.repeat(40);
const head = '# Changelog\n\n';

/** A fake `gh` for one repo: the PR, its check runs, CHANGELOG.md, statuses and the merge; every call recorded. */
function fakeGh(repo: string, number: number, over: { pr?: Record<string, unknown>; checks?: unknown[]; checksNew?: unknown[]; after?: string } = {}) {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    const path = args[1]!;
    if (!path.startsWith(`repos/${repo}/`)) throw new Error(`asked another repo: ${path}`);
    if (path.endsWith(`/pulls/${number}`))
      return JSON.stringify({ state: 'open', draft: false, merged: false, mergeable: true, base: { ref: 'main' }, head: { sha: SHA, ref: 'feat/3-x', repo: { full_name: repo } }, number, ...over.pr });
    if (path.endsWith(`/pulls/${number}/merge`)) return JSON.stringify({ sha: 'b'.repeat(40), merged: true });
    if (path.includes(`commits/${NEW}/check-runs`)) return JSON.stringify({ check_runs: over.checksNew ?? [] });
    if (path.includes('/check-runs')) return JSON.stringify({ check_runs: over.checks ?? [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] });
    if (path.includes('/compare/')) return JSON.stringify({ merge_base_commit: { sha: 'c'.repeat(40) } });
    if (/contents\/CHANGELOG\.md\?ref=c+$/.test(path)) return head + '## Fixed · #1 · old\n';
    if (path.includes('contents/CHANGELOG.md')) return over.after ?? head + '## Added · #3 · new\n\n## Fixed · #1 · old\n';
    if (path.includes('/statuses/')) return '{}';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { gh, calls, statuses: () => calls.filter((c) => c[1]!.includes('/statuses/')), merges: () => calls.filter((c) => c[1]!.endsWith('/merge')) };
}

async function setup() {
  const t = await launch({ script: [], dispatch: false, prs: { read: async () => Promise.reject(new Error('no poll here')), intervalMs: false } });
  const e = t.engine;
  for (const id of ['zurich', 'munih']) if (!e.agents.list().some((a) => a.id === id)) e.agents.create({ id, modelId: e.agents.get('atlas').modelId });
  e.settings.update({ reviewAgent: 'zurich', triageAgent: 'atlas' });
  e.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'munih', members: ['zurich'] });
  const inReview = (projectId: string, url: string, assignee = 'munih') => {
    const c = e.kanban.create({ title: 'x', status: 'running', assignee, projectId }, 'user');
    e.kanban.requestReview(c.id, [url], assignee, 'built');
    return e.kanban.get(c.id);
  };
  const run = (cardId: string, input: unknown, gh: (args: string[]) => Promise<string>, o: { agentId?: string; rebase?: never } = {}) =>
    runPrTool('pr_validate', input, { db: e.db, kanban: e.kanban, agentId: o.agentId ?? 'zurich', cardId, workdir: tmpdir(), signal: new AbortController().signal, env: async () => process.env, gh, wait: { sleep: () => {}, everyMs: 0 } });
  return { e, inReview, run };
}

describe('pr_validate (#216)', () => {
  it('a project without a changelog and no CI job: any check green is enough, success set on the head and merged', async () => {
    const { e, inReview, run } = await setup();
    const c = inReview('datinel', 'https://github.com/datinel/datinel/pull/3');
    expect(e.db.prepare("SELECT ci_job, changelog FROM projects WHERE id = 'datinel'").get()).toEqual({ ci_job: null, changelog: 0 });
    const f = fakeGh('datinel/datinel', 3, { checks: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }, { id: 2, name: 'lint', status: 'completed', conclusion: 'skipped' }], after: head });
    const r = await run(c.id, { pr: 3, verdict: 'ok', sha: SHA, reason: 'tests green, read the diff' }, f.gh);
    expect(r).toMatchObject({ isError: false, output: expect.stringContaining('merged PR #3') });
    expect(f.statuses()).toHaveLength(1);
    expect(f.statuses()[0]![1]).toBe(`repos/datinel/datinel/statuses/${SHA}`);
    expect(f.statuses()[0]!.join(' ')).toMatch(/state=success.*description=zurich: tests green/);
    expect(f.calls.some((a) => a[1]!.includes('CHANGELOG'))).toBe(false);
    expect(f.merges()[0]).toContain(`sha=${SHA}`);
  });

  it('no CI job: one red or running check refuses, naming it; no check at all refuses', async () => {
    const { inReview, run } = await setup();
    const c = inReview('datinel', 'https://github.com/datinel/datinel/pull/3');
    const ok = { pr: 3, verdict: 'ok', sha: SHA, reason: 'r' };
    const green = { id: 1, name: 'build', status: 'completed', conclusion: 'success' };
    for (const [checks, why] of [
      [[green, { id: 2, name: 'e2e', status: 'completed', conclusion: 'failure' }], /CI check "e2e" is failure on aaaaaaa/],
      [[green, { id: 2, name: 'e2e', status: 'in_progress', conclusion: null }], /CI check "e2e" is still running/],
      [[], /CI has not run on aaaaaaa yet/],
    ] as const) {
      const f = fakeGh('datinel/datinel', 3, { checks: [...checks] });
      expect(await run(c.id, ok, f.gh)).toMatchObject({ isError: true, output: expect.stringMatching(why) });
      expect(f.statuses()).toHaveLength(0);
    }
  });

  it('the project’s CI job when set: only that check counts', async () => {
    const { e, inReview, run } = await setup();
    e.projects.update('datinel', { ciJob: 'ci' });
    const c = inReview('datinel', 'https://github.com/datinel/datinel/pull/3');
    const f = fakeGh('datinel/datinel', 3, { checks: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }, { id: 2, name: 'flaky', status: 'completed', conclusion: 'failure' }] });
    expect(await run(c.id, { pr: 3, verdict: 'ok', sha: SHA, reason: 'r', merge: false }, f.gh)).toMatchObject({ isError: false, output: expect.stringMatching(/not merged/) });
    expect(f.merges()).toHaveLength(0);
  });

  it('a conflict in a project without a changelog is refused (no auto-rebase)', async () => {
    const { inReview, run } = await setup();
    const c = inReview('datinel', 'https://github.com/datinel/datinel/pull/3');
    const f = fakeGh('datinel/datinel', 3, { pr: { mergeable: false } });
    expect(await run(c.id, { pr: 3, verdict: 'ok', sha: SHA, reason: 'r' }, f.gh)).toMatchObject({ isError: true, output: expect.stringMatching(/conflicts with main: rebase it/) });
    expect(f.statuses()).toHaveLength(0);
  });

  it('Atlas keeps its gate: CI job « test » and exactly one changelog entry', async () => {
    const { e, inReview, run } = await setup();
    const c = inReview('atlas', 'https://github.com/csoylu/atlas/pull/3');
    expect(e.projects.get('atlas')).toMatchObject({ repo: 'csoylu/atlas', ciJob: 'test', changelog: true });
    const none = fakeGh('csoylu/atlas', 3, { after: head + '## Fixed · #1 · old\n' });
    expect(await run(c.id, { pr: 3, verdict: 'ok', sha: SHA, reason: 'r' }, none.gh)).toMatchObject({ isError: true, output: expect.stringMatching(/adds no CHANGELOG\.md entry/) });
    const other = fakeGh('csoylu/atlas', 3, { checks: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }] });
    expect(await run(c.id, { pr: 3, verdict: 'ok', sha: SHA, reason: 'r' }, other.gh)).toMatchObject({ isError: true, output: expect.stringMatching(/CI job "test" has not run/) });
    const good = fakeGh('csoylu/atlas', 3);
    expect(await run(c.id, { pr: 3, verdict: 'ok', sha: SHA, reason: 'r' }, good.gh)).toMatchObject({ isError: false, output: expect.stringContaining('merged PR #3') });
  });

  it('fail sets failure with the reason, without CI or sha', async () => {
    const { inReview, run } = await setup();
    const c = inReview('datinel', 'https://github.com/datinel/datinel/pull/3');
    const f = fakeGh('datinel/datinel', 3, { checks: [] });
    expect(await run(c.id, { pr: 3, verdict: 'fail', reason: 'the feed drops a row' }, f.gh)).toMatchObject({ isError: false });
    expect(f.statuses()[0]!.join(' ')).toMatch(/state=failure.*description=zurich: the feed drops a row/);
  });

  it('refuses: not the reviewer, the builder, a PR not linked to the task, bad input', async () => {
    const { inReview, run } = await setup();
    const c = inReview('datinel', 'https://github.com/datinel/datinel/pull/3');
    const f = fakeGh('datinel/datinel', 3);
    expect(await run(c.id, { pr: 3, verdict: 'ok', sha: SHA, reason: 'r' }, f.gh, { agentId: 'munih' })).toMatchObject({ isError: true, output: expect.stringMatching(/not the reviewer .*@zurich is/) });
    expect(await run(c.id, { pr: 4, verdict: 'ok', sha: SHA, reason: 'r' }, f.gh)).toMatchObject({ isError: true, output: expect.stringMatching(/PR #4 of datinel\/datinel is not linked to this task/) });
    expect(await run(c.id, { pr: 3, verdict: 'ok', reason: 'r' }, f.gh)).toMatchObject({ isError: true, output: expect.stringMatching(/needs sha/) });
    expect(await run(c.id, { pr: 3, verdict: 'fail', reason: 'r', merge: true }, f.gh)).toMatchObject({ isError: true, output: expect.stringMatching(/merge only goes with verdict ok/) });
    expect(f.calls).toHaveLength(0);
  });

  it('is offered only to the reviewer of a task In review', async () => {
    const { e, inReview } = await setup();
    const c = inReview('datinel', 'https://github.com/datinel/datinel/pull/3');
    expect(prToolSpecs(c, 'zurich').map((s) => s.name)).toEqual(['pr_validate']);
    expect(prToolSpecs(c, 'munih')).toEqual([]);
    expect(prToolSpecs(e.kanban.create({ title: 'y', status: 'ready', assignee: 'munih' }, 'user'), 'zurich')).toEqual([]);
  });

  it('finds the reviewer’s clone of the repo in its workspace for the changelog-only rebase', async () => {
    expect(repoOfUrl('git@github.com:csoylu/atlas.git')).toBe('csoylu/atlas');
    expect(repoOfUrl('https://github.com/Datinel/Datinel')).toBe('datinel/datinel');
    expect(repoOfUrl('https://gitlab.com/a/b.git')).toBe(null);
    const ws = mkdtempSync(join(tmpdir(), 'prtools-'));
    for (const [dir, url] of [['other', 'git@github.com:csoylu/atlas.git'], ['datinel', 'git@github.com:datinel/datinel.git']]) {
      mkdirSync(join(ws, dir!));
      execFileSync('git', ['init', '-q', join(ws, dir!)]);
      execFileSync('git', ['-C', join(ws, dir!), 'remote', 'add', 'origin', url!]);
    }
    expect(await findClone(ws, 'datinel/datinel', process.env)).toBe(join(ws, 'datinel'));
    await expect(findClone(ws, 'datinel/other', process.env)).rejects.toThrow(/needs a clone of datinel\/other in your workspace/);
  });
});

describe('pr_validate in a reviewer run (#216)', () => {
  it('the reviewer’s run calls it and the status lands on the project’s repo', async () => {
    const f = fakeGh('datinel/datinel', 3, { after: head });
    const call = { type: 'tool_use' as const, id: 't_v', name: 'pr_validate', input: { pr: 3, verdict: 'ok', sha: SHA, reason: 'read it' } };
    const t = await launch({ script: [[call], [{ type: 'text', text: 'validated' }]], dispatch: false, prs: { read: async () => Promise.reject(new Error('no poll')), intervalMs: false, validate: { gh: f.gh, wait: { sleep: () => {}, everyMs: 0 } } } });
    const e = t.engine;
    for (const id of ['zurich', 'munih']) if (!e.agents.list().some((a) => a.id === id)) e.agents.create({ id, modelId: e.agents.get('atlas').modelId });
    e.settings.update({ reviewAgent: 'zurich', triageAgent: 'atlas' });
    e.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'munih', members: ['zurich'] });
    const c = e.kanban.create({ title: 'x', status: 'running', assignee: 'munih', projectId: 'datinel' }, 'user');
    e.kanban.requestReview(c.id, ['https://github.com/datinel/datinel/pull/3'], 'munih', 'built');
    e.runner.wake(c.id, { agentId: 'zurich', kind: 'work', kick: 'review it' });
    await t.idle(c.id);
    const result = e.kanban.messages(c.id).flatMap((m) => m.content).find((b) => b.type === 'tool_result');
    expect(result).toMatchObject({ content: expect.stringContaining('merged PR #3') });
    expect(result).not.toHaveProperty('is_error', true);
    expect(f.statuses()[0]![1]).toBe(`repos/datinel/datinel/statuses/${SHA}`);
  });
});
