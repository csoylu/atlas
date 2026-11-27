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
    startReview(e, { reviewers: false });
    const w = reviewOf(e)!;
    expect(w).toMatchObject({ name: 'Review', enabled: true, origin: 'review', projectId: 'atlas' });
    // Nine steps on three rows (#334): the review path on row 2, « Review the reviewer's PR » under the first review,
    // « Back to the builder » bottom left.
    expect(layout(e, w.id)).toEqual([
      ['trigger', 'trigger', 40, 80],
      ['ci', 'wait', 272, 80],
      ['checks', 'condition', 504, 80],
      ['own', 'condition', 40, 288],
      ['review', 'agent', 272, 288],
      ['review2', 'agent', 272, 496],
      ['merge', 'action', 504, 288],
      ['done', 'action', 736, 288],
      ['back', 'action', 40, 496],
    ]);
    // A new project: no agent in either review step; the condition tests for nobody yet.
    const cfg = (id: string) => w.nodes.find((n) => n.id === id)!.config as Record<string, unknown>;
    expect([cfg('review'), cfg('review2')]).toEqual([expect.objectContaining({ agentId: null, verdict: true, inThread: true }), expect.objectContaining({ agentId: null, verdict: true, inThread: true })]);
    expect(cfg('own')).toMatchObject({ tests: [{ field: 'task.assignee', op: 'isNot', value: '' }] });
    expect(inbox(e, 'workflow.no_agent')).toEqual([expect.objectContaining({ title: "Choose who reviews Atlas's PRs" })]);
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

  it('« Reset to default » brings back the nine steps, their links and the layout with the agents chosen now; only on a default Review', async () => {
    const { e } = await setup();
    const w = reviewOf(e)!;
    const edited = e.workflows.get(w.id);
    e.workflows.saveGraph(w.id, {
      revision: edited.revision,
      nodes: edited.nodes.filter((n) => n.id !== 'done').map((n) => ({ ...n, x: n.x + 100 })),
      edges: edited.edges.filter((x) => x.to !== 'done'),
    });
    expect(e.workflows.get(w.id).nodes).toHaveLength(8);
    e.workflows.update(w.id, { enabled: false });
    const back = e.workflows.resetReview(w.id);
    expect(layout(e, w.id)).toEqual(reviewGraph().nodes.map((n) => [n.id, n.kind, n.x, n.y]));
    expect(back.edges).toEqual(reviewGraph().edges);
    // The agents chosen now stay (#335 2a): zurich reviews, atlas reviews zurich's PRs, the condition tests for zurich.
    expect(back.nodes).toEqual(e.workflows.get(w.id).nodes);
    expect(back.nodes.map((n) => n.config)).toEqual(reviewGraph({ reviewer: 'zurich', other: 'atlas' }).nodes.map((n) => expect.objectContaining(n.config as object)));
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

  it('the review step\'s agent disabled: the step can\'t run and says why; never another agent (atlas 3)', async () => {
    const gh = fakeGitHub();
    gh.pr.ci = 'success';
    const { e } = await setup({ gh });
    e.agents.update('zurich', { enabled: false });
    const c = card(e);
    e.kanban.requestReview(c.id, [URL], 'atlas', 'x');
    await e.prs.poll();
    const step = await eventually(() => lastRun(e, c.id)?.steps?.find((s) => s.nodeId === 'review' && s.couldntRun) ?? null, { what: 'the review step stuck' });
    expect(step.couldntRun!.reason).toBe('@zurich is off: turn it on, or choose one in « Review the PR » of workflow « Review »');
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
  it('a store with the global review agent: the setting goes; tasks In review get their run; the new Review workflow asks for its agents', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-review-'));
    const dbFile = join(dataDir, 'atlas.db');
    const gh = fakeGitHub();
    // First start: no Review machinery (as before the update), a task In review.
    let t = await setup({ dbFile, dataDir, gh, review: false });
    const c = card(t.e);
    t.e.kanban.requestReview(c.id, [URL], 'atlas', 'before');
    // Back to the store of the release before: 0063 and 0069 not applied, the global review agent setting.
    t.e.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'atlas', members: ['atlas'] });
    t.e.db.exec(`ALTER TABLE projects DROP COLUMN review_seeded; ALTER TABLE notifications DROP COLUMN link;
      DELETE FROM schema_migrations WHERE name IN ('0063_review_workflow.sql', '0069_review_step_agent.sql');
      INSERT OR REPLACE INTO settings (key, value) VALUES ('review_agent', 'zurich');`);
    await t.e.stop();
    t = await setup({ dbFile, dataDir, gh, review: false });
    expect(t.e.db.prepare("SELECT 1 FROM settings WHERE key = 'review_agent'").get()).toBe(undefined);
    expect(t.e.db.prepare("SELECT 1 FROM pragma_table_info('projects') WHERE name = 'review_agent'").get()).toBe(undefined);
    expect(reviewOf(t.e)).toBe(null);
    startReview(t.e, { reviewers: false });
    await atStep(t.e, c.id, 'ci');
    expect(lastRun(t.e, c.id)!.steps![0]!.summary).toContain(AT_UPDATE);
    // Made with no agent (#334): one Inbox item per project tells Master to choose who reviews.
    expect(inbox(t.e, 'workflow.no_agent').map((n) => n.title).sort()).toEqual(["Choose who reviews Atlas's PRs", "Choose who reviews Datinel's PRs"]);
    await t.e.stop();
    // The next start: no second workflow, no second run, no second item.
    t = await setup({ dbFile, dataDir, gh });
    expect(t.e.workflows.list().filter((w) => w.origin === 'review').map((w) => w.projectId).sort()).toEqual(['atlas', 'datinel']);
    expect(t.e.db.prepare('SELECT COUNT(*) AS n FROM workflow_runs WHERE subject_card = ?').get(c.id)).toEqual({ n: 1 });
    expect(inbox(t.e, 'workflow.no_agent')).toHaveLength(2);
  });
});

describe('the update to #334 (no project review agent): each review step gets the agent of today, nobody else reviews', () => {
  /** A Review workflow as main had it before #334: seven steps, « Review the PR » on « the project's review agent ». */
  const before = (e: E, id: string, moved = false) => {
    const g = e.workflows.get(id);
    const old: Record<string, [number, number]> = { trigger: [40, 80], ci: [272, 80], checks: [504, 80], review: [40, 288], merge: [272, 288], done: [504, 288], back: [40, 496] };
    const nodes = g.nodes
      .filter((n) => n.id in old)
      .map((n) => ({ ...n, x: old[n.id]![0] + (moved && n.id === 'back' ? 8 : 0), y: old[n.id]![1], config: n.id === 'review' ? { ...n.config, agentId: null } : n.config }));
    const edges = g.edges.filter((x) => x.from !== 'own' && x.from !== 'review2').concat([]).map((x) => (x.to === 'own' ? { ...x, to: 'review' } : x));
    e.workflows.saveGraph(id, { revision: g.revision, nodes: nodes as never, edges }, 'user');
    // The old flag, as 0063's engine wrote it (the schema of today refuses it).
    e.db.prepare("UPDATE workflow_nodes SET config = json_remove(json_set(config, '$.reviewAgent', json('true')), '$.verdict') WHERE workflow_id = ? AND id = 'review'").run(id);
  };

  it('Atlas (zurich, lead atlas) gets the condition and « Review the reviewer\'s PR » by atlas; Datinel with none set asks; layout moved only if untouched', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-334-'));
    const dbFile = join(dataDir, 'atlas.db');
    const gh = fakeGitHub();
    let t = await setup({ dbFile, dataDir, gh, review: false });
    t.e.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'munih', members: ['munih'] });
    startReview(t.e);
    const atlas = await eventually(() => reviewOf(t.e), { what: "Atlas's Review" });
    const datinel = await eventually(() => reviewOf(t.e, 'datinel'), { what: "Datinel's Review" });
    // A workflow of Master's own with the old flag on one step (no condition added: it is not a default Review).
    const mine = t.e.workflows.create({ name: 'Mine', enabled: false, projectId: 'atlas', nodes: [{ id: 'trigger', kind: 'trigger', x: 0, y: 0, config: { kind: 'manual' } }, { id: 'rv', kind: 'agent', x: 0, y: 200, config: { agentId: null, prompt: 'Review it', inThread: true } }], edges: [{ from: 'trigger', exit: 'start', to: 'rv' }] }, 'user');
    t.e.db.prepare("UPDATE workflow_nodes SET config = json_set(config, '$.reviewAgent', json('true')) WHERE workflow_id = ? AND id = 'rv'").run(mine.id);
    before(t.e, atlas.id);
    before(t.e, datinel.id, true);
    t.e.db.exec(`ALTER TABLE projects ADD COLUMN review_agent TEXT; ALTER TABLE notifications DROP COLUMN link;
      UPDATE projects SET review_agent = 'zurich' WHERE id = 'atlas';
      DELETE FROM schema_migrations WHERE name = '0069_review_step_agent.sql';`);
    await t.e.stop();
    t = await setup({ dbFile, dataDir, gh, review: false });
    const a = t.e.workflows.get(atlas.id);
    const cfg = (w: typeof a, id: string) => w.nodes.find((n) => n.id === id)!.config as Record<string, unknown>;
    expect(cfg(a, 'review')).toMatchObject({ agentId: 'zurich', verdict: true });
    expect(cfg(a, 'review')).not.toHaveProperty('reviewAgent');
    expect(cfg(a, 'review2')).toMatchObject({ title: "Review the reviewer's PR", agentId: 'atlas', verdict: true, inThread: true, prompt: cfg(a, 'review').prompt });
    expect(cfg(a, 'own')).toMatchObject({ test: 'fields', title: 'Built by another agent?', tests: [{ field: 'task.assignee', op: 'isNot', value: 'zurich' }] });
    // Untouched layout: the nine steps of today's default, the same links.
    expect(layout(t.e, atlas.id).sort()).toEqual(reviewGraph().nodes.map((n) => [n.id, n.kind, n.x, n.y]).sort());
    expect([...a.edges].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))).toEqual([...reviewGraph().edges].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))));
    // Datinel had no review agent: no agent in « Review the PR », the lead in the second; its moved layout stays, the new steps go right.
    const d = t.e.workflows.get(datinel.id);
    expect(cfg(d, 'review')).toMatchObject({ agentId: null, verdict: true });
    expect(cfg(d, 'review2')).toMatchObject({ agentId: 'munih' });
    expect(cfg(d, 'own')).toMatchObject({ tests: [{ field: 'task.assignee', op: 'isNot', value: '' }] });
    expect(layout(t.e, datinel.id).filter(([id]) => id === 'own' || id === 'review2' || id === 'review')).toEqual([
      ['review', 'agent', 40, 288],
      ['own', 'condition', 736, 288],
      ['review2', 'agent', 736, 496],
    ]);
    // Master's own workflow: the step gets the agent and the verdict, nothing else.
    const m = t.e.workflows.get(mine.id);
    expect(m.nodes.map((n) => n.id)).toEqual(['trigger', 'rv']);
    expect(cfg(m, 'rv')).toMatchObject({ agentId: 'zurich', verdict: true });
    expect(t.e.db.prepare("SELECT 1 FROM pragma_table_info('projects') WHERE name = 'review_agent'").get()).toBe(undefined);
    await t.e.stop();
  });

  it('after the update, a PR by munih is reviewed by zurich and one by zurich by atlas, through the steps', async () => {
    const gh = fakeGitHub();
    gh.pr.ci = 'success';
    const { e, idle } = await setup({ gh, script: byAgent([verdict('ok', 'checked'), text('validated')]) });
    const m = card(e, 'munih');
    e.kanban.requestReview(m.id, [URL], 'munih', 'built');
    await e.prs.poll();
    const run = await ended(e, m.id);
    expect(path(run)).toEqual([['trigger', 'start'], ['ci', 'event'], ['checks', 'yes'], ['own', 'yes'], ['review', 'approved'], ['merge', 'merged'], ['done', 'done']]);
    expect(e.runner.runs(m.id).filter((r) => r.kind !== 'work' || r.agentId !== 'munih').map((r) => r.agentId)).toContain('zurich');
    expect(e.kanban.get(m.id).reviewer).toBe('zurich');
    // The Inbox (#377): one « done » item with the task's title and the builder's handoff, not « Review ran » with no text.
    expect(inbox(e, 'schedule.ran')).toEqual([]);
    expect(inbox(e, 'card.done')).toEqual([{ title: 'Workflows', body: 'built', card_id: m.id, archived_at: null }]);
    await idle(m.id);
  });
});
