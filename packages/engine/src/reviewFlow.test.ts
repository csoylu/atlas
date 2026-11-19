import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventually } from '../test/kit/index.ts';
import { HEAD, URL, atStep, byAgent, card, ended, fakeGitHub, inbox, lastRun, path, setupReview as setup, startReview, text, verdict, type E } from '../test/reviewKit.ts';
import { AT_UPDATE, REVIEW_LOOP_GUARD, TURNED_ON, reviewGraph, reviewWorkflowOf } from './reviewFlow.ts';
import { validate } from '../../../scripts/pr/validate.mjs';

/**
 * The default Review workflow's life (#263): seeded per project with a repo (the update and a new project), the
 * switch-over of tasks already In review, « Reset to default », the « No Review workflow is on » state (off, deleted,
 * loop guard) with Turn it on, and the ways out that never need a run (Validate by hand, validate.mjs --as master).
 * The path itself and its negative exits: prs.test.ts.
 */

const reviewOf = (e: E, projectId = 'atlas') => {
  const w = reviewWorkflowOf(e.db, projectId);
  return w ? e.workflows.get(w.id) : null;
};
const layout = (e: E, id: string) => e.workflows.get(id).nodes.map((n) => [n.id, n.kind, n.x, n.y]);

describe('the default Review workflow (#263)', () => {
  it('every project with a repo gets one at the update, on, « default », with the approved steps and layout; once only', async () => {
    const { e } = await setup({ review: false });
    expect(reviewOf(e)).toBe(null);
    const notes = e.projects.create({ name: 'Notes', lead: 'atlas' });
    startReview(e);
    const w = reviewOf(e)!;
    expect(w).toMatchObject({ name: 'Review', enabled: true, origin: 'review', projectId: 'atlas' });
    // Seven steps in three columns, « Back to the builder » alone on the bottom row.
    expect(layout(e, w.id)).toEqual([
      ['trigger', 'trigger', 40, 80],
      ['ci', 'wait', 272, 80],
      ['checks', 'condition', 504, 80],
      ['review', 'agent', 40, 288],
      ['merge', 'action', 272, 288],
      ['done', 'action', 504, 288],
      ['back', 'action', 40, 496],
    ]);
    expect(w.edges).toEqual(reviewGraph().edges);
    expect(w.nodes.find((n) => n.id === 'trigger')!.config).toMatchObject({ kind: 'task', event: 'review_requested', maxRunsPerHour: REVIEW_LOOP_GUARD });
    expect(w.nodes.find((n) => n.id === 'ci')!.config).toMatchObject({ for: 'ciFinished', limitMin: 120 });
    // No repo, no Review workflow; a second start makes no second one.
    expect(reviewOf(e, notes.id)).toBe(null);
    e.reviewFlow.seed();
    expect(e.workflows.list().filter((x) => x.origin === 'review')).toHaveLength(1);
    // A project that gets a repo gets its own.
    e.projects.update(notes.id, { repo: 'csoylu/notes' });
    await eventually(() => reviewOf(e, notes.id), { what: "Notes' Review workflow" });
    // Deleted by Master: not made again by itself.
    e.workflows.remove(reviewOf(e, notes.id)!.id);
    e.reviewFlow.seed();
    expect(reviewOf(e, notes.id)).toBe(null);
  });

  it('the switch-over: a task already In review at the update gets its Review run, which says so; then the normal path', async () => {
    const gh = fakeGitHub();
    const { e, idle } = await setup({ gh, review: false, script: byAgent([verdict('ok', 'checked'), text('validated')]) });
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'before the update');
    expect(lastRun(e, c.id)).toBe(null);
    startReview(e);
    const run = await atStep(e, c.id, 'ci');
    expect(run).toBeTruthy();
    expect(lastRun(e, c.id)!.steps![0]).toMatchObject({ nodeId: 'trigger', exit: 'start', summary: expect.stringContaining(AT_UPDATE) });
    gh.pr.ci = 'success';
    await e.prs.poll();
    expect(path(await ended(e, c.id)).at(-1)).toEqual(['done', 'done']);
    expect(e.kanban.get(c.id).status).toBe('done');
    await idle(c.id);
  });

  it('« Reset to default » brings back the seven steps, their links and the layout; only on a default Review', async () => {
    const { e } = await setup();
    const w = reviewOf(e)!;
    const edited = e.workflows.get(w.id);
    e.workflows.saveGraph(w.id, {
      revision: edited.revision,
      nodes: edited.nodes.filter((n) => n.id !== 'done').map((n) => ({ ...n, x: n.x + 100 })),
      edges: edited.edges.filter((x) => x.to !== 'done'),
    });
    expect(e.workflows.get(w.id).nodes).toHaveLength(6);
    e.workflows.update(w.id, { enabled: false });
    const back = e.workflows.resetReview(w.id);
    expect(layout(e, w.id)).toEqual(reviewGraph().nodes.map((n) => [n.id, n.kind, n.x, n.y]));
    expect(back.edges).toEqual(reviewGraph().edges);
    expect(back.enabled).toBe(false); // on/off stays as it was
    const other = e.workflows.create({ name: 'Mine', enabled: false, projectId: 'atlas', nodes: [{ id: 'trigger', kind: 'trigger', x: 0, y: 0, config: { kind: 'manual' } }], edges: [] }, 'user');
    expect(() => e.workflows.resetReview(other.id)).toThrow(/not a default Review workflow/);
  });

  it('Review off: the task says « No Review workflow is on », Master gets one Inbox item; Turn it on starts its run and archives it', async () => {
    const { e } = await setup();
    const w = reviewOf(e)!;
    e.workflows.update(w.id, { enabled: false });
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'x');
    await eventually(() => e.kanban.get(c.id).reviewOff, { what: 'the off state' });
    expect(e.kanban.get(c.id)).toMatchObject({ status: 'review', reviewOff: { projectId: 'atlas', projectName: 'Atlas', workflowId: w.id } });
    expect(e.kanban.get(c.id).waiting).toBe('No Review workflow is on in Atlas: Turn it on, or Validate by hand');
    await eventually(() => inbox(e, 'review.off').length === 1, { what: 'the Inbox item' });
    e.reviewFlow.check();
    e.reviewFlow.check();
    expect(inbox(e, 'review.off')).toEqual([expect.objectContaining({ title: 'No Review workflow is on in Atlas', card_id: c.id, archived_at: null })]);
    expect(lastRun(e, c.id)).toBe(null);
    // Retry can't start what is off: it says why.
    expect(() => e.reviewFlow.retry(c.id)).toThrow(/No Review workflow is on in Atlas: Turn it on, or Validate by hand/);

    e.reviewFlow.turnOn('atlas');
    await atStep(e, c.id, 'ci');
    expect(lastRun(e, c.id)!.steps![0]!.summary).toContain(TURNED_ON);
    expect(e.kanban.get(c.id).reviewOff).toBe(null);
    expect(inbox(e, 'review.off')[0]!.archived_at).not.toBe(null);
  });

  it('Review deleted: the same state; Turn it on makes it again from the default; turning it off stops nothing in flight', async () => {
    const { e } = await setup();
    const w = reviewOf(e)!;
    const a = card(e);
    e.kanban.requestReview(a.id, [URL], 'atlas', 'x');
    await atStep(e, a.id, 'ci');
    // Off while a run is going: that task keeps its run (not « off »).
    e.workflows.update(w.id, { enabled: false });
    e.reviewFlow.check();
    expect(e.kanban.get(a.id).reviewOff).toBe(null);
    e.workflows.update(w.id, { enabled: true });
    // Deleted: its runs stop; the task is in the off state, workflowId null.
    e.workflows.remove(w.id);
    await eventually(() => e.kanban.get(a.id).reviewOff, { what: 'the off state' });
    expect(e.kanban.get(a.id).reviewOff).toMatchObject({ workflowId: null });
    await eventually(() => inbox(e, 'review.off').length === 1, { what: 'the Inbox item' });
    expect(inbox(e, 'review.off')[0]!.body).toContain('it was deleted: Turn it on makes it again');
    const again = e.reviewFlow.turnOn('atlas');
    expect(again.id).not.toBe(w.id);
    expect(layout(e, again.id)).toEqual(reviewGraph().nodes.map((n) => [n.id, n.kind, n.x, n.y]));
    await atStep(e, a.id, 'ci');
    expect(lastRun(e, a.id)!.workflowId).toBe(again.id);
    // A project without a repo has nothing to turn on.
    const n = e.projects.create({ name: 'Notes', lead: 'atlas' });
    expect(() => e.reviewFlow.turnOn(n.id)).toThrow(/has no GitHub repo/);
  });

  it("the loop guard turns the project's review off, the Inbox says exactly that, and tasks In review show the off state (atlas 2)", async () => {
    const { e } = await setup();
    const w = reviewOf(e)!;
    const c = card(e);
    // Ten runs on this task in the last hour already.
    const at = new Date().toISOString();
    for (let i = 1; i <= REVIEW_LOOP_GUARD; i++)
      e.db
        .prepare("INSERT INTO workflow_runs (id, workflow_id, number, state, trigger, reason, started_at, ended_at, subject_card, event) VALUES (?, ?, ?, 'done', 'task', 'x', ?, ?, ?, 'review_requested')")
        .run(`wr_old${i}`, w.id, i, at, at, c.id);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'eleventh');
    await eventually(() => !e.workflows.get(w.id).enabled, { what: 'the loop guard' });
    expect(e.workflows.get(w.id).lastError).toMatch(/^loop guard: 10 runs on #\d+ in the last hour \(at most 10\)/);
    const stopped = e.db.prepare("SELECT title, body FROM notifications WHERE kind = 'workflow.stopped'").all() as { title: string; body: string }[];
    expect(stopped).toEqual([{ title: 'Review is off in Atlas: its loop guard turned the Review workflow off', body: expect.stringContaining('every task In review there shows « No Review workflow is on in Atlas »') }]);
    await eventually(() => e.kanban.get(c.id).reviewOff, { what: 'the off state' });
    expect(e.kanban.get(c.id).waiting).toContain('No Review workflow is on in Atlas');
  });

  it('a review agent removed from the project, or disabled: the review step can\'t run and says why; never another agent (atlas 3)', async () => {
    const gh = fakeGitHub();
    gh.pr.ci = 'success';
    const { e } = await setup({ gh });
    e.agents.update('zurich', { enabled: false });
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'x');
    await e.prs.poll();
    const step = await eventually(() => lastRun(e, c.id)?.steps?.find((s) => s.nodeId === 'review' && s.couldntRun) ?? null, { what: 'the review step stuck' });
    expect(step.couldntRun!.reason).toBe('review agent @zurich is disabled: turn it on, or choose another in Settings → Projects → Atlas');
    expect(e.runner.runs(c.id)).toEqual([]);
  });
});

describe('the ways out that need no Review run (#263, atlas 4 and 5)', () => {
  it('« Validate by hand »: the gate of validate.mjs --as master, at the head shown; only the HTTP route calls it, no agent tool', async () => {
    const gh = fakeGitHub();
    gh.pr.ci = 'success';
    const { e } = await setup({ gh });
    e.workflows.update(reviewOf(e)!.id, { enabled: false });
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'x');
    await e.prs.poll();
    await expect(e.reviewFlow.validateByHand(c.id, 'bbbbbbb')).rejects.toThrow(/head is aaaaaaa, not bbbbbbb: reload the task/);
    expect(gh.merges()).toEqual([]);
    const out = await e.reviewFlow.validateByHand(c.id, HEAD);
    expect(out.join('\n')).toMatch(/merged/i);
    expect(gh.calls.some((x) => x.includes(`statuses/${HEAD}`) && x.includes('master'))).toBe(true);
    await eventually(() => e.kanban.get(c.id).status === 'done', { what: 'Done from the merge' });
    await eventually(() => inbox(e, 'review.off').every((i) => i.archived_at), { what: 'the off item archived' });

    // Only api.ts calls it; the agents' tools and instructions never reach it.
    const src = import.meta.dirname;
    const callers = readdirSync(src)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /validateByHand\(|\/validate'/.test(readFileSync(join(src, f), 'utf8')));
    expect(callers.sort()).toEqual(['api.ts', 'reviewFlow.ts']);
    expect(readFileSync(join(src, 'reviewFlow.ts'), 'utf8').match(/validateByHand\(/g)).toHaveLength(1); // its definition
    expect(readFileSync(join(src, 'runner.ts'), 'utf8')).toContain('Never call « Validate by hand » (POST /api/cards/:id/validate)');
  });

  it("Master's terminal (validate.mjs --as master --merge) works with no Review run and with a stuck one; the task goes Done", async () => {
    const gh = fakeGitHub();
    const { e } = await setup({ gh, script: byAgent([text('no verdict'), text('still none')]) });
    const gate = { verdict: 'success' as const, sha: HEAD, as: 'master', reason: 'by hand', merge: true, base: null, repo: 'csoylu/atlas', ciJob: 'test' };

    // No run: Review off.
    e.workflows.update(reviewOf(e)!.id, { enabled: false });
    const a = card(e);
    e.kanban.requestReview(a.id, [URL], 'atlas', 'x');
    gh.pr.ci = 'success';
    await e.prs.poll();
    expect(lastRun(e, a.id)).toBe(null);
    await validate({ ...gate, pr: 41 }, gh.gh);
    await e.prs.poll();
    await eventually(() => e.kanban.get(a.id).status === 'done', { what: 'Done (no run)' });

    // A stuck run: the review step couldn't run (no verdict twice).
    e.workflows.update(reviewOf(e)!.id, { enabled: true });
    gh.pr = { ...gh.pr, state: 'open', mergeSha: null, ci: 'pending', qa: null };
    const b = card(e);
    e.kanban.requestReview(b.id, [URL], 'atlas', 'y');
    await atStep(e, b.id, 'ci');
    gh.pr.ci = 'success';
    await e.prs.poll();
    await eventually(() => lastRun(e, b.id)?.steps?.find((s) => s.nodeId === 'review' && s.couldntRun) ?? null, { what: 'the review step stuck' });
    await validate({ ...gate, pr: 41 }, gh.gh);
    await e.prs.poll();
    await eventually(() => e.kanban.get(b.id).status === 'done', { what: 'Done (stuck run)' });
    expect(lastRun(e, b.id)).toMatchObject({ state: 'stopped', reason: expect.stringContaining('merged on GitHub outside the workflow') });
  });
});

describe('the update with tasks in flight, on a store from before #263', () => {
  it('a store with the global review agent: copied into each project it is a member of; tasks In review get their run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-review-'));
    const dbFile = join(dataDir, 'atlas.db');
    const gh = fakeGitHub();
    // First start: no Review machinery (as before the update), a task In review.
    let t = await setup({ dbFile, dataDir, gh, review: false });
    const c = card(t.e);
    t.e.kanban.requestReview(c.id, [URL], 'atlas', 'before');
    // Back to the store of the release before: 0063 not applied, the global review agent setting; Datinel without zurich.
    t.e.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'atlas', members: ['atlas'] });
    t.e.db.exec(`ALTER TABLE projects DROP COLUMN review_agent; ALTER TABLE projects DROP COLUMN review_seeded;
      DELETE FROM schema_migrations WHERE name = '0063_review_workflow.sql';
      INSERT OR REPLACE INTO settings (key, value) VALUES ('review_agent', 'zurich');`);
    await t.e.stop();
    t = await setup({ dbFile, dataDir, gh, review: false });
    expect(t.e.projects.get('atlas').reviewAgent).toBe('zurich');
    expect(t.e.projects.get('datinel').reviewAgent).toBe(null); // not a member there: never a reviewer it can't be
    expect(t.e.db.prepare("SELECT 1 FROM settings WHERE key = 'review_agent'").get()).toBe(undefined);
    expect(reviewOf(t.e)).toBe(null);
    startReview(t.e);
    await atStep(t.e, c.id, 'ci');
    expect(lastRun(t.e, c.id)!.steps![0]!.summary).toContain(AT_UPDATE);
    await t.e.stop();
    // The next start: no second workflow, no second run.
    t = await setup({ dbFile, dataDir, gh });
    expect(t.e.workflows.list().filter((w) => w.origin === 'review').map((w) => w.projectId).sort()).toEqual(['atlas', 'datinel']);
    expect(t.e.db.prepare('SELECT COUNT(*) AS n FROM workflow_runs WHERE subject_card = ?').get(c.id)).toEqual({ n: 1 });
  });
});
