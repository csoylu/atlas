import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module (a script run with node)
import { CONTEXT, parseArgs, pending, validate } from './validate.mjs';

const SHA = 'a'.repeat(40);
const head = '# Changelog\n\nIntro.\n\n';
const oldLog = head + '## Fixed · #1 · old\n';
const newLog = head + '## Added · #2 · new\n\n## Fixed · #1 · old\n';

type Over = { pr?: Record<string, unknown>; ci?: unknown[]; ciNew?: unknown[][]; before?: string | null; after?: string; mergeFails?: boolean };
const NEW = 'e'.repeat(40);

/** A fake `gh`: answers the API paths validate.mjs asks for and records every call. */
function fakeGh(over: Over = {}) {
  const calls: string[][] = [];
  const pr = {
    state: 'open', draft: false, merged: false, mergeable: true, base: { ref: 'main' }, head: { sha: SHA, ref: 'fix/2-x' },
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
    if (path.includes(`commits/${NEW}/check-runs`)) return JSON.stringify({ check_runs: over.ciNew?.shift() ?? [] }); // one answer per poll
    if (/check-runs/.test(path)) return JSON.stringify({ check_runs: ci });
    if (/\/compare\//.test(path)) return JSON.stringify({ merge_base_commit: { sha: 'c'.repeat(40) } });
    if (/contents\/CHANGELOG\.md\?ref=c+$/.test(path)) {
      if (over.before === null) throw new Error('404');
      return over.before ?? oldLog;
    }
    if (/contents\/CHANGELOG\.md/.test(path)) return over.after ?? newLog;
    if (/\/statuses\//.test(path)) return '{}';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  return { gh, calls, statuses: () => calls.filter((c) => /\/statuses\//.test(c[1])) };
}

const ok = (extra: Record<string, unknown> = {}) =>
  ({ pr: 2, verdict: 'success', sha: SHA, as: 'zurich', reason: 'tests green, read the diff', merge: false, base: 'main', ...extra });

describe('validate.mjs arguments', () => {
  it('parses --ok with sha, who and the reason', async () => {
    expect(parseArgs(['2', '--ok', '--sha', 'abc1234', '--as', 'zurich', 'read', 'it', '--merge'])).toMatchObject({
      pr: 2, verdict: 'success', sha: 'abc1234', as: 'zurich', reason: 'read it', merge: true, base: 'main',
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
  it('refuses a PR whose base is not main, and sets nothing', async () => {
    const f = fakeGh({ pr: { base: { ref: 'feat/slash-commands' } } });
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
    await expect(validate(ok(), f.gh)).rejects.toThrow(/conflicts with main: rebase it.*--merge rebases it by itself/);
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
    await expect(validate(ok(), fakeGh({ ci: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }] }).gh)).rejects.toThrow(/is failure/);
  });
  it('uses the latest run of the job (a re-run that passes)', async () => {
    const ci = [
      { id: 1, name: 'test', status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'test', status: 'completed', conclusion: 'success' },
    ];
    await expect(validate(ok(), fakeGh({ ci }).gh)).resolves.toBeDefined();
  });
  it('refuses a PR without exactly one new CHANGELOG entry', async () => {
    await expect(validate(ok(), fakeGh({ after: oldLog }).gh)).rejects.toThrow(/adds no CHANGELOG\.md entry/);
    const two = head + '## Added · #3 · b\n\n## Added · #2 · a\n\n## Fixed · #1 · old\n';
    await expect(validate(ok(), fakeGh({ after: two }).gh)).rejects.toThrow(/adds 2 CHANGELOG\.md entries/);
  });
  it("refuses a QA PR validated by its author, accepts it from atlas", async () => {
    const pr = { head: { sha: SHA, ref: 'qa/141-pr-gate' } };
    await expect(validate(ok(), fakeGh({ pr }).gh)).rejects.toThrow(/someone else validates it/);
    await expect(validate(ok({ as: 'atlas' }), fakeGh({ pr }).gh)).resolves.toBeDefined();
  });
});

describe('validate.mjs --ok --merge on a PR that conflicts with main (#188)', () => {
  const green = { id: 9, name: 'test', status: 'completed', conclusion: 'success' };
  const rebased = { oldHead: SHA, newHead: NEW, onto: 'f'.repeat(40), commits: 1, lines: ['fix/2-x conflicted with main in CHANGELOG.md only: …', `head changed aaaaaaa → eeeeeee …`] };
  const deps = (rebase = (_: unknown) => rebased) => {
    const asked: unknown[] = [];
    const slept: number[] = [];
    return {
      asked, slept,
      d: { rebase: (a: unknown) => (asked.push(a), rebase(a)), wait: { sleep: (ms: number) => slept.push(ms), everyMs: 5, now: () => 0 }, log: () => {} },
    };
  };

  it('rebases, waits for CI on the new head, validates and merges the new head, and says the head changed', async () => {
    const f = fakeGh({ pr: { mergeable: false }, ciNew: [[], [{ id: 9, name: 'test', status: 'in_progress' }], [green]] });
    const x = deps();
    const out = (await validate(ok({ merge: true }), f.gh, x.d)).join('\n');
    expect(x.asked).toEqual([{ branch: 'fix/2-x', sha: SHA, base: 'main' }]);
    expect(x.slept).toHaveLength(2); // not run yet, running, green
    expect(f.statuses()).toHaveLength(1);
    expect(f.statuses()[0][1]).toBe(`repos/csoylu/atlas/statuses/${NEW}`);
    expect(f.statuses()[0].join(' ')).toMatch(/state=success.*auto-rebased from aaaaaaa/);
    expect(f.calls.find((c) => /\/merge$/.test(c[1]))).toContain(`sha=${NEW}`);
    expect(out).toMatch(/head changed aaaaaaa → eeeeeee/);
    expect(out).toMatch(/merged PR #2/);
  });

  it('CI red on the new head: no merge, qa/validated = failure on the new head with the reason', async () => {
    const f = fakeGh({ pr: { mergeable: false }, ciNew: [[{ ...green, conclusion: 'failure' }]] });
    await expect(validate(ok({ merge: true }), f.gh, deps().d)).rejects.toThrow(/not merged: .*rebased onto main .*is failure on eeeeeee/);
    expect(f.statuses()).toHaveLength(1);
    expect(f.statuses()[0][1]).toBe(`repos/csoylu/atlas/statuses/${NEW}`);
    expect(f.statuses()[0]).toContain('state=failure');
    expect(f.calls.some((c) => /\/merge$/.test(c[1]))).toBe(false);
  });

  it('CI never finishes: gives up after the timeout, no merge', async () => {
    let t = 0;
    const f = fakeGh({ pr: { mergeable: false }, ciNew: Array.from({ length: 50 }, () => []) });
    const d = { rebase: () => rebased, wait: { sleep: () => (t += 60e3), timeoutMs: 5 * 60e3, now: () => t }, log: () => {} };
    await expect(validate(ok({ merge: true }), f.gh, d)).rejects.toThrow(/did not finish on eeeeeee within 5 min/);
    expect(f.calls.some((c) => /\/merge$/.test(c[1]))).toBe(false);
  });

  it('a refused rebase (another file conflicts, head moved) sets nothing and merges nothing', async () => {
    const f = fakeGh({ pr: { mergeable: false } });
    const x = deps(() => {
      throw new Error('refused: conflicts with main in b.txt (and CHANGELOG.md): rebase it by hand');
    });
    await expect(validate(ok({ merge: true }), f.gh, x.d)).rejects.toThrow(/b\.txt.*by hand/);
    expect(f.statuses()).toHaveLength(0);
    expect(f.calls.some((c) => /\/merge$/.test(c[1]))).toBe(false);
  });

  it('the usual checks still come first: a head that moved since the review is refused before any rebase', async () => {
    const f = fakeGh({ pr: { mergeable: false, head: { sha: 'd'.repeat(40), ref: 'fix/2-x' } } });
    const x = deps();
    await expect(validate(ok({ merge: true }), f.gh, x.d)).rejects.toThrow(/pushed after your review/);
    expect(x.asked).toHaveLength(0);
  });

  it('without --merge a conflicting PR is still refused (no rebase)', async () => {
    const x = deps();
    await expect(validate(ok(), fakeGh({ pr: { mergeable: false } }).gh, x.d)).rejects.toThrow(/conflicts with main/);
    expect(x.asked).toHaveLength(0);
  });
});

describe('validate.mjs for another project (#216)', () => {
  it('parses --repo, --ci-job (any = every check) and --no-changelog; defaults are Atlas’s', async () => {
    expect(parseArgs(['2', '--fail', '--as', 'zurich', 'x'])).toMatchObject({ repo: 'csoylu/atlas', ciJob: 'test', changelog: true });
    expect(parseArgs(['2', '--fail', '--as', 'zurich', 'x', '--repo', 'datinel/datinel', '--ci-job', 'any', '--no-changelog'])).toMatchObject({ repo: 'datinel/datinel', ciJob: null, changelog: false });
    expect(parseArgs(['2', '--fail', '--as', 'zurich', 'x', '--ci-job', 'ci'])).toMatchObject({ ciJob: 'ci' });
    expect(() => parseArgs(['2', '--fail', '--as', 'zurich', 'x', '--repo', 'nope'])).toThrow(/owner\/name/);
  });
  it('without a changelog: no CHANGELOG.md read, no auto-rebase on a conflict, no release wording', async () => {
    const f = fakeGh({ after: oldLog });
    const out = await validate(ok({ merge: true, changelog: false }), f.gh);
    expect(f.calls.some((c) => c[1].includes('CHANGELOG'))).toBe(false);
    expect(out.join('\n')).not.toMatch(/release/);
    let rebased = false;
    await expect(validate(ok({ merge: true, changelog: false }), fakeGh({ pr: { mergeable: false } }).gh, { rebase: () => ((rebased = true), {}) })).rejects.toThrow(/conflicts with main: rebase it, push, then validate the new head$/);
    expect(rebased).toBe(false);
  });
});

describe('validate.mjs --fail', () => {
  it('sets failure with the reason, without checking CI or the sha', async () => {
    const f = fakeGh({ ci: [] });
    await validate({ pr: 2, verdict: 'failure', sha: null, as: 'zurich', reason: 'screenshot shows overflow', merge: false, base: 'main' }, f.gh);
    expect(f.statuses()[0]).toContain('state=failure');
    expect(f.calls.some((c) => /check-runs/.test(c[1]))).toBe(false);
  });
  it('truncates a long reason to GitHub’s 140 characters', async () => {
    const f = fakeGh();
    await validate({ pr: 2, verdict: 'failure', sha: null, as: 'zurich', reason: 'x'.repeat(300), merge: false, base: 'main' }, f.gh);
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
