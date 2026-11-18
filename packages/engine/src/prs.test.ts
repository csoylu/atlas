import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { launch, eventually, type LaunchOptions } from '../test/kit/index.ts';
import { combineChecks, parsePrUrl, UNREADABLE_NOTIFY_MS, type GhPr, type GhRead } from './prs.ts';

const URL = 'https://github.com/csoylu/atlas/pull/41';
const use = (name: string, input: unknown): ContentBlock[] => [{ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input }];
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

/** A GitHub that answers what the test sets (or fails with `down`). */
function fakeGitHub() {
  const gh: { pr: GhPr; down: string | null; reads: number; read: GhRead } = {
    pr: { state: 'open', mergeSha: null, headSha: 'aaaaaaa1111', branch: 'feat/170-x', base: 'main', mergeable: true, ci: 'pending', qa: null, qaDescription: null } as GhPr,
    down: null,
    reads: 0,
    read: async () => {
      gh.reads++;
      if (gh.down) throw new Error(gh.down);
      return { ...gh.pr };
    },
  };
  return gh;
}

let clock = Date.now();
async function setup(o: { script?: LaunchOptions['script']; dbFile?: string; dataDir?: string; gh?: ReturnType<typeof fakeGitHub> } = {}) {
  const gh = o.gh ?? fakeGitHub();
  const t = await launch({ script: o.script ?? [], dispatch: false, ...(o.dbFile ? { dbFile: o.dbFile, dataDir: o.dataDir } : {}), prs: { read: gh.read, intervalMs: false } });
  const e = t.engine;
  if (!e.agents.list().some((a) => a.id === 'zurich')) e.agents.create({ id: 'zurich', modelId: e.agents.get('atlas').modelId });
  e.settings.update({ reviewAgent: 'zurich', triageAgent: 'atlas' });
  // The poller's clock (the « can't read since » item waits 15 min).
  (e.prs as unknown as { now: () => number }).now = () => clock;
  return { ...t, e, gh };
}
const card = (e: Awaited<ReturnType<typeof setup>>['e'], assignee = 'atlas') => e.kanban.create({ title: 'Workflows', status: 'ready', assignee }, 'user');

describe('pull requests linked to tasks (#189)', () => {
  it('parses PR urls and combines check runs', () => {
    expect(parsePrUrl('https://github.com/csoylu/atlas/pull/41/files')).toEqual({ repo: 'csoylu/atlas', number: 41, url: URL });
    expect(() => parsePrUrl('https://gitlab.com/x/y/merge_requests/1')).toThrow(/not a GitHub pull request url/);
    expect(combineChecks([])).toBe(null);
    expect(combineChecks([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }])).toBe('success');
    expect(combineChecks([{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'success' }])).toBe('pending');
    expect(combineChecks([{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'failure' }])).toBe('failure');
  });

  it('task_request_review links the PR: In review, not in the Inbox; task_complete is refused while it is open', async () => {
    const { e, gh, idle } = await setup({
      script: [use('task_complete', { summary: 'x' }), use('task_request_review', { summary: 'engine + tests', prs: [] }), use('task_request_review', { summary: 'engine + tests', prs: [URL] })],
    });
    const c = card(e);
    e.kanban.update(c.id, { status: 'running' }, 'dispatcher');
    // A PR linked by hand first, so task_complete has one to refuse on.
    e.db.prepare("INSERT INTO card_prs (card_id, repo, number, url, linked_at) VALUES (?, 'csoylu/atlas', 41, ?, '2026-11-18')").run(c.id, URL);
    e.runner.wake(c.id, { kind: 'work', kick: 'go' });
    await idle(c.id);
    const results = e.kanban.messages(c.id).flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_result' ? [b] : [])));
    expect(results[0]).toMatchObject({ is_error: true, content: expect.stringContaining('PR #41 still open') });
    expect(results[1]).toMatchObject({ is_error: true, content: expect.stringContaining('give the url of your open pull request') });
    expect(results[2]!.content).toBe('in review: PR #41 waits for @zurich');
    const after = e.kanban.get(c.id);
    expect(after).toMatchObject({ status: 'review', reviewer: 'zurich', prs: [{ number: 41, repo: 'csoylu/atlas', url: URL }] });
    expect(e.notifications.inbox().needsYou).toEqual([]);
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'card.review'").get()).toEqual({ n: 0 });
    // CI still running: nobody runs, the card says why.
    await e.prs.poll();
    expect(gh.reads).toBe(1);
    expect(e.kanban.get(c.id)).toMatchObject({ status: 'review', waiting: 'QA starts when CI is green', prs: [{ ci: 'pending', headSha: 'aaaaaaa1111', branch: 'feat/170-x' }] });
    expect(e.runner.current(c.id)).toBe(null);
  });

  it("CI green starts the reviewer's run in the same thread, once per head; merged → done by itself", async () => {
    const { e, gh, idle } = await setup({ script: [text('checked, validated and merged')] });
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    gh.pr.ci = 'success';
    await e.prs.poll();
    const run = await eventually(() => e.runner.runs(c.id)[0]);
    expect(run).toMatchObject({ agentId: 'zurich', kind: 'work' });
    await idle(c.id);
    const kick = e.kanban.messages(c.id).find((m) => m.author === 'system')!;
    expect(kick.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('You review this task\'s pull request: PR #41') });
    expect(e.kanban.get(c.id)).toMatchObject({ status: 'review', prs: [{ reviewedSha: 'aaaaaaa1111' }] });
    // The same head again: no second run.
    await e.prs.poll();
    expect(e.runner.runs(c.id)).toHaveLength(1);
    expect(e.kanban.get(c.id).waiting).toBe('@zurich checked it: waiting for the validation on GitHub');

    gh.pr = { ...gh.pr, state: 'merged', mergeSha: 'e96a8e2ffff' };
    await e.prs.poll();
    const done = e.kanban.get(c.id);
    expect(done.status).toBe('done');
    expect(e.db.prepare("SELECT payload FROM card_events WHERE card_id = ? AND kind = 'completed'").get(c.id)).toEqual({
      payload: JSON.stringify({ by: 'github', summary: 'PR #41 merged into main (e96a8e2)' }),
    });
    expect(e.notifications.inbox().updates).toMatchObject([{ kind: 'card.done', body: 'PR #41 merged into main (e96a8e2)' }]);
  });

  it('a failed validation, a red CI, a conflict or a PR closed unmerged send it back to Ready with the reason as a note', async () => {
    const { e, gh } = await setup();
    const c = card(e);
    const note = () => e.kanban.messages(c.id).filter((m) => m.author === 'system').at(-1)!.content[0];
    const again = async () => {
      e.kanban.update(c.id, { status: 'running' }, 'dispatcher');
      e.kanban.requestReview(c.id, [URL], 'atlas', 'fixed');
    };

    e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    gh.pr = { ...gh.pr, ci: 'success', qa: 'failure', qaDescription: 'rebase: conflicts with main at CHANGELOG.md' };
    await e.prs.poll();
    expect(e.kanban.get(c.id).status).toBe('ready');
    expect(note()).toMatchObject({ text: 'PR #41: Validation failed (@zurich): rebase: conflicts with main at CHANGELOG.md. Back to Ready for @atlas: fix it, push, then task_request_review again.' });
    expect(e.notifications.inbox().needsYou).toEqual([]);

    await again();
    gh.pr = { ...gh.pr, headSha: 'bbbbbbb2222', ci: 'failure', qa: null };
    await e.prs.poll();
    expect(e.kanban.get(c.id).status).toBe('ready');
    expect(note()).toMatchObject({ text: expect.stringContaining('PR #41: CI failed on bbbbbbb') });

    await again();
    gh.pr = { ...gh.pr, headSha: 'ccccccc3333', ci: 'success', mergeable: false };
    await e.prs.poll();
    expect(note()).toMatchObject({ text: expect.stringContaining('PR #41: conflicts with main: rebase') });

    await again();
    gh.pr = { ...gh.pr, state: 'closed', mergeable: null };
    await e.prs.poll();
    expect(e.kanban.get(c.id).status).toBe('ready');
    expect(note()).toMatchObject({ text: expect.stringContaining('PR #41 was closed without merging') });
  });

  it("GitHub unreadable: nothing moves, the card says why; one Inbox item after 15 min, archived when it reads again", async () => {
    const { e, gh } = await setup();
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    await e.prs.poll(); // one good read
    gh.down = 'gh: not logged in';
    gh.pr = { ...gh.pr, state: 'merged', mergeSha: 'e96a8e2ffff' }; // GitHub moved on, we can't see it
    await e.prs.poll();
    let now = e.kanban.get(c.id);
    expect(now.status).toBe('review');
    expect(now.prs[0]).toMatchObject({ error: 'gh: not logged in', state: 'open' });
    expect(now.waiting).toMatch(/^can't read PR #41 from GitHub since \d\d:\d\d: gh: not logged in$/);
    expect(e.notifications.inbox().updates).toEqual([]);

    clock += UNREADABLE_NOTIFY_MS + 1000;
    await e.prs.poll();
    await e.prs.poll();
    expect(e.notifications.inbox().updates).toMatchObject([{ kind: 'github.unreadable', title: "Atlas can't read GitHub: gh: not logged in", cardId: c.id }]);

    gh.down = null;
    await e.prs.poll();
    now = e.kanban.get(c.id);
    expect(now.status).toBe('done');
    expect(e.notifications.inbox().updates.map((u) => u.kind)).toEqual(['card.done']);
  });

  it("the review agent's own PR goes to the triage agent", async () => {
    const { e } = await setup();
    const c = card(e, 'zurich');
    expect(e.kanban.requestReview(c.id, [URL], 'zurich', 'e2e').reviewer).toBe('atlas');
  });

  it('a restart in every state resumes from card_prs (no second reviewer run, no lost failure)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-prs-'));
    const dbFile = join(dataDir, 'atlas.db');
    const gh = fakeGitHub();
    let t = await setup({ dbFile, dataDir, gh, script: [text('checking')] });
    const c = card(t.e);
    t.e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    gh.pr.ci = 'success';
    await t.e.prs.poll();
    await t.idle(c.id);
    await t.e.stop();

    // In review, reviewer already started on this head: the restart doesn't start it again.
    t = await setup({ dbFile, dataDir, gh });
    expect(t.e.kanban.get(c.id)).toMatchObject({ status: 'review', reviewer: 'zurich', prs: [{ reviewedSha: 'aaaaaaa1111', ci: 'success' }] });
    await t.e.prs.poll();
    expect(t.e.runner.runs(c.id)).toHaveLength(1);
    // Failed, then restarted: the note is there once, the task is Ready.
    gh.pr = { ...gh.pr, qa: 'failure', qaDescription: 'tests red' };
    await t.e.prs.poll();
    await t.e.stop();
    t = await setup({ dbFile, dataDir, gh });
    await t.e.prs.poll();
    expect(t.e.kanban.get(c.id).status).toBe('ready');
    expect(t.e.kanban.messages(c.id).filter((m) => m.author === 'system' && JSON.stringify(m.content).includes('tests red'))).toHaveLength(1);
    // Back in review, merged while the engine was down: done at the first poll after the restart.
    t.e.kanban.requestReview(c.id, [URL], 'atlas', 'fixed');
    await t.e.stop();
    gh.pr = { ...gh.pr, headSha: 'ddddddd4444', qa: 'success', state: 'merged', mergeSha: 'fffffff0000' };
    t = await setup({ dbFile, dataDir, gh });
    await t.e.prs.poll();
    expect(t.e.kanban.get(c.id).status).toBe('done');
  });

  it('Retry on a task In review starts the reviewer again on the same head', async () => {
    const { e, gh, idle } = await setup({ script: [text('one'), text('two')] });
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'x');
    gh.pr.ci = 'success';
    await e.prs.poll();
    await eventually(() => e.runner.runs(c.id).length === 1);
    await idle(c.id);
    await e.dispatcher.retry(c.id);
    await eventually(() => e.runner.runs(c.id).length === 2, { what: 'a second reviewer run' });
    await idle(c.id);
  });
});
