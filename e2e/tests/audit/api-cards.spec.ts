import { test, expect } from '../../harness/fixtures.ts';
import { call, idleCard, tu, say, until } from '../../harness/audit.ts';

test.describe('K · cards, kanban, dispatcher (API)', () => {
  test('[K01] POST /cards creates numbered cards; numbers are sequential and never reused after delete', async ({ atlas }) => {
    const a = await idleCard(atlas, 'one');
    const b = await idleCard(atlas, 'two');
    expect([a.number, b.number]).toEqual([1, 2]);
    expect((await call(atlas, 'DELETE', `/cards/${b.id}`)).status).toBe(204);
    const c = await idleCard(atlas, 'three');
    expect(c.number).toBe(3);
    expect((await call(atlas, 'GET', `/cards/${b.id}`)).status).toBe(404);
  });

  test('[K02] create validation: empty/long title, bad status, unknown assignee/parent are refused with a reason', async ({ atlas }) => {
    expect((await call(atlas, 'POST', '/cards', { title: '   ' })).status).toBe(400);
    expect((await call(atlas, 'POST', '/cards', { title: 'x'.repeat(201) })).status).toBe(400);
    const as = await call(atlas, 'POST', '/cards', { title: 'x', status: 'todo', assignee: 'ghost' });
    expect(as.status).toBe(409);
    expect(as.body.error).toMatch(/ghost/);
    expect((await call(atlas, 'POST', '/cards', { title: 'x', status: 'todo', parents: ['nope'] })).status).toBe(409);
    expect((await call(atlas, 'GET', '/cards')).body).toEqual([]);
  });

  test('[K02b] a card cannot be created or moved to "running" by hand (no run exists) - BUG B1: the API accepts it and the card stays "running"', async ({ atlas }) => {
    expect((await call(atlas, 'POST', '/cards', { title: 'x', status: 'running' })).status).toBe(400);
    const c = await idleCard(atlas);
    expect((await call(atlas, 'PATCH', `/cards/${c.id}`, { status: 'running' })).status).toBe(400);
  });

  test('[K03] PATCH edits title, body, priority; empty patch is a no-op; unknown id 404', async ({ atlas }) => {
    const c = await idleCard(atlas);
    const r = await call(atlas, 'PATCH', `/cards/${c.id}`, { title: 'new', body: 'b', priority: 2 });
    expect(r.body).toMatchObject({ title: 'new', body: 'b', priority: 2 });
    expect((await call(atlas, 'PATCH', `/cards/${c.id}`, {})).status).toBe(200);
    expect((await call(atlas, 'PATCH', `/cards/${c.id}`, { title: '' })).status).toBe(400);
    expect((await call(atlas, 'PATCH', `/cards/zzz`, { title: 'x' })).status).toBe(404);
    expect((await call(atlas, 'PATCH', `/cards/${c.id}`, { modelId: 'nope' })).status).toBe(409);
  });

  test('[K04] todo waits on an open parent and moves to ready when the parent is done', async ({ atlas }) => {
    const p = await idleCard(atlas, 'parent');
    const ch = await idleCard(atlas, 'child', { parents: [p.id] });
    expect(ch.parents).toEqual([p.id]);
    // a ready card with an open parent is held in todo
    const held = await call(atlas, 'PATCH', `/cards/${ch.id}`, { status: 'ready' });
    expect(held.body.status).toBe('todo');
    expect(held.body.waiting).toBeTruthy();
    await call(atlas, 'PATCH', `/cards/${p.id}`, { status: 'done' });
    expect((await call(atlas, 'GET', `/cards/${ch.id}`)).body.status).toBe('ready');
  });

  test('[K05] a parent cycle and a self-parent are refused', async ({ atlas }) => {
    const a = await idleCard(atlas, 'a');
    const b = await idleCard(atlas, 'b', { parents: [a.id] });
    expect((await call(atlas, 'PATCH', `/cards/${a.id}`, { parents: [b.id] })).status).toBe(409);
    expect((await call(atlas, 'PATCH', `/cards/${a.id}`, { parents: [a.id] })).status).toBe(409);
  });

  test('[K06] closing a parent does NOT release its children, and says why; reopening works', async ({ atlas }) => {
    const p = await idleCard(atlas, 'parent');
    const ch = await idleCard(atlas, 'child', { parents: [p.id] });
    await call(atlas, 'PATCH', `/cards/${p.id}`, { status: 'closed' });
    const c = (await call(atlas, 'GET', `/cards/${ch.id}`)).body;
    expect(c.status).toBe('todo');
    expect(c.waiting).toMatch(/closed/i);
    expect((await call(atlas, 'PATCH', `/cards/${p.id}`, { status: 'todo' })).body.status).toBe('todo');
  });

  test('[K07] dragging a card to blocked by hand gives it a reason; leaving blocked clears the block', async ({ atlas }) => {
    const c = await idleCard(atlas);
    const b = (await call(atlas, 'PATCH', `/cards/${c.id}`, { status: 'blocked' })).body;
    expect(b.status).toBe('blocked');
    expect(b.block).toMatchObject({ kind: 'needs_input' });
    expect(b.block.reason).toMatch(/Moved to blocked/);
    const r = (await call(atlas, 'PATCH', `/cards/${c.id}`, { status: 'todo' })).body;
    expect(r.block).toBeNull();
  });

  test('[K08] an assigned ready card runs; a model that ends with plain text blocks it needs_input with that text', async ({ atlas }) => {
    atlas.model.next(say('Which colour?'));
    const c = await atlas.task('plain text ending');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('blocked');
    const done = await atlas.card(c.id);
    expect(done.block).toMatchObject({ kind: 'needs_input', reason: 'Which colour?' });
  });

  test('[K09] task_complete ends the run done with the summary, raises an Inbox update', async ({ atlas }) => {
    atlas.model.next(tu('task_complete', { summary: 'all good' }));
    const c = await atlas.task('complete me');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('done');
    const inbox = (await call(atlas, 'GET', '/inbox')).body;
    expect(JSON.stringify(inbox)).toContain('all good');
    expect(inbox.badge).toBeGreaterThan(0);
  });

  test('[K10] task_block(needs_input, options) → Needs-you item; the user answering puts it back to ready and the agent resumes', async ({ atlas }) => {
    atlas.model.next(tu('task_block', { kind: 'needs_input', question: 'Pick one', options: ['A', 'B'] }), tu('task_complete', { summary: 'used B' }));
    const c = await atlas.task('ask me');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('blocked');
    const card = await atlas.card(c.id);
    expect(card.block).toMatchObject({ kind: 'needs_input', reason: 'Pick one', options: ['A', 'B'] });
    const inbox = (await call(atlas, 'GET', '/inbox')).body;
    expect(inbox.needsYou.length).toBe(1);
    await atlas.say(c.id, 'B');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('done');
    // the answer is what the model saw on the second run
    expect(atlas.model.lastMain.text).toContain('B');
    // and the Needs-you item left by itself
    expect((await call(atlas, 'GET', '/inbox')).body.needsYou).toEqual([]);
  });

  test('[K11] task_request_review → review status + Inbox needs-you; user message puts it back to ready/running', async ({ atlas }) => {
    atlas.model.next(tu('task_request_review', { summary: 'please look' }), tu('task_complete', { summary: 'fixed' }));
    const c = await atlas.task('review me');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('review');
    expect((await call(atlas, 'GET', '/inbox')).body.needsYou.length).toBe(1);
    await atlas.say(c.id, 'change the title');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('done');
  });

  test('[K12] transient block carries a retry time (until) and is not reported as needing the user', async ({ atlas }) => {
    atlas.model.next(tu('task_block', { kind: 'transient', question: 'rate limited', retry_in_minutes: 30 }));
    const c = await atlas.task('transient');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('blocked');
    const card = await atlas.card(c.id);
    expect(card.block?.kind).toBe('transient');
    expect(Date.parse(card.block!.until!)).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect((await call(atlas, 'GET', '/inbox')).body.needsYou.length).toBe(0);
  });

  test('[K13] "why not running": a second ready card of a busy agent shows why (agent busy), then starts', async ({ atlas }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    atlas.model.next(
      () => {
        throw new Error('unused');
      },
    );
    // first card: a slow model call (blocks inside complete until released)
    const orig = atlas.model.complete.bind(atlas.model);
    let first = true;
    atlas.model.complete = async (req, onText, signal) => {
      if (first) {
        first = false;
        await gate;
      }
      return orig(req, onText, signal);
    };
    atlas.model['queue'] = [];
    atlas.model.next(tu('task_complete', { summary: 'one' }), tu('task_complete', { summary: 'two' }));
    const c1 = await atlas.task('first');
    await until(() => !!atlas.engine.runner.current(c1.id), 5000, 'first run');
    const c2 = await atlas.task('second');
    await expect.poll(async () => (await atlas.card(c2.id)).waiting ?? '').toMatch(/busy|#\d|running/i);
    release();
    await expect.poll(async () => (await atlas.card(c2.id)).status).toBe('done');
  });

  test('[K14] Stop aborts a running task at once and blocks it "Stopped by you"; writing on it resumes', async ({ atlas }) => {
    atlas.model.next(tu('shell', { command: 'sleep 30' }), tu('task_complete', { summary: 'resumed' }));
    const c = await atlas.task('stop me');
    await until(() => atlas.engine.runner.current(c.id) !== undefined && atlas.model.calls.length >= 1, 5000, 'run');
    await new Promise((r) => setTimeout(r, 400));
    const s = await call(atlas, 'POST', `/cards/${c.id}/stop`);
    expect(s.body.stopped).toBe(true);
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('blocked');
    expect((await atlas.card(c.id)).block?.reason).toMatch(/Stopped by you/i);
    await atlas.say(c.id, 'go on');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('done');
  });

  test('[K15] two failed attempts in a row block the card capability with both errors', async ({ atlas }) => {
    const orig = atlas.model.complete.bind(atlas.model);
    atlas.model.complete = async () => {
      throw new Error('boom 400 bad request');
    };
    const c = await atlas.task('fail twice');
    await expect.poll(async () => (await atlas.card(c.id)).status, { timeout: 20_000 }).toBe('blocked');
    const card = await atlas.card(c.id);
    expect(card.block?.kind).toMatch(/capability|transient/);
    expect(card.block?.reason).toContain('boom');
    atlas.model.complete = orig;
  });

  test('[K16] retry endpoint re-runs a failed card', async ({ atlas }) => {
    const orig = atlas.model.complete.bind(atlas.model);
    atlas.model.complete = async () => {
      throw new Error('boom 400 bad request');
    };
    const c = await atlas.task('retry me');
    await expect.poll(async () => (await atlas.card(c.id)).status, { timeout: 20_000 }).toBe('blocked');
    atlas.model.complete = orig;
    atlas.model.next(tu('task_complete', { summary: 'ok now' }));
    const r = await call(atlas, 'POST', `/cards/${c.id}/retry`);
    expect(r.status).toBe(200);
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('done');
  });

  test('[K17] runs, tool-calls, messages, timeline endpoints describe a finished run', async ({ atlas }) => {
    atlas.model.next(tu('list_files', { path: '.' }), tu('task_complete', { summary: 'listed' }));
    const c = await atlas.task('inspect me');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('done');
    const runs = (await call(atlas, 'GET', `/cards/${c.id}/runs`)).body;
    expect(runs[0]).toMatchObject({ kind: 'work', status: 'done' });
    const tcs = (await call(atlas, 'GET', `/cards/${c.id}/tool-calls`)).body;
    expect(tcs.map((t: any) => t.name)).toEqual(expect.arrayContaining(['list_files', 'task_complete']));
    const msgs = (await call(atlas, 'GET', `/cards/${c.id}/messages`)).body;
    expect(msgs.length).toBeGreaterThan(2);
    const tl = (await call(atlas, 'GET', `/cards/${c.id}/timeline`)).body;
    expect(tl).toHaveProperty('runs');
    expect((await call(atlas, 'GET', `/cards/nope/runs`)).status).toBe(404);
  });

  test('[K18] a comment on a running card is delivered at the next turn', async ({ atlas }) => {
    atlas.model.next(tu('shell', { command: 'sleep 1' }), tu('task_complete', { summary: 'saw it' }));
    const c = await atlas.task('comment while running');
    await until(() => atlas.model.calls.length >= 1, 5000, 'first turn');
    await atlas.say(c.id, 'REMEMBER-THE-MILK');
    await expect.poll(async () => (await atlas.card(c.id)).status).toBe('done');
    expect(atlas.model.lastMain.text).toContain('REMEMBER-THE-MILK');
  });

  test('[K19] deleting a card with a running run stops it; messages on a missing card 404', async ({ atlas }) => {
    atlas.model.next(tu('shell', { command: 'sleep 30' }));
    const c = await atlas.task('delete me');
    await until(() => atlas.model.calls.length >= 1, 5000, 'turn');
    await new Promise((r) => setTimeout(r, 300));
    expect((await call(atlas, 'DELETE', `/cards/${c.id}`)).status).toBe(204);
    expect((await call(atlas, 'GET', `/cards/${c.id}`)).status).toBe(404);
    expect((await call(atlas, 'POST', `/cards/${c.id}/messages`, { text: 'hi' })).status).toBe(404);
  });

  test('[K20] POST message validation: empty text 400, >100k 400', async ({ atlas }) => {
    const c = await idleCard(atlas);
    expect((await call(atlas, 'POST', `/cards/${c.id}/messages`, { text: '  ' })).status).toBe(400);
    expect((await call(atlas, 'POST', `/cards/${c.id}/messages`, { text: 'x'.repeat(100_001) })).status).toBe(400);
  });

  test('[K21] triage: a card created in triage is picked up by the triage agent', async ({ atlas }) => {
    atlas.model.next(tu('task_update', { id: '#1', title: 'Shaped', status: 'todo' }), say('shaped'));
    const r = await call(atlas, 'POST', '/cards', { title: 'raw idea', status: 'triage' });
    expect(r.status).toBe(201);
    await expect.poll(async () => (await atlas.card(r.body.id)).title, { timeout: 15_000 }).toBe('Shaped');
    const runs = (await call(atlas, 'GET', `/cards/${r.body.id}/runs`)).body;
    expect(runs[0].kind).toBe('triage');
  });

  test('[K22] project memories of a card go stale when it is done/closed (design §8)', async ({ atlas }) => {
    const c = await atlas.task('mem card');
    // saved by the agent on this card
    atlas.model.next(tu('memory_add', { kind: 'project', text: 'audit project note about zebra', scope: 'self' }), tu('shell', { command: 'sleep 1' }), tu('task_complete', { summary: 'ok' }));
    await atlas.say(c.id, 'go');
    await expect.poll(async () => (await atlas.card(c.id)).status, { timeout: 15_000 }).toBe('done');
    const mems = (await call(atlas, 'GET', '/memories?status=stale')).body;
    expect(JSON.stringify(mems)).toContain('zebra');
  });
});
