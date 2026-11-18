import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JS module (a script run with node)
import { CONTEXT, parseArgs, pending, validate } from './validate.mjs';

const SHA = 'a'.repeat(40);
const head = '# Changelog\n\nIntro.\n\n';
const oldLog = head + '## Fixed · #1 · old\n';
const newLog = head + '## Added · #2 · new\n\n## Fixed · #1 · old\n';

type Over = { pr?: Record<string, unknown>; ci?: unknown[]; before?: string | null; after?: string; mergeFails?: boolean };

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
  it('parses --ok with sha, who and the reason', () => {
    expect(parseArgs(['2', '--ok', '--sha', 'abc1234', '--as', 'zurich', 'read', 'it', '--merge'])).toMatchObject({
      pr: 2, verdict: 'success', sha: 'abc1234', as: 'zurich', reason: 'read it', merge: true, base: 'main',
    });
  });
  it('refuses a missing or wrong PR number, verdict, who, reason and sha', () => {
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
  it('--fail needs no sha but a reason, and never merges', () => {
    expect(parseArgs(['2', '--fail', '--as', 'zurich', 'broken'])).toMatchObject({ verdict: 'failure', reason: 'broken' });
    expect(() => parseArgs(['2', '--fail', '--as', 'zurich', 'broken', '--merge'])).toThrow(/--merge/);
  });
});

describe('validate.mjs --ok', () => {
  it('sets qa/validated = success on the head commit when everything holds', () => {
    const f = fakeGh();
    const out = validate(ok(), f.gh);
    expect(f.statuses()).toHaveLength(1);
    const call = f.statuses()[0];
    expect(call[1]).toBe(`repos/csoylu/atlas/statuses/${SHA}`);
    expect(call).toContain('state=success');
    expect(call).toContain(`context=${CONTEXT}`);
    expect(call.join(' ')).toContain('description=zurich: tests green, read the diff');
    expect(out.join('\n')).toMatch(/not merged/);
  });
  it('--merge merges pinned to the validated sha', () => {
    const f = fakeGh();
    const out = validate(ok({ merge: true }), f.gh);
    const merge = f.calls.find((c) => /\/merge$/.test(c[1]))!;
    expect(merge).toContain(`sha=${SHA}`);
    expect(merge).toContain('merge_method=merge');
    expect(out.join('\n')).toMatch(/merged PR #2/);
  });
  it('a failed merge (head moved) is an error after the status, not a silent success', () => {
    expect(() => validate(ok({ merge: true }), fakeGh({ mergeFails: true }).gh)).toThrow(/409/);
  });
  it('refuses a PR whose base is not main, and sets nothing', () => {
    const f = fakeGh({ pr: { base: { ref: 'feat/slash-commands' } } });
    expect(() => validate(ok(), f.gh)).toThrow(/based on "feat\/slash-commands", not main/);
    expect(f.statuses()).toHaveLength(0);
  });
  it('--base lets the gate be tried on a throwaway branch', () => {
    const f = fakeGh({ pr: { base: { ref: 'gate-test' } } });
    validate(ok({ base: 'gate-test' }), f.gh);
    expect(f.statuses()).toHaveLength(1);
  });
  it('refuses when a commit was pushed after the review (sha differs)', () => {
    const f = fakeGh({ pr: { head: { sha: 'd'.repeat(40), ref: 'fix/2-x' } } });
    expect(() => validate(ok(), f.gh)).toThrow(/pushed after your review/);
    expect(f.statuses()).toHaveLength(0);
  });
  it('refuses a PR that conflicts with its base, or whose mergeability is not known yet, and sets nothing', () => {
    const f = fakeGh({ pr: { mergeable: false } });
    expect(() => validate(ok(), f.gh)).toThrow(/conflicts with main: rebase/);
    expect(f.statuses()).toHaveLength(0);
    expect(() => validate(ok(), fakeGh({ pr: { mergeable: null } }).gh)).toThrow(/still working out/);
  });
  it('refuses a closed, merged or draft PR', () => {
    expect(() => validate(ok(), fakeGh({ pr: { state: 'closed', merged: true } }).gh)).toThrow(/already merged/);
    expect(() => validate(ok(), fakeGh({ pr: { state: 'closed' } }).gh)).toThrow(/closed/);
    expect(() => validate(ok(), fakeGh({ pr: { draft: true } }).gh)).toThrow(/draft/);
  });
  it('refuses while CI is missing, running or red', () => {
    expect(() => validate(ok(), fakeGh({ ci: [] }).gh)).toThrow(/has not run/);
    expect(() => validate(ok(), fakeGh({ ci: [{ id: 1, name: 'test', status: 'in_progress', conclusion: null }] }).gh)).toThrow(/still running/);
    expect(() => validate(ok(), fakeGh({ ci: [{ id: 1, name: 'test', status: 'completed', conclusion: 'failure' }] }).gh)).toThrow(/is failure/);
  });
  it('uses the latest run of the job (a re-run that passes)', () => {
    const ci = [
      { id: 1, name: 'test', status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'test', status: 'completed', conclusion: 'success' },
    ];
    expect(() => validate(ok(), fakeGh({ ci }).gh)).not.toThrow();
  });
  it('refuses a PR without exactly one new CHANGELOG entry', () => {
    expect(() => validate(ok(), fakeGh({ after: oldLog }).gh)).toThrow(/adds no CHANGELOG\.md entry/);
    const two = head + '## Added · #3 · b\n\n## Added · #2 · a\n\n## Fixed · #1 · old\n';
    expect(() => validate(ok(), fakeGh({ after: two }).gh)).toThrow(/adds 2 CHANGELOG\.md entries/);
  });
  it("refuses a QA PR validated by its author, accepts it from atlas", () => {
    const pr = { head: { sha: SHA, ref: 'qa/141-pr-gate' } };
    expect(() => validate(ok(), fakeGh({ pr }).gh)).toThrow(/someone else validates it/);
    expect(() => validate(ok({ as: 'atlas' }), fakeGh({ pr }).gh)).not.toThrow();
  });
});

describe('validate.mjs --fail', () => {
  it('sets failure with the reason, without checking CI or the sha', () => {
    const f = fakeGh({ ci: [] });
    validate({ pr: 2, verdict: 'failure', sha: null, as: 'zurich', reason: 'screenshot shows overflow', merge: false, base: 'main' }, f.gh);
    expect(f.statuses()[0]).toContain('state=failure');
    expect(f.calls.some((c) => /check-runs/.test(c[1]))).toBe(false);
  });
  it('truncates a long reason to GitHub’s 140 characters', () => {
    const f = fakeGh();
    validate({ pr: 2, verdict: 'failure', sha: null, as: 'zurich', reason: 'x'.repeat(300), merge: false, base: 'main' }, f.gh);
    const d = f.statuses()[0].find((a: string) => a.startsWith('description='))!.slice('description='.length);
    expect(d.length).toBeLessThanOrEqual(140);
  });
});

describe('validate.mjs --list', () => {
  it('lists open PRs without a success, oldest created first (a new push does not reset the wait), and skips validated and draft ones', () => {
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
    const rows = pending(gh, now);
    expect(rows.map((r: { pr: number }) => r.pr)).toEqual([5, 4]);
    expect(rows[0]).toMatchObject({ state: 'failure', note: 'zurich: overflow', waitingHours: 4 });
    expect(rows[1]).toMatchObject({ state: 'waiting', waitingHours: 1 });
  });
});
