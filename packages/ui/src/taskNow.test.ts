import { describe, expect, it } from 'vitest';
import type { Card, CardPr } from '@atlas/shared';
import { taskNow } from './taskNow.ts';

const NOW = Date.parse('2026-11-19T14:10:00Z');
const pr = (over: Partial<CardPr> = {}): CardPr => ({
  repo: 'csoylu/atlas', number: 74, url: 'https://github.com/csoylu/atlas/pull/74', branch: 'feat/237-stall-visibility', base: 'main', headSha: '0433c17aaaa',
  state: 'open', mergeSha: null, mergeable: true, ci: 'pending', ciFailed: null, qa: null, qaDescription: null, checkedAt: '2026-11-19T14:09:00Z', error: null, errorSince: null, reviewedSha: null,
  ...over,
});
type C = Parameters<typeof taskNow>[0];
const card = (over: Partial<Card> = {}): C => ({ status: 'review', block: null, waiting: null, stall: null, statusSince: '2026-11-19T14:07:00Z', prs: [], assignee: 'munih', ...over });

describe('the task sheet « Now » box (#269)', () => {
  it('In review: status and time, the engine sentence, the branch at its head', () => {
    const v = taskNow(card({ waiting: 'waiting for CI on PR #74', prs: [pr()] }), null, NOW);
    expect(v).toMatchObject({ icon: 'review', label: 'In review', since: '3 min', line: 'waiting for CI on PR #74', tone: 'muted' });
    expect(v.branch).toEqual({ name: 'feat/237-stall-visibility', sha: '0433c17' });
    expect(v.prNote).toBeNull();
  });
  it('running: who is working when the engine has nothing to add', () => {
    const v = taskNow(card({ status: 'running' }), { status: 'running', agentId: 'munih' }, NOW);
    expect(v).toMatchObject({ label: 'Running', line: '@munih is working.' });
  });
  it('blocked: the question says why, not a line; stopped by you reads so', () => {
    const block = { kind: 'needs_input' as const, reason: 'Which fix?', options: ['A', 'B'], until: null };
    expect(taskNow(card({ status: 'blocked', block, waiting: 'blocked: needs you' }), null, NOW)).toMatchObject({ label: 'Blocked', line: null });
    const stop = { ...block, reason: 'Stopped by you.', options: [] };
    expect(taskNow(card({ status: 'blocked', block: stop }), { status: 'stopped', agentId: 'munih' }, NOW)).toMatchObject({ icon: 'failed', label: 'Stopped by you' });
  });
  it('a stall wins over the engine sentence, in the stuck tone', () => {
    const stall = { rule: 'review' as const, reason: 'CI is green, no review is running', since: '2026-11-19T12:00:00Z', action: 'retry_review' as const };
    const v = taskNow(card({ stall, waiting: 'x', statusSince: '2026-11-19T12:10:00Z' }), null, NOW);
    expect(v).toMatchObject({ line: 'In review for 2 h: CI is green, no review is running', tone: 'stuck' });
  });
  it('GitHub unreadable turns the line orange; a red check or QA reason is its own note', () => {
    expect(taskNow(card({ waiting: "Can't read PR #74", prs: [pr({ error: 'gh: not logged in' })] }), null, NOW).tone).toBe('warn');
    const red = taskNow(card({ status: 'ready', prs: [pr({ ci: 'failure', ciFailed: { name: 'test', url: 'https://x/1' } })] }), null, NOW);
    expect(red.prNote).toEqual({ text: 'Red check: test', url: 'https://x/1' });
    expect(taskNow(card({ prs: [pr({ ci: 'success', qa: 'failure', qaDescription: 'no changelog file' })] }), null, NOW).prNote).toEqual({ text: 'QA: no changelog file', url: null });
  });
  it('done: no time, no branch of a merged PR', () => {
    const v = taskNow(card({ status: 'done', prs: [pr({ state: 'merged' })] }), null, NOW);
    expect(v).toMatchObject({ label: 'Done', since: null, line: null, branch: null });
  });
});
