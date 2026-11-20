import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import type { ModelRequest } from './providers/types.ts';
import { eventually, setReviewAgent } from '../test/kit/index.ts';
import { reviewWorkflowOf } from './reviewFlow.ts';
import { HEAD, URL, atStep, byAgent, card, clock, ended, fakeGitHub, inbox, lastNote, lastRun, notes, path, setupReview as setup, text, use, verdict, type E } from '../test/reviewKit.ts';
import { combineChecks, failedCheck, parsePrUrl, UNREADABLE_NOTIFY_MS } from './prs.ts';

/**
 * Pull requests linked to tasks (#189) and their review, now each project's default Review workflow (#263, design §9):
 * a task asks for review → CI finished → green, no conflict? → the review agent in the thread → validate + merge →
 * Done; every negative exit → back to the builder. The engine, the model (FakeProvider) and GitHub (one fake behind
 * both the PR reader and the gate's `gh api`) are the real wiring. The workflow's own tests: reviewFlow.test.ts.
 */

const FULL = [['trigger', 'start'], ['ci', 'event'], ['checks', 'yes'], ['review', 'approved'], ['merge', 'merged'], ['done', 'done']];

describe('pull requests linked to tasks (#189), reviewed by the Review workflow (#263)', () => {
  it('parses PR urls and combines check runs', () => {
    expect(parsePrUrl('https://github.com/csoylu/atlas/pull/41/files')).toEqual({ repo: 'csoylu/atlas', number: 41, url: URL });
    expect(() => parsePrUrl('https://gitlab.com/x/y/merge_requests/1')).toThrow(/not a GitHub pull request url/);
    expect(combineChecks([])).toBe(null);
    expect(combineChecks([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }])).toBe('success');
    expect(combineChecks([{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'success' }])).toBe('pending');
    expect(combineChecks([{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'failure' }])).toBe('failure');
    // #238: the red check, named and linked, for the builder's note.
    expect(failedCheck([{ name: 'lint', status: 'completed', conclusion: 'success' }, { name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/o/r/runs/2' }])).toEqual({ name: 'test', url: 'https://github.com/o/r/runs/2' });
    expect(failedCheck([{ name: 'test', status: 'completed', conclusion: 'success' }])).toBe(null);
  });

  it('task_request_review links the PR: In review, not in the Inbox; task_complete is refused while it is open; one PR per task', async () => {
    const { e, gh, idle } = await setup({
      script: [use('task_complete', { summary: 'x' }), use('task_request_review', { summary: 'engine + tests', prs: [] }), use('task_request_review', { summary: 'engine + tests', prs: [URL] }), text('waiting')],
    });
    const c = card(e);
    e.kanban.update(c.id, { status: 'running' }, 'dispatcher');
    // A PR linked by hand first, so task_complete has one to refuse on.
    e.db.prepare("INSERT INTO card_prs (card_id, repo, number, url, linked_at) VALUES (?, 'csoylu/atlas', 41, ?, '2026-11-18')").run(c.id, URL);
    e.runner.wake(c.id, { kind: 'work', kick: 'go' });
    await idle(c.id);
    const results = e.kanban.messages(c.id).flatMap((m) => m.content.flatMap((b) => (b.type === 'tool_result' ? [b] : [])));
    expect(results[0]).toMatchObject({ is_error: true, content: expect.stringContaining('PR #41 still open') });
    expect(results[1]).toMatchObject({ is_error: true });
    expect(results[2]!.content).toContain('in review: PR #41');
    expect(e.kanban.get(c.id)).toMatchObject({ status: 'review', reviewer: 'zurich', prs: [{ number: 41, repo: 'csoylu/atlas', url: URL }] });
    expect(e.notifications.inbox().needsYou).toEqual([]);
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'card.review'").get()).toEqual({ n: 0 });
    // CI still running: the Review run waits on it, the card says where.
    await atStep(e, c.id, 'ci');
    await e.prs.poll();
    expect(gh.reads.length).toBeGreaterThan(0);
    expect(e.kanban.get(c.id)).toMatchObject({ status: 'review', waiting: expect.stringMatching(/^Review run 1 · CI finished on the PR: waiting until /), prs: [{ ci: 'pending', headSha: HEAD, branch: 'feat/170-x' }] });
    expect(e.runner.runs(c.id).filter((r) => r.agentId === 'zurich')).toEqual([]);
    // The project's Review workflow reviews one PR per task (#263).
    e.kanban.update(c.id, { status: 'running' }, 'user');
    expect(() => e.kanban.requestReview(c.id, ['https://github.com/csoylu/atlas/pull/42'], 'atlas', 'two')).toThrow(/one pull request per task in project Atlas/);
  });

  it('the full path: CI green → the review agent in the same thread → validated + merged by the workflow → Done', async () => {
    const gh = fakeGitHub();
    const { e, idle } = await setup({ gh, script: [verdict('ok', 'tests and build checked'), text('validated')] });
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    await atStep(e, c.id, 'ci');
    gh.pr.ci = 'success';
    await e.prs.poll();
    const run = await ended(e, c.id);
    await idle(c.id);
    expect(run.state).toBe('done');
    expect(path(run)).toEqual(FULL);
    // The reviewer's run was in the task's own thread, told what to check and how.
    expect(e.runner.runs(c.id).map((r) => r.agentId)).toEqual(['zurich']);
    expect(JSON.stringify(e.kanban.messages(c.id))).toContain(`You review the pull request of this task: ${URL} (branch feat/170-x, head ${HEAD})`);
    expect(run.steps!.find((s) => s.nodeId === 'review')!.summary).toContain('tests and build checked');
    // The gate ran on the head for the reviewer's validation, then the workflow's validation + merge pinned to the sha.
    expect(gh.calls.filter((x) => x.includes(`/statuses/${HEAD}`)).length).toBeGreaterThanOrEqual(2);
    expect(gh.merges()).toEqual([expect.stringContaining(`sha=${HEAD}`)]);
    expect(e.kanban.get(c.id).status).toBe('done');
    // GitHub's next read changes nothing: no second run, no second move.
    await e.prs.poll();
    expect(e.kanban.get(c.id).status).toBe('done');
    expect(e.runner.runs(c.id)).toHaveLength(1);
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM workflow_runs WHERE subject_card = ?').get(c.id)).toEqual({ n: 1 });
  });

  it('three tasks In review with green CI each get their reviewer run at once: no queue, none waits for another (#249)', async () => {
    const gh = fakeGitHub();
    const { e, idle } = await setup({ gh, script: [text('checking'), text('checking'), text('checking'), text('checking'), text('checking'), text('checking')] });
    e.agents.update('zurich', { maxRuns: 3 });
    const cards = [41, 42, 43].map((n) => {
      const c = card(e);
      e.kanban.requestReview(c.id, [`https://github.com/csoylu/atlas/pull/${n}`], 'atlas', `PR ${n}`);
      return c;
    });
    for (const c of cards) await atStep(e, c.id, 'ci');
    gh.pr.ci = 'success';
    await e.prs.poll();
    for (const c of cards) await eventually(() => e.runner.runs(c.id).some((r) => r.agentId === 'zurich'), { what: `the review of ${c.id}` });
    for (const c of cards) expect(e.kanban.get(c.id).waiting ?? '').not.toMatch(/queue/);
    for (const c of cards) await idle(c.id);
    // Nothing left of #236 in the store.
    const cols = (t: string) => (e.db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('cards')).not.toContain('review_queued_at');
    expect(cols('card_prs')).not.toContain('synced_sha');
  });

  it('each negative exit sends it back to the builder (Ready) with the reason as a note: CI red, conflict, timed out, changes asked, refused', { timeout: 20_000 }, async () => {
    const gh = fakeGitHub();
    const { e, idle } = await setup({
      gh,
      // Each send-back wakes the builder (Ready): its turns are « fixing ».
      script: byAgent([
        verdict('fail', 'the limit has no test', { sha: 'eeeeeee1111' }),
        text('changes asked'),
        verdict('ok', 'looks right'),
        // A push lands after the review, before the merge: the gate refuses (the review saw another commit).
        () => ((gh.restHead = 'fffffff9999'), text('validated')),
      ]),
    });
    const c = card(e);
    const again = async (sha: string) => {
      if (e.kanban.get(c.id).status !== 'running') e.kanban.update(c.id, { status: 'running' }, 'user');
      gh.pr = { ...gh.pr, headSha: sha, ci: 'pending', mergeable: true, qa: null, ciFailed: null };
      gh.restHead = null;
      mark = (e.db.prepare('SELECT MAX(id) AS m FROM card_events').get() as { m: number }).m;
      e.kanban.requestReview(c.id, [URL], 'atlas', 'fixed');
      await atStep(e, c.id, 'ci');
    };
    let mark = 0;
    const back = async (what: string) => {
      const r = await ended(e, c.id, what);
      // Ready: the builder's run starts at once (the script's « fixing » turns).
      await eventually(() => e.db.prepare("SELECT 1 FROM card_events WHERE card_id = ? AND kind = 'status' AND payload LIKE '%\"from\":\"review\",\"to\":\"ready\"%' AND id > ?").get(c.id, mark), { what: `${what}: back to Ready` });
      await idle(c.id);
      expect(r.steps!.at(-1)).toMatchObject({ nodeId: 'back', exit: 'done' });
      return r;
    };

    // CI red: the note names the check and links its log (#238).
    await again('bbbbbbb1111');
    gh.pr = { ...gh.pr, ci: 'failure', ciFailed: { name: 'test', url: 'https://github.com/csoylu/atlas/actions/runs/9/job/1' } };
    await e.prs.poll();
    expect(path(await back('CI red'))).toEqual([['trigger', 'start'], ['ci', 'event'], ['checks', 'no'], ['back', 'done']]);
    expect(lastNote(e, c.id)).toContain('CI green, no conflict?: no (pr.ci = « failure » ✗');
    expect(lastNote(e, c.id)).toContain('failing check: test (https://github.com/csoylu/atlas/actions/runs/9/job/1)');
    expect(lastNote(e, c.id)).toContain('Back to Ready for @atlas: fix it, push, then task_request_review again.');
    expect(e.notifications.inbox().needsYou).toEqual([]);

    // A conflict: GitHub runs no CI on it, the wait ends at once.
    await again('ccccccc1111');
    gh.pr = { ...gh.pr, mergeable: false };
    await e.prs.poll();
    expect(path(await back('conflict'))).toEqual([['trigger', 'start'], ['ci', 'event'], ['checks', 'no'], ['back', 'done']]);
    expect(lastNote(e, c.id)).toContain('pr.conflict = « yes » ✗');

    // CI never finishes in 2 h: timed out (the stored deadline moved to the past).
    await again('ddddddd1111');
    await e.prs.poll();
    e.db.prepare("UPDATE workflow_run_steps SET deadline_at = '2000-01-01T00:00:00.000Z' WHERE run_id = ? AND node_id = 'ci'").run(lastRun(e, c.id)!.id);
    e.workflows.tick();
    expect(path(await back('timed out'))).toEqual([['trigger', 'start'], ['ci', 'timed out'], ['back', 'done']]);
    expect(lastNote(e, c.id)).toContain('CI finished on the PR: timed out');

    // Changes asked: the reviewer's reason, in its words.
    await again('eeeeeee1111');
    gh.pr = { ...gh.pr, ci: 'success' };
    await e.prs.poll();
    expect(path(await back('changes asked'))).toEqual([['trigger', 'start'], ['ci', 'event'], ['checks', 'yes'], ['review', 'changes asked'], ['back', 'done']]);
    expect(lastNote(e, c.id)).toContain('Review the PR: changes asked (');
    expect(lastNote(e, c.id)).toContain('the limit has no test');
    await idle(c.id);

    // Refused at the merge: a commit pushed after the review.
    await again(HEAD);
    gh.pr = { ...gh.pr, ci: 'success' };
    await e.prs.poll();
    expect(path(await back('refused'))).toEqual([['trigger', 'start'], ['ci', 'event'], ['checks', 'yes'], ['review', 'approved'], ['merge', 'refused'], ['back', 'done']]);
    expect(lastNote(e, c.id)).toContain('Validate + merge the PR: refused (');
    expect(gh.merges()).toEqual([]);
    await idle(c.id);
  });

  it("the reviewer rule: the project's review agent; on its own PR, the project's lead; unset, the step says where to choose one", async () => {
    const gh = fakeGitHub();
    gh.pr.ci = 'success';
    const { e, idle } = await setup({ gh, script: [text('lead looks'), text('lead looks again')] });
    expect(e.projects.get('atlas')).toMatchObject({ lead: 'atlas', reviewAgent: 'zurich' });
    // zurich built it: the lead reviews.
    const own = card(e, 'zurich');
    expect(e.kanban.requestReview(own.id, [URL], 'zurich', 'e2e').reviewer).toBe('atlas');
    await e.prs.poll();
    await eventually(() => e.runner.runs(own.id).some((r) => r.agentId === 'atlas'), { what: "the lead's review" });
    expect(e.runner.runs(own.id).map((r) => r.agentId)).not.toContain('zurich');
    await idle(own.id);
    await eventually(() => e.runner.runs(own.id).length === 2, { what: 'the second try (#221)' });
    await idle(own.id);
    e.workflows.stopRun(lastRun(e, own.id)!.id);
    // No review agent: the step couldn't run and says where to choose one; the task says it too.
    e.projects.update('atlas', { reviewAgent: null });
    const c = card(e);
    e.kanban.requestReview(c.id, ['https://github.com/csoylu/atlas/pull/42'], 'atlas', 'x');
    await e.prs.poll();
    const step = await eventually(() => lastRun(e, c.id)?.steps?.find((s) => s.nodeId === 'review' && s.couldntRun) ?? null, { what: 'the review step stuck' });
    expect(step.couldntRun).toMatchObject({ reason: 'project Atlas has no review agent: choose one in Settings → Projects → Atlas' });
    expect(e.kanban.get(c.id).waiting).toContain("couldn't run « Review the PR »: project Atlas has no review agent");
    // A review agent must be a member (it reviews in its workspace of the project).
    expect(() => e.projects.update('atlas', { reviewAgent: 'nobody' })).toThrow(/not a member/);
  });

  it('GitHub unreadable: nothing moves, the card says why; one Inbox item after 15 min; merged meanwhile → Done when it reads again', async () => {
    const { e, gh } = await setup();
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    await atStep(e, c.id, 'ci');
    await e.prs.poll(); // one good read
    gh.down = 'gh: not logged in';
    gh.pr = { ...gh.pr, state: 'merged', mergeSha: 'e96a8e2ffff' }; // merged from a terminal, we can't see it
    await e.prs.poll();
    const now = e.kanban.get(c.id);
    expect(now.status).toBe('review');
    expect(now.prs[0]).toMatchObject({ error: 'gh: not logged in', state: 'open' });
    expect(now.waiting).toMatch(/^can't read PR #41 from GitHub since \d\d:\d\d: gh: not logged in$/);
    expect(e.notifications.inbox().updates).toEqual([]);

    clock.now += UNREADABLE_NOTIFY_MS + 1000;
    await e.prs.poll();
    await e.prs.poll();
    expect(e.notifications.inbox().updates).toMatchObject([{ kind: 'github.unreadable', title: "Atlas can't read GitHub: gh: not logged in", cardId: c.id }]);

    // Readable again: the waiting Review run stops (merged outside it), then GitHub's merge moves the task.
    gh.down = null;
    await e.prs.poll();
    await eventually(() => e.kanban.get(c.id).status === 'done', { what: 'Done from the merge' });
    expect(lastRun(e, c.id)).toMatchObject({ state: 'stopped', reason: expect.stringContaining('PR #41 was merged on GitHub outside the workflow') });
    expect(e.db.prepare("SELECT payload FROM card_events WHERE card_id = ? AND kind = 'completed'").get(c.id)).toEqual({
      payload: JSON.stringify({ by: 'github', summary: 'PR #41 merged into main (e96a8e2)' }),
    });
    expect(e.notifications.inbox().updates.map((u) => u.kind)).toEqual(['card.done']);
  });

  it('a task blocked on the user whose PR merges goes to Done by itself and leaves « Needs you » (#231)', async () => {
    const { e, gh } = await setup();
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    await atStep(e, c.id, 'ci');
    await e.prs.poll();
    // The reviewer can't validate and asks the user (the #226 case): blocked, the PR still open.
    e.kanban.block(c.id, { kind: 'needs_input', reason: 'pr_validate refuses the PR: merge it with the script?' }, 'zurich');
    await e.prs.poll();
    expect(e.kanban.get(c.id).status).toBe('blocked');
    expect(e.notifications.inbox().needsYou.map((n) => n.card.id)).toEqual([c.id]);
    // Merged outside the flow (validate.mjs --merge from a terminal): no decision is left.
    gh.pr = { ...gh.pr, state: 'merged', mergeSha: 'a44628dffff' };
    await e.prs.poll();
    await eventually(() => e.kanban.get(c.id).status === 'done', { what: 'Done from the merge' });
    expect(e.kanban.get(c.id)).toMatchObject({ status: 'done', block: null });
    expect(e.notifications.inbox().needsYou).toEqual([]);
    expect(e.notifications.inbox().updates).toMatchObject([{ kind: 'card.done', cardId: c.id, body: 'PR #41 merged into main (a44628d)' }]);
    expect(e.runner.runs(c.id)).toEqual([]); // moved from GitHub, no agent run
  });

  it('a PR closed without merging: the Review run stops, the task goes back to Ready with the reason', async () => {
    const { e, gh } = await setup();
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'x');
    await atStep(e, c.id, 'ci');
    gh.pr = { ...gh.pr, state: 'closed' };
    await e.prs.poll();
    await eventually(() => e.kanban.get(c.id).status === 'ready', { what: 'back to Ready' });
    expect(lastRun(e, c.id)).toMatchObject({ state: 'stopped', reason: expect.stringContaining('PR #41 was closed on GitHub outside the workflow') });
    expect(lastNote(e, c.id)).toContain('PR #41 was closed without merging. Back to Ready for @atlas');
  });

  it('the task leaves In review (Master moves it): its Review run stops and never acts on it again', async () => {
    const { e, gh } = await setup();
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'x');
    await atStep(e, c.id, 'ci');
    e.kanban.update(c.id, { status: 'ready' }, 'user');
    await eventually(() => lastRun(e, c.id)?.state === 'stopped', { what: 'the run stopped' });
    expect(lastRun(e, c.id)!.reason).toContain('left In review (now ready)');
    gh.pr.ci = 'failure';
    await e.prs.poll();
    expect(e.kanban.get(c.id).status).toBe('ready');
    expect(notes(e, c.id)).toEqual([]);
  });

  it('a review run that ends without a verdict is started once more, told why, then waits for Master; Retry starts it again (#221)', async () => {
    const gh = fakeGitHub();
    const { e, idle } = await setup({ gh, script: [text('one'), text('two'), text('three'), verdict('ok', 'ok now'), text('validated')] });
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'x');
    await atStep(e, c.id, 'ci');
    gh.pr.ci = 'success';
    await e.prs.poll();
    // Run 1 ends with no verdict: run 2 at once, told why; run 2 too: the step couldn't run, Master is told once.
    const step = await eventually(() => lastRun(e, c.id)?.steps?.find((s) => s.nodeId === 'review' && s.couldntRun) ?? null, { timeout: 10_000, what: 'the review step stuck' });
    await idle(c.id);
    expect(e.runner.runs(c.id).filter((r) => r.agentId === 'zurich')).toHaveLength(2);
    const kicks = e.kanban.messages(c.id).filter((m) => m.author === 'system').map((m) => JSON.stringify(m.content));
    expect(kicks).toHaveLength(2);
    expect(kicks[0]).not.toContain('ended without a verdict');
    expect(kicks[1]).toContain('Your last review run of this head ended without a verdict');
    expect(step.couldntRun!.reason).toContain('without a verdict');
    expect(e.kanban.get(c.id).waiting).toContain("couldn't run « Review the PR »");
    // The run owns it: no second stall mark on the task (#237).
    e.stalls.check();
    expect(e.kanban.get(c.id).stall).toBe(null);
    // Retry (the task's button): the reviewer again; still no verdict.
    await e.dispatcher.retry(c.id);
    await eventually(() => e.runner.runs(c.id).length === 3, { what: 'a third reviewer run' });
    await idle(c.id);
    await eventually(() => lastRun(e, c.id)?.steps?.find((s) => s.nodeId === 'review')?.couldntRun ?? null, { what: 'stuck again' });
    // Retry again: this time a verdict, merged, Done.
    await e.dispatcher.retry(c.id);
    const run = await ended(e, c.id);
    expect(path(run).slice(-3)).toEqual([['review', 'approved'], ['merge', 'merged'], ['done', 'done']]);
    expect(e.kanban.get(c.id).status).toBe('done');
    await idle(c.id);
  });

  it("the reviewer's model sees the builder's turns as the builder's, not as its own (#221)", async () => {
    const gh = fakeGitHub();
    let seen: ModelRequest | null = null;
    const { e, idle } = await setup({
      gh,
      script: [use('task_list', {}), use('task_request_review', { summary: 'engine + tests', prs: [URL] }), (req: ModelRequest) => ((seen = req), text('looking')), text('looking again')],
    });
    const c = card(e);
    e.kanban.update(c.id, { status: 'running' }, 'dispatcher');
    e.runner.wake(c.id, { kind: 'work', kick: 'go' });
    await idle(c.id);
    expect(e.kanban.get(c.id).status).toBe('review');
    await atStep(e, c.id, 'ci');
    gh.pr.ci = 'success';
    await e.prs.poll();
    await eventually(() => seen, { what: "the reviewer's model call" });
    await idle(c.id);
    await eventually(() => e.runner.runs(c.id).filter((r) => r.agentId === 'zurich').length === 2, { what: 'the second try (#221)' });
    await idle(c.id);
    const req = seen as unknown as ModelRequest;
    // No assistant turn: zurich hasn't spoken yet; atlas's turns are context, named.
    expect(req.messages.map((m) => m.role)).toEqual(['user']);
    const all = JSON.stringify(req.messages);
    expect(all).toContain('[@atlas, another agent, wrote this in the thread (not you):]');
    expect(all).toContain('→ task_request_review');
    expect(all).not.toContain('"tool_use"');
    expect(all).toContain('the earlier messages marked @atlas are theirs, not yours');
  });
});

describe('a restart in every state of a review (#263, rule 2)', () => {
  it('resumes the Review run from the store: no second reviewer run, no lost send-back, a merge while down → Done', { timeout: 30_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-prs-'));
    const dbFile = join(dataDir, 'atlas.db');
    const gh = fakeGitHub();
    let t = await setup({ dbFile, dataDir, gh, script: byAgent([]) });
    const c = card(t.e);
    t.e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    await atStep(t.e, c.id, 'ci');
    const before = lastRun(t.e, c.id)!;
    await t.e.stop();

    // Waiting on CI across the restart: the same run goes on when CI finishes, the reviewer runs once.
    gh.pr.ci = 'success';
    t = await setup({ dbFile, dataDir, gh, script: byAgent([verdict('fail', 'tests red'), text('changes asked')]) });
    expect(t.e.kanban.get(c.id)).toMatchObject({ status: 'review', reviewer: 'zurich' });
    await t.e.prs.poll();
    const r = await ended(t.e, c.id);
    expect(r.id).toBe(before.id);
    expect(path(r).at(-2)).toEqual(['review', 'changes asked']);
    expect(t.e.runner.runs(c.id).filter((x) => x.agentId === 'zurich')).toHaveLength(1);
    await eventually(() => t.e.kanban.get(c.id).status !== 'review', { what: 'sent back' });
    await t.idle(c.id);
    await t.e.stop();
    t = await setup({ dbFile, dataDir, gh, script: byAgent([]) });
    await t.e.prs.poll();
    expect(notes(t.e, c.id).filter((m) => JSON.stringify(m.content).includes('Back to Ready'))).toEqual([expect.objectContaining({ content: [expect.objectContaining({ text: expect.stringContaining('tests red') })] })]);

    // Back in review, merged while the engine was down: the run stops, Done at the first poll after the restart.
    if (t.e.kanban.get(c.id).status !== 'running') t.e.kanban.update(c.id, { status: 'running' }, 'user');
    gh.pr.ci = 'pending';
    t.e.kanban.requestReview(c.id, [URL], 'atlas', 'fixed');
    await atStep(t.e, c.id, 'ci');
    await t.e.stop();
    gh.pr = { ...gh.pr, headSha: 'ddddddd4444', state: 'merged', mergeSha: 'fffffff0000' };
    t = await setup({ dbFile, dataDir, gh, script: byAgent([]) });
    await t.e.prs.poll();
    await eventually(() => t.e.kanban.get(c.id).status === 'done', { what: 'Done from the merge' });
  });
});

describe('a review step always ends (#325)', () => {
  const reviewStep = (e: E, cardId: string) => lastRun(e, cardId)!.steps!.find((s) => s.nodeId === 'review')!;

  it("the #314 sequence: the reviewer's run is cut by a restart, resumed as a new run, its fail verdict sends the task back", { timeout: 30_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-325-'));
    const dbFile = join(dataDir, 'atlas.db');
    const gh = fakeGitHub();
    // The reviewer is in the middle of a long command when Atlas quits (an update).
    let t = await setup({ dbFile, dataDir, gh, script: byAgent([use('shell', { command: 'sleep 30' })]) });
    const c = card(t.e);
    t.e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    await atStep(t.e, c.id, 'ci');
    gh.pr.ci = 'success';
    await t.e.prs.poll();
    await atStep(t.e, c.id, 'review');
    await eventually(() => t.e.db.prepare("SELECT 1 FROM tool_calls WHERE status = 'running'").get(), { what: "the reviewer's command running" });
    await t.e.stop();

    // Next start: the runner resumes the review as a new run, which gives the verdict with pr_validate.
    t = await setup({ dbFile, dataDir, gh, script: byAgent([verdict('fail', 'four points to fix'), text('changes asked')]) });
    const run = await ended(t.e, c.id);
    expect(path(run).slice(-2)).toEqual([['review', 'changes asked'], ['back', 'done']]);
    expect(reviewStep(t.e, c.id).summary).toBe('@zurich on PR #41: four points to fix');
    expect(t.e.kanban.get(c.id).status).not.toBe('review');
    expect(lastNote(t.e, c.id)).toContain('four points to fix');
    // One resumed run, no extra review run.
    expect(t.e.runner.runs(c.id).filter((r) => r.agentId === 'zurich').map((r) => r.status).sort()).toEqual(['done', 'interrupted']);
  });

  it('an interrupted review run that never resumes reaches Master once; Retry on the task wakes the reviewer again', { timeout: 30_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-325-'));
    const dbFile = join(dataDir, 'atlas.db');
    const gh = fakeGitHub();
    let t = await setup({ dbFile, dataDir, gh, script: byAgent([use('shell', { command: 'sleep 30' })]) });
    const c = card(t.e);
    t.e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    await atStep(t.e, c.id, 'ci');
    gh.pr.ci = 'success';
    await t.e.prs.poll();
    await atStep(t.e, c.id, 'review');
    await eventually(() => t.e.db.prepare("SELECT 1 FROM tool_calls WHERE status = 'running'").get(), { what: "the reviewer's command running" });
    await t.e.stop();
    // The run stays interrupted (no resume: as if the runner could not wake it), the step can't follow it.
    const db = new Database(dbFile);
    db.prepare("UPDATE runs SET status = 'stopped' WHERE status = 'interrupted'").run();
    db.close();
    const at = { now: Date.now() };
    t = await setup({ dbFile, dataDir, gh, script: byAgent([verdict('ok', 'all checked'), text('approved')]), review: false });
    t.e.db.prepare("UPDATE runs SET status = 'interrupted' WHERE agent_id = 'zurich'").run();
    (t.e.workflows as unknown as { now: () => Date }).now = () => new Date(at.now);
    t.e.workflows.start(3_600_000);
    t.e.workflows.tick();
    expect(reviewStep(t.e, c.id).couldntRun).toBe(null);
    at.now += 16 * 60_000;
    t.e.workflows.tick();
    expect(reviewStep(t.e, c.id).couldntRun).toMatchObject({ reason: expect.stringContaining('interrupted by a restart and has not resumed for 16 min'), autoRetry: false, notified: true });
    expect(inbox(t.e, 'workflow.couldnt_run')).toEqual([expect.objectContaining({ title: 'Workflow « Review » is stuck on « Review the PR »', card_id: c.id })]);
    t.e.workflows.tick();
    expect(inbox(t.e, 'workflow.couldnt_run')).toHaveLength(1);
    // Retry on the task (Master's click): the reviewer is woken again in the thread and its verdict moves the run.
    await t.call('POST', `/cards/${c.id}/retry`);
    const run = await ended(t.e, c.id);
    expect(path(run).slice(-3)).toEqual([['review', 'approved'], ['merge', 'merged'], ['done', 'done']]);
  });

  it('the builder pushes a fix during the review and asks again: the open run stops, a new one reviews the new head', { timeout: 30_000 }, async () => {
    const gh = fakeGitHub();
    let e!: E;
    let cardId = '';
    const NEW = 'bbbbbbb2222';
    const { e: engine, idle } = await setup({
      gh,
      script: byAgent([
        () => {
          // Mid-review, the builder pushes and asks again (its own run in the thread would do the same).
          gh.pr.headSha = NEW;
          expect(() => e.kanban.requestReview(cardId, [URL], 'zurich', 'me again')).toThrow(/only its builder @atlas asks again: you are its reviewer, give your verdict with pr_validate/);
          e.kanban.requestReview(cardId, [URL], 'atlas', 'fixed the four points');
          return text('still reading');
        },
        verdict('ok', 'new head checked', { sha: NEW }),
        text('approved'),
      ]),
    });
    e = engine;
    const c = card(e);
    cardId = c.id;
    e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    await atStep(e, c.id, 'ci');
    gh.pr.ci = 'success';
    await e.prs.poll();
    const runs = () => e.db.prepare('SELECT id, state, reason FROM workflow_runs WHERE subject_card = ? ORDER BY number').all(c.id) as { id: string; state: string; reason: string | null }[];
    await eventually(() => runs().length === 2, { what: 'a second Review run' });
    expect(runs()[0]).toMatchObject({ state: 'stopped', reason: 'stopped by a new review request from @atlas (a new head needs a new review)' });
    await idle(c.id);
    await e.prs.poll();
    const run = await ended(e, c.id);
    expect(run.id).toBe(runs()[1]!.id);
    expect(path(run)).toEqual(FULL);
    expect(gh.merges()).toEqual([expect.stringContaining(`sha=${NEW}`)]);
    expect(e.kanban.get(c.id).status).toBe('done');
  });

  it('a commit pushed after an ok verdict is not merged: the merge pins the reviewed head, refused, back to the builder', { timeout: 20_000 }, async () => {
    const gh = fakeGitHub();
    let e!: E;
    const { e: engine } = await setup({
      gh,
      script: byAgent([
        verdict('ok', 'tests and build checked'),
        () => {
          // A push lands between the verdict and the merge step: Atlas has already read the new head.
          gh.pr.headSha = gh.restHead = 'ccccccc3333';
          e.db.prepare('UPDATE card_prs SET head_sha = ?').run('ccccccc3333');
          return text('validated');
        },
      ]),
    });
    e = engine;
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'engine + tests');
    await atStep(e, c.id, 'ci');
    gh.pr.ci = 'success';
    await e.prs.poll();
    const run = await ended(e, c.id);
    expect(path(run).slice(-3)).toEqual([['review', 'approved'], ['merge', 'refused'], ['back', 'done']]);
    expect(run.steps!.find((s) => s.nodeId === 'merge')!.summary).toContain('a commit was pushed after your review');
    expect(gh.merges()).toEqual([]);
    expect(e.kanban.get(c.id).status).not.toBe('review');
  });
});

describe('pull requests of another project (#216): Datinel, no CI job', () => {
  const DURL = 'https://github.com/datinel/datinel/pull/7';
  const datinel = (e: E, members = ['munih', 'zurich']) => {
    const p = e.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'munih', members });
    if (members.includes('zurich')) setReviewAgent(e, p.id, 'zurich');
    return p;
  };
  const dcard = (e: E) => e.kanban.create({ title: 'Feed', status: 'running', assignee: 'munih', projectId: 'datinel' }, 'user');

  it('task_request_review refuses a PR of another repo than the project’s, and a project without a repo', async () => {
    const { e } = await setup();
    datinel(e);
    const d = dcard(e);
    expect(() => e.kanban.requestReview(d.id, [URL], 'munih', 'x')).toThrow(/https:\/\/github\.com\/csoylu\/atlas\/pull\/41 is not in datinel\/datinel, the repo of project Datinel/);
    const a = card(e);
    e.kanban.update(a.id, { status: 'running' }, 'dispatcher');
    expect(() => e.kanban.requestReview(a.id, [DURL], 'atlas', 'x')).toThrow(/is not in csoylu\/atlas, the repo of project Atlas/);
    const none = e.projects.create({ name: 'Notes', lead: 'munih' });
    const n = e.kanban.create({ title: 'n', status: 'running', assignee: 'munih', projectId: none.id }, 'user');
    expect(() => e.kanban.requestReview(n.id, [DURL], 'munih', 'x')).toThrow(/project Notes has no GitHub repo/);
    expect(e.kanban.get(d.id)).toMatchObject({ status: 'running', prs: [] });
    // A project without a repo has no Review workflow; Datinel got its own when it got its repo.
    await eventually(() => reviewWorkflowOf(e.db, 'datinel'), { what: "Datinel's Review workflow" });
    expect(reviewWorkflowOf(e.db, none.id)).toBe(null);
  });

  it("its own Review workflow, read from its repo; a PR with no check at all goes straight on (no CI job, atlas's point 1)", async () => {
    const gh = fakeGitHub('datinel/datinel');
    gh.pr.ci = null; // no check run on the head, ever
    const { e, idle } = await setup({ gh, script: byAgent([verdict('ok', 'feed checked', { pr: 7 }), text('validated')]) });
    datinel(e);
    await eventually(() => reviewWorkflowOf(e.db, 'datinel'), { what: "Datinel's Review workflow" });
    const d = dcard(e);
    e.kanban.requestReview(d.id, [DURL], 'munih', 'feed + tests');
    expect(e.kanban.get(d.id)).toMatchObject({ status: 'review', reviewer: 'zurich', prs: [{ repo: 'datinel/datinel', number: 7, url: DURL }] });
    await e.prs.poll();
    const run = await ended(e, d.id);
    await idle(d.id);
    expect(run.workflowId).toBe(reviewWorkflowOf(e.db, 'datinel')!.id);
    expect(path(run)).toEqual(FULL);
    expect(run.steps!.find((s) => s.nodeId === 'ci')!.summary).toMatch(/^no CI check on PR #7 on aaaaaaa and project Datinel requires none/);
    expect(gh.reads.every((r) => r === 'datinel/datinel#7')).toBe(true);
    expect(gh.merges()).toHaveLength(1);
    expect(e.kanban.get(d.id).status).toBe('done');
  });

  it('a red CI or a conflict send it back to Ready with the reason', async () => {
    const gh = fakeGitHub('datinel/datinel');
    const { e, idle } = await setup({ gh, script: byAgent([]) });
    datinel(e);
    await eventually(() => reviewWorkflowOf(e.db, 'datinel'), { what: "Datinel's Review workflow" });
    const d = dcard(e);
    e.kanban.requestReview(d.id, [DURL], 'munih', 'x');
    await atStep(e, d.id, 'ci');
    gh.pr = { ...gh.pr, headSha: 'bbbbbbb2222', ci: 'failure' };
    await e.prs.poll();
    await ended(e, d.id);
    await eventually(() => e.kanban.get(d.id).status !== 'review', { what: 'sent back' });
    expect(lastNote(e, d.id)).toContain('pr.ci = « failure » ✗');
    await idle(d.id);
    const first = lastRun(e, d.id)!.id;
    if (e.kanban.get(d.id).status !== 'running') e.kanban.update(d.id, { status: 'running' }, 'user');
    gh.pr = { ...gh.pr, headSha: 'ccccccc3333', ci: 'success', mergeable: false };
    e.kanban.requestReview(d.id, [DURL], 'munih', 'fixed');
    await eventually(() => lastRun(e, d.id)?.id !== first, { what: 'a second Review run' });
    await e.prs.poll();
    await ended(e, d.id);
    expect(lastNote(e, d.id)).toContain('pr.conflict = « yes » ✗');
    await idle(d.id);
  });

  it('no review agent in the project: the review step says where to choose one; a non-member can never be chosen', async () => {
    const gh = fakeGitHub('datinel/datinel');
    gh.pr.ci = 'success';
    const { e } = await setup({ gh });
    datinel(e, ['munih']);
    expect(() => e.projects.update('datinel', { reviewAgent: 'zurich' })).toThrow(/review agent @zurich is not a member of Datinel/);
    await eventually(() => reviewWorkflowOf(e.db, 'datinel'), { what: "Datinel's Review workflow" });
    const d = dcard(e);
    e.kanban.requestReview(d.id, [DURL], 'munih', 'x');
    await e.prs.poll();
    await eventually(() => lastRun(e, d.id)?.steps?.find((s) => s.nodeId === 'review' && s.couldntRun) ?? null, { what: 'the review step stuck' });
    expect(e.runner.runs(d.id)).toEqual([]);
    expect(e.kanban.get(d.id).waiting).toContain('project Datinel has no review agent: choose one in Settings → Projects → Datinel');
  });
});
