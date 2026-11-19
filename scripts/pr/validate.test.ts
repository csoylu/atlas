import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module (a script run with node)
import { CONTEXT, parseArgs, pending, validate } from './validate.mjs';

const SHA = 'a'.repeat(40);
type Over = { pr?: Record<string, unknown>; ci?: unknown[]; mergeFails?: boolean };

/** A fake `gh`: answers the API paths validate.mjs asks for (the PR, check runs, statuses, merge) and records every call. */
function fakeGh(over: Over = {}) {
  const calls: string[][] = [];
  const pr = {
    state: 'open', draft: false, merged: false, mergeable: true, base: { ref: 'main', repo: { full_name: 'csoylu/atlas', default_branch: 'main' } }, head: { sha: SHA, ref: 'fix/2-x' },
    number: 2, title: 't', updated_at: '2026-11-18T10:00:00Z', ...over.pr,
  };
  const ci = over.ci ?? [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }];
  const gh = (args: string[]) => {
    calls.push(args);
    const path = args[1];
    if (/\/pulls\/2$/.test(path)) return JSON.stringify(pr);
    if (/\/pulls\/2\/merge$/.test(path)) {
      if (over.mergeFails) throw new Error('409 head changed');
      return JSON.stringify({ sha: 'b'.repeat(40), merged: true });
    }
    if (/check-runs/.test(path)) return JSON.stringify({ check_runs: ci });
    if (/\/statuses\//.test(path)) return '{}';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { gh, calls, statuses: () => calls.filter((c) => /\/statuses\//.test(c[1])) };
}

const ok = (extra: Record<string, unknown> = {}) =>
  ({ pr: 2, verdict: 'success', sha: SHA, as: 'zurich', reason: 'tests green, read the diff', merge: false, base: null, repo: 'csoylu/atlas', ciJob: 'test', ...extra });

describe('validate.mjs arguments', () => {
  it('parses --ok with sha, who and the reason', async () => {
    expect(parseArgs(['2', '--ok', '--sha', 'abc1234', '--as', 'zurich', 'read', 'it', '--merge'])).toMatchObject({
      pr: 2, verdict: 'success', sha: 'abc1234', as: 'zurich', reason: 'read it', merge: true, base: null, repo: 'csoylu/atlas', ciJob: 'test',
    });
  });
  it('refuses a missing or wrong PR number, verdict, who, reason and sha', async () => {
    expect(() => parseArgs(['--ok'])).toThrow(/PR number/);
    expect(() => parseArgs(['x', '--ok'])).toThrow(/PR number/);
    expect(() => parseArgs(['2'])).toThrow(/--ok or --fail/);
    expect(() => parseArgs(['2', '--ok', '--fail'])).toThrow(/together/);
    expect(() => parseArgs(['2', '--ok', '--sha', 'abc1234', 'why'])).toThrow(/--as/);
    expect(() => parseArgs(['2', '--ok', '--sha', 'abc1234', '--as', 'bob', 'why'])).toThrow(/--as/);
    expect(() => parseArgs(['2', '--ok', '--sha', 'abc1234', '--as', 'zurich'])).toThrow(/reason/);
    expect(() => parseArgs(['2', '--ok', '--as', 'zurich', 'why'])).toThrow(/--sha/);
    expect(() => parseArgs(['2', '--ok', '--sha', 'nothex', '--as', 'zurich', 'why'])).toThrow(/--sha/);
    expect(() => parseArgs(['2', '--ok', '--sha'])).toThrow(/needs a value/);
    expect(() => parseArgs(['2', '--wat'])).toThrow(/unknown option/);
  });
  it('--fail needs no sha but a reason, and never merges', async () => {
    expect(parseArgs(['2', '--fail', '--as', 'zurich', 'broken'])).toMatchObject({ verdict: 'failure', reason: 'broken' });
    expect(() => parseArgs(['2', '--fail', '--as', 'zurich', 'broken', '--merge'])).toThrow(/--merge/);
  });
});

describe('validate.mjs --ok', () => {
  it('sets qa/validated = success on the head commit when everything holds', async () => {
    const f = fakeGh();
    const out = await validate(ok(), f.gh);
    expect(f.statuses()).toHaveLength(1);
    const call = f.statuses()[0];
    expect(call[1]).toBe(`repos/csoylu/atlas/statuses/${SHA}`);
    expect(call).toContain('state=success');
    expect(call).toContain(`context=${CONTEXT}`);
    expect(call.join(' ')).toContain('description=zurich: tests green, read the diff');
    expect(out.join('\n')).toMatch(/not merged/);
  });
  it('--merge merges pinned to the validated sha', async () => {
    const f = fakeGh();
    const out = await validate(ok({ merge: true }), f.gh);
    const merge = f.calls.find((c) => /\/merge$/.test(c[1]))!;
    expect(merge).toContain(`sha=${SHA}`);
    expect(merge).toContain('merge_method=merge');
    expect(out.join('\n')).toMatch(/merged PR #2/);
  });
  it('a failed merge (head moved) is an error after the status, not a silent success', async () => {
    await expect(validate(ok({ merge: true }), fakeGh({ mergeFails: true }).gh)).rejects.toThrow(/409/);
  });
  it('refuses a PR whose base is not the default branch, and sets nothing', async () => {
    const f = fakeGh({ pr: { base: { ref: 'feat/slash-commands', repo: { default_branch: 'main' } } } });
    await expect(validate(ok(), f.gh)).rejects.toThrow(/based on "feat\/slash-commands", not main/);
    expect(f.statuses()).toHaveLength(0);
  });
  it('--base lets the gate be tried on a throwaway branch', async () => {
    const f = fakeGh({ pr: { base: { ref: 'gate-test' } } });
    await validate(ok({ base: 'gate-test' }), f.gh);
    expect(f.statuses()).toHaveLength(1);
  });
  it('refuses when a commit was pushed after the review (sha differs)', async () => {
    const f = fakeGh({ pr: { head: { sha: 'd'.repeat(40), ref: 'fix/2-x' } } });
    await expect(validate(ok(), f.gh)).rejects.toThrow(/pushed after your review/);
    expect(f.statuses()).toHaveLength(0);
  });
  it('refuses a PR that conflicts with its base, or whose mergeability is not known yet, and sets nothing', async () => {
    const f = fakeGh({ pr: { mergeable: false } });
    await expect(validate(ok(), f.gh)).rejects.toThrow(/conflicts with main: rebase it, push, then validate the new head$/);
    await expect(validate(ok({ merge: true }), fakeGh({ pr: { mergeable: false } }).gh)).rejects.toThrow(/conflicts with main/); // no auto-rebase any more (#223)
    expect(f.statuses()).toHaveLength(0);
    await expect(validate(ok(), fakeGh({ pr: { mergeable: null } }).gh)).rejects.toThrow(/still working out/);
  });
  it('refuses a closed, merged or draft PR', async () => {
    await expect(validate(ok(), fakeGh({ pr: { state: 'closed', merged: true } }).gh)).rejects.toThrow(/already merged/);
    await expect(validate(ok(), fakeGh({ pr: { state: 'closed' } }).gh)).rejects.toThrow(/closed/);
    await expect(validate(ok(), fakeGh({ pr: { draft: true } }).gh)).rejects.toThrow(/draft/);
  });
  it('refuses while CI is missing, running or red', async () => {
    await expect(validate(ok(), fakeGh({ ci: [] }).gh)).rejects.toThrow(/has not run/);
    await expect(validate(ok(), fakeGh({ ci: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }).gh)).rejects.toThrow(/still running/);
    await expect(validate(ok(), fakeGh({ ci: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://x/runs/1' }] }).gh)).rejects.toThrow(
      /CI job "test" is failure on aaaaaaa \(https:\/\/x\/runs\/1\): its log says what to fix in the repo/,
    );
  });
  it('uses the latest run of the job (a re-run that passes)', async () => {
    const ci = [
      { id: 1, name: 'test', status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'test', status: 'completed', conclusion: 'success' },
    ];
    await expect(validate(ok(), fakeGh({ ci }).gh)).resolves.toBeDefined();
  });
  it('reads no file of the PR: a repo rule (the changelog entry, #223) is a CI check of the repo (#238)', async () => {
    const f = fakeGh();
    await validate(ok({ merge: true }), f.gh);
    expect(f.calls.map((c) => c[1].replace(SHA, 'SHA'))).toEqual([
      'repos/csoylu/atlas/pulls/2',
      'repos/csoylu/atlas/commits/SHA/check-runs?per_page=100',
      'repos/csoylu/atlas/statuses/SHA',
      'repos/csoylu/atlas/pulls/2/merge',
    ]);
  });
  it('needs the repo: the shared gate has no default project', async () => {
    await expect(validate(ok({ repo: undefined }), fakeGh().gh)).rejects.toThrow(/needs the repo/);
  });
  it("refuses a QA PR validated by its author, accepts it from atlas", async () => {
    const pr = { head: { sha: SHA, ref: 'qa/141-pr-gate' } };
    await expect(validate(ok(), fakeGh({ pr }).gh)).rejects.toThrow(/someone else validates it/);
    await expect(validate(ok({ as: 'atlas' }), fakeGh({ pr }).gh)).resolves.toBeDefined();
  });
});

describe('validate.mjs for another project (#216)', () => {
  it('parses --repo and --ci-job (any = every check); defaults are Atlas’s; --no-changelog is gone (#238)', async () => {
    expect(parseArgs(['2', '--fail', '--as', 'zurich', 'x'])).toMatchObject({ repo: 'csoylu/atlas', ciJob: 'test' });
    expect(parseArgs(['2', '--fail', '--as', 'zurich', 'x', '--repo', 'datinel/datinel', '--ci-job', 'any'])).toMatchObject({ repo: 'datinel/datinel', ciJob: null });
    expect(() => parseArgs(['2', '--fail', '--as', 'zurich', 'x', '--no-changelog'])).toThrow(/unknown option --no-changelog/);
    expect(parseArgs(['2', '--fail', '--as', 'zurich', 'x', '--ci-job', 'ci'])).toMatchObject({ ciJob: 'ci' });
    expect(() => parseArgs(['2', '--fail', '--as', 'zurich', 'x', '--repo', 'nope'])).toThrow(/owner\/name/);
  });
  it('any check: every latest check run green (skipped counts), a red one named', async () => {
    const ci = [{ id: 1, name: 'build', status: 'completed', conclusion: 'success' }, { id: 2, name: 'lint', status: 'completed', conclusion: 'skipped' }];
    await expect(validate(ok({ repo: 'csoylu/atlas', ciJob: null }), fakeGh({ ci }).gh)).resolves.toBeDefined();
    const red = [...ci, { id: 3, name: 'e2e', status: 'completed', conclusion: 'failure' }];
    await expect(validate(ok({ ciJob: null }), fakeGh({ ci: red }).gh)).rejects.toThrow(/CI check "e2e" is failure/);
  });
});

describe('validate.mjs --fail', () => {
  it('sets failure with the reason, without checking CI or the sha', async () => {
    const f = fakeGh({ ci: [] });
    await validate({ pr: 2, verdict: 'failure', sha: null, as: 'zurich', reason: 'screenshot shows overflow', merge: false, base: null, repo: 'csoylu/atlas', ciJob: 'test' }, f.gh);
    expect(f.statuses()[0]).toContain('state=failure');
    expect(f.calls.some((c) => /check-runs/.test(c[1]))).toBe(false);
  });
  it('truncates a long reason to GitHub’s 140 characters', async () => {
    const f = fakeGh();
    await validate({ pr: 2, verdict: 'failure', sha: null, as: 'zurich', reason: 'x'.repeat(300), merge: false, base: null, repo: 'csoylu/atlas', ciJob: 'test' }, f.gh);
    const d = f.statuses()[0].find((a: string) => a.startsWith('description='))!.slice('description='.length);
    expect(d.length).toBeLessThanOrEqual(140);
  });
});

describe('validate.mjs --list', () => {
  it('lists open PRs without a success, oldest created first (a new push does not reset the wait), and skips validated and draft ones', async () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const prs = [
      { number: 4, title: 'a', head: { sha: '4'.repeat(40), ref: 'x/4' }, draft: false, created_at: '2026-11-18T11:00:00Z', updated_at: '2026-11-18T11:59:00Z' },
      { number: 5, title: 'b', head: { sha: '5'.repeat(40), ref: 'x/5' }, draft: false, updated_at: '2026-11-18T08:00:00Z' },
      { number: 6, title: 'c', head: { sha: '6'.repeat(40), ref: 'x/6' }, draft: false, updated_at: '2026-11-18T08:00:00Z' },
      { number: 7, title: 'd', head: { sha: '7'.repeat(40), ref: 'x/7' }, draft: true, updated_at: '2026-11-18T08:00:00Z' },
    ];
    const statuses: Record<string, unknown[]> = {
      '4': [],
      '5': [{ context: CONTEXT, state: 'failure', description: 'zurich: overflow' }],
      '6': [{ context: CONTEXT, state: 'success' }],
    };
    const gh = (args: string[]) => {
      if (/\/pulls\?/.test(args[1])) return JSON.stringify(prs);
      return JSON.stringify({ statuses: statuses[args[1].match(/commits\/(\d)/)![1]] ?? [] });
    };
    const rows = await pending(gh, now);
    expect(rows.map((r: { pr: number }) => r.pr)).toEqual([5, 4]);
    expect(rows[0]).toMatchObject({ state: 'failure', note: 'zurich: overflow', waitingHours: 4 });
    expect(rows[1]).toMatchObject({ state: 'waiting', waitingHours: 1 });
  });
});
