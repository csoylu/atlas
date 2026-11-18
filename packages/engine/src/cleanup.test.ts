import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, MemoryProposal } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import type { ModelRequest } from './providers/types.ts';
import { CLEANUP_BY, CLEANUP_SCHEDULE } from './cleanup.ts';
import { until } from '../test/kit/index.ts';

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

async function setup(fake: FakeProvider, o: { dbFile?: string; dataDir?: string; dispatch?: boolean } = {}) {
  const e = await startEngine({
    dbFile: o.dbFile ?? ':memory:',
    dataDir: o.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-')),
    port: 0,
    dispatch: o.dispatch ?? true,
    providers: () => fake,
    env: {},
    manageLocal: false,
  });
  engines.push(e);
  return e;
}
let n = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: 'tool_use', id: `t${++n}`, name, input });
const lastResults = (req: ModelRequest) =>
  req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [{ content: b.content, error: !!b.is_error }] : []));

/** Five memories: a duplicate pair, a stale project note, a fact filed as a rule, and one left alone. */
function seed(e: Engine) {
  const m = e.memories;
  const done = e.kanban.create({ title: 'DVOL ingest', assignee: 'atlas', status: 'todo' }, 'user');
  return {
    a: m.add({ kind: 'fact', scope: 'agent:atlas', text: 'npm is not on PATH: use the nvm node 24 bin folder' }, 'atlas'),
    b: m.add({ kind: 'fact', scope: 'shared', text: 'The npm binary is not on PATH, use nvm node 24' }, 'atlas'),
    c: m.add({ kind: 'project', scope: 'agent:atlas', text: 'DVOL ingest: PR not opened yet', cardId: done.id }, 'atlas'),
    d: m.add({ kind: 'rule', scope: 'agent:atlas', text: 'Prod ClickHouse is reachable through Teleport only' }, 'atlas'),
    e: m.add({ kind: 'preference', scope: 'shared', text: 'Master likes short answers' }, 'user'),
  };
}

describe('weekly memory cleanup (#83)', () => {
  it('creates its built-in weekly schedule at startup, once', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const dbFile = join(dataDir, 'c.db');
    const first = await setup(new FakeProvider([]), { dbFile, dataDir });
    expect(first.schedules.get(CLEANUP_SCHEDULE)).toMatchObject({ agentId: 'atlas', kind: 'cron', cron: '0 9 * * 1', createCard: true, enabled: true, title: 'Memory cleanup' });
    // The user may turn it off: a restart doesn't recreate or re-enable it.
    first.schedules.update(CLEANUP_SCHEDULE, { enabled: false });
    await first.stop();
    engines = [];
    const second = await setup(new FakeProvider([]), { dbFile, dataDir });
    expect(second.schedules.list().filter((s) => s.id === CLEANUP_SCHEDULE)).toHaveLength(1);
    expect(second.schedules.get(CLEANUP_SCHEDULE).enabled).toBe(false);
  });

  it('a run files proposals, lands in the Inbox as one item; approve applies, reject leaves memory untouched', async () => {
    let seen: { a: number; b: number; c: number; d: number } | null = null;
    const fake = new FakeProvider([
      [use('memory_review', {})],
      (req) => {
        const review = lastResults(req)[0]!.content as string;
        expect(review).toMatch(/## shared/);
        expect(review).toMatch(new RegExp(`m${seen!.c} · project · stale · confirmed \\d{4}-\\d\\d-\\d\\d · task #\\d+ done\\] DVOL`));
        expect(review).toMatch(/always-on of @atlas: \d+\/3000 chars/);
        return [
          use('memory_propose', { action: 'merge', ids: [`m${seen!.b}`, `m${seen!.a}`], text: 'npm is not on PATH: use ~/.nvm/versions/node/v24/bin', reason: 'same fact twice' }),
          use('memory_propose', { action: 'archive', ids: [`m${seen!.c}`], reason: 'its card is done' }),
          use('memory_propose', { action: 'update', ids: [seen!.d], kind: 'fact', reason: 'a fact, not a rule' }),
          use('memory_propose', { action: 'merge', ids: [seen!.a], text: 'x', reason: 'bad' }),
          use('memory_add', { kind: 'fact', text: 'should still work but the prompt says not to', new: true }),
        ];
      },
      (req) => {
        const r = lastResults(req);
        expect(r.slice(0, 3).map((x) => x.content)).toEqual([expect.stringMatching(/^proposed p1: merge/), expect.stringMatching(/^proposed p2: archive/), expect.stringMatching(/^proposed p3: update/)]);
        expect(r[3]).toEqual({ content: 'merge needs at least two memories', error: true });
        return [use('task_complete', { summary: '3 proposals: 1 merge, 1 archive, 1 kind fix' })];
      },
    ]);
    const e = await setup(fake);
    const m = seed(e);
    seen = { a: m.a.id, b: m.b.id, c: m.c.id, d: m.d.id };
    e.kanban.update(m.c.cardId!, { status: 'done' }, 'user'); // m.c goes stale
    const before = e.memories.list();

    const card = e.schedules.runNow(CLEANUP_SCHEDULE);
    expect(card.createdBy).toBe(CLEANUP_BY);
    await until(() => e.kanban.get(card.id).status === 'done', 'cleanup card done', 3000);
    expect(fake.calls[0]!.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['memory_review', 'memory_propose']));
    expect(JSON.stringify(fake.calls[0])).toContain('Weekly memory cleanup');

    // Nothing changed yet (the memory_add is the agent's own business, not a proposal).
    const after = e.memories.list().filter((x) => before.some((b) => b.id === x.id));
    expect(after.map((x) => [x.id, x.text, x.kind, x.status])).toEqual(before.map((x) => [x.id, x.text, x.kind, x.status]));

    const props = e.cleanup.list({ cardId: card.id });
    expect(props.map((p) => [p.action, p.memoryIds, p.status])).toEqual([
      ['merge', [m.b.id, m.a.id], 'pending'],
      ['archive', [m.c.id], 'pending'],
      ['update', [m.d.id], 'pending'],
    ]);
    expect(props[0]!.memories.map((x) => x.id)).toEqual([m.b.id, m.a.id]);
    const inbox = e.notifications.inbox();
    expect(inbox.updates.filter((u) => u.cardId === card.id).map((u) => [u.kind, u.title])).toEqual([['memory.cleanup', 'Memory cleanup: 3 proposals']]);

    // Over the API, as the Inbox does it.
    const post = async (path: string) => {
      const r = await fetch(e.url + '/api' + path, { method: 'POST' });
      return { status: r.status, body: (await r.json()) as MemoryProposal & { error?: string } };
    };
    const merged = await post(`/memory-proposals/p${props[0]!.id}/approve`);
    expect(merged.status).toBe(200);
    expect(merged.body.status).toBe('approved');
    expect(e.memories.get(m.b.id)).toMatchObject({ text: 'npm is not on PATH: use ~/.nvm/versions/node/v24/bin', status: 'active', scope: 'shared', updatedBy: 'user' });
    expect(e.memories.get(m.a.id).status).toBe('archived');
    expect((await post(`/memory-proposals/${props[0]!.id}/approve`)).status).toBe(409); // decided already

    const rejected = await post(`/memory-proposals/${props[1]!.id}/reject`);
    expect(rejected.body.status).toBe('rejected');
    expect(e.memories.get(m.c.id)).toMatchObject({ status: 'stale', text: m.c.text, updatedAt: before.find((x) => x.id === m.c.id)!.updatedAt });

    await post(`/memory-proposals/${props[2]!.id}/approve`);
    expect(e.memories.get(m.d.id)).toMatchObject({ kind: 'fact', text: m.d.text });
    expect(e.memories.get(m.e.id)).toEqual(before.find((x) => x.id === m.e.id));
    expect(await (await fetch(e.url + '/api/memory-proposals?status=pending')).json()).toEqual([]);

    // Each applied change is in the memory log, so the daily digest can undo it.
    const undo = e.memories.changes(props[2]!.createdAt).find((c) => c.memoryId === m.d.id && c.action === 'update')!;
    e.memories.undo(undo.id, 'user');
    expect(e.memories.get(m.d.id).kind).toBe('rule');
  });

  it('approving is all or nothing: refused when a memory changed since, or a scope move breaks the budget', async () => {
    const e = await setup(new FakeProvider([]), { dispatch: false });
    const m = seed(e);
    const card = e.kanban.create({ title: 'Memory cleanup', assignee: 'atlas' }, CLEANUP_BY);
    const { proposal: p } = e.cleanup.propose(card.id, { action: 'merge', ids: [m.a.id, m.b.id], text: 'merged', reason: 'dup' }, 'atlas');
    // The same proposal again (a resumed run re-sending its call) is not filed twice.
    expect(e.cleanup.propose(card.id, { action: 'merge', ids: [`m${m.a.id}`, m.b.id], text: 'merged', reason: 'dup, again' }, 'atlas')).toMatchObject({ existed: true, proposal: { id: p.id } });
    await new Promise((r) => setTimeout(r, 5));
    e.memories.update(m.b.id, { text: 'The npm binary is not on PATH (nvm node 24.7)' }, 'atlas');
    expect(() => e.cleanup.approve(p.id, 'user')).toThrow(new RegExp(`m${m.b.id} changed after this proposal`));
    expect(e.memories.get(m.a.id).status).toBe('active'); // not archived: rolled back
    expect(e.cleanup.get(p.id).status).toBe('pending');

    const long = e.memories.add({ kind: 'rule', scope: 'agent:atlas', text: 'R'.repeat(480) }, 'user');
    for (let i = 0; i < 5; i++) e.memories.add({ kind: 'rule', scope: 'shared', text: `${i}`.repeat(480) }, 'user');
    e.agents.create({ id: 'scout', rolePrompt: '', modelId: 'sonnet' });
    const scouts = e.memories.add({ kind: 'rule', scope: 'agent:scout', text: 'S'.repeat(100) }, 'user');
    const move = e.cleanup.propose(card.id, { action: 'update', ids: [long.id], scope: 'shared', reason: 'everyone needs it' }, 'atlas').proposal;
    // Shared counts for scout too: 2526 + 480 > 3000. Atlas already counts it, so only scout is over.
    expect(() => e.cleanup.approve(move.id, 'user')).toThrow(/@scout would be 3006\/3000/);
    expect(e.memories.get(long.id).scope).toBe('agent:atlas');
    e.memories.forget(scouts.id, 'user');
    expect(e.cleanup.approve(move.id, 'user').status).toBe('approved');
    expect(e.memories.get(long.id).scope).toBe('shared');

    expect(() => e.cleanup.propose(card.id, { action: 'archive', ids: [m.a.id], text: 'x', reason: 'r' } as never, 'atlas')).toThrow(/only ids and a reason/);
    expect(() => e.cleanup.propose(card.id, { action: 'update', ids: [m.a.id], reason: 'r' }, 'atlas')).toThrow(/new text, kind or scope/);
  });

  it('only cleanup cards get the proposal tools', async () => {
    const fake = new FakeProvider([[{ type: 'text', text: 'ok' }]]);
    const e = await setup(fake, { dispatch: false });
    const card = e.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    e.kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'hi' }]);
    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    expect(fake.calls[0]!.tools.map((t) => t.name)).not.toContain('memory_propose');
  });

  it('a restart mid-run resumes cleanly: the interrupted proposal is filed once, the card finishes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const dbFile = join(dataDir, 'r.db');
    // First process: the run filed one proposal and died during its second memory_propose call.
    const first = await setup(new FakeProvider([]), { dbFile, dataDir, dispatch: false });
    const m = seed(first);
    first.cleanup.ensureSchedule(first.schedules, first.agents);
    first.schedules.update(CLEANUP_SCHEDULE, { enabled: false }); // only the card below
    const card = first.schedules.runNow(CLEANUP_SCHEDULE);
    first.kanban.update(card.id, { status: 'running' }, 'dispatcher');
    first.kanban.appendMessage(card.id, 'assistant', 'atlas', [
      { type: 'tool_use', id: 'k1', name: 'memory_propose', input: { action: 'archive', ids: [m.c.id], reason: 'card done' } },
      { type: 'tool_use', id: 'k2', name: 'memory_propose', input: { action: 'merge', ids: [m.a.id, m.b.id], text: 'npm: use nvm node 24', reason: 'dup' } },
    ]);
    first.cleanup.propose(card.id, { action: 'archive', ids: [m.c.id], reason: 'card done' }, 'atlas');
    first.db
      .prepare("INSERT INTO runs (id, card_id, agent_id, kind, status, started_at) VALUES ('r_dead', ?, 'atlas', 'work', 'running', ?)")
      .run(card.id, new Date().toISOString());
    first.db.close();
    engines = [];

    // Second process: the run resumes, the model re-sends both calls, then completes.
    const fake = new FakeProvider([
      [
        use('memory_propose', { action: 'archive', ids: [m.c.id], reason: 'card done' }),
        use('memory_propose', { action: 'merge', ids: [m.a.id, m.b.id], text: 'npm: use nvm node 24', reason: 'dup' }),
      ],
      (req) => {
        expect(lastResults(req).map((r) => r.content)).toEqual([expect.stringMatching(/^already proposed p1/), expect.stringMatching(/^proposed p2/)]);
        return [use('task_complete', { summary: '2 proposals' })];
      },
    ]);
    const second = await setup(fake, { dbFile, dataDir });
    await until(() => second.kanban.get(card.id).status === 'done', 'card done after restart');
    expect(JSON.stringify(fake.calls[0]!.messages)).toContain('interrupted by a restart or a stop');
    expect(second.runner.runs(card.id).map((r) => r.status).sort()).toEqual(['done', 'interrupted']);
    expect(second.cleanup.list().map((p) => [p.id, p.action, p.status])).toEqual([
      [1, 'archive', 'pending'],
      [2, 'merge', 'pending'],
    ]);
    expect(second.notifications.inbox().updates.filter((u) => u.kind === 'memory.cleanup').map((u) => u.title)).toEqual(['Memory cleanup: 2 proposals']);
    expect(second.memories.get(m.a.id).status).toBe('active'); // still nothing applied
  });
});
