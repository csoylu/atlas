import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { MEMORY_BUDGET, type ContentBlock, type Memory, type MemoryChange } from '@atlas/shared';
import { migrate } from './store/db.ts';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { runTeamTool, type TeamToolContext } from './teamTools.ts';
import { isSimilar, terms } from './memory.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});
const V = (agentId: string, projectId = 'atlas') => ({ agentId, projectId });
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const start = async (fake = new FakeProvider([])) =>
  (engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, providers: () => fake, env: {} }));
const ctxFor = (e: Engine, agentId = 'atlas', workCard: string | null = null): TeamToolContext => ({
  kanban: e.kanban,
  memories: e.memories,
  workflows: e.workflows,
  agentId,
  cardId: workCard ?? 'c_x',
  workCard,
  source: null,
  deliver: () => {},
});

describe('memory v2: migration of the v1 text', () => {
  it('0033 turns every non-empty line into a rule of the same scope, indexed, and drops the old table', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'store', 'migrations');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.pragma('foreign_keys = OFF');
    for (const f of readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0033').sort()) {
      db.exec(readFileSync(join(dir, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, 'x');
    }
    db.pragma('foreign_keys = ON');
    const long = 'L'.repeat(700);
    db.prepare('INSERT INTO memory (agent_id, text, updated_by, updated_at) VALUES (?, ?, ?, ?)').run('atlas', `npm is not on PATH\r\n\n- Master likes Linear\n  \n${long}\n-`, 'atlas', '2026-11-10T08:00:00Z');
    db.prepare('INSERT INTO memory (agent_id, text, updated_by, updated_at) VALUES (?, ?, ?, ?)').run('shared', 'Repo is ~/atlas', 'user', '2026-11-11T08:00:00Z');
    db.prepare('INSERT INTO memory (agent_id, text, updated_by, updated_at) VALUES (?, ?, ?, ?)').run('munih', '', 'user', '2026-11-11T08:00:00Z');
    expect(migrate(db)).toContain('0033_memories.sql');
    expect(db.prepare('SELECT kind, scope, text, status, pinned, created_at, updated_by FROM memories ORDER BY id').all()).toEqual([
      { kind: 'rule', scope: 'agent:atlas', text: 'npm is not on PATH', status: 'active', pinned: 0, created_at: '2026-11-10T08:00:00Z', updated_by: 'atlas' },
      { kind: 'rule', scope: 'agent:atlas', text: 'Master likes Linear', status: 'active', pinned: 0, created_at: '2026-11-10T08:00:00Z', updated_by: 'atlas' },
      { kind: 'rule', scope: 'agent:atlas', text: long, status: 'active', pinned: 0, created_at: '2026-11-10T08:00:00Z', updated_by: 'atlas' },
      { kind: 'rule', scope: 'shared', text: 'Repo is ~/atlas', status: 'active', pinned: 0, created_at: '2026-11-11T08:00:00Z', updated_by: 'user' },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory'").get()).toBeUndefined();
    expect(db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'linear'").all()).toEqual([{ rowid: 2 }]);
  });
});

describe('memory v2: store', () => {
  it('adds, lists, searches, edits, archives and restores, logging each change; undo goes back one step', async () => {
    const e = await start();
    const m = e.memories;
    const a = m.add({ kind: 'fact', scope: 'agent:atlas', text: 'Prod ClickHouse is reachable through Teleport only' }, 'atlas', { conversationId: 'conv_x', seq: 4 });
    const b = m.add({ kind: 'rule', scope: 'shared', text: 'Run the tests before every commit' }, 'user');
    expect(a).toMatchObject({ kind: 'fact', status: 'active', pinned: false, sourceConversationId: 'conv_x', sourceSeq: 4, sourceCardId: null, updatedBy: 'atlas' });
    expect(m.list({ kind: 'rule' }).map((x) => x.id)).toEqual([b.id]);
    expect(m.list({ scope: 'agent:atlas' }).map((x) => x.id)).toEqual([a.id]);
    expect(m.list({ q: 'teleport' }).map((x) => x.id)).toEqual([a.id]);
    expect(m.list({ q: 'tests' }).map((x) => x.id)).toEqual([b.id]); // porter stemming: test = tests
    expect(() => m.add({ kind: 'fact', scope: 'agent:nobody', text: 'x' }, 'user')).toThrow(/agent nobody not found/);
    expect(() => m.add({ kind: 'fact', scope: 'shared', text: 'x'.repeat(501) }, 'user')).toThrow();

    m.update(a.id, { text: 'Prod ClickHouse: Teleport only, RW needs a 4h request' }, 'atlas');
    expect(m.list({ q: 'request' }).map((x) => x.id)).toEqual([a.id]); // the FTS index follows edits
    expect(m.list({ q: 'reachable' })).toEqual([]);
    const confirmed = m.update(a.id, { text: 'Prod ClickHouse: Teleport only, RW needs a 4h request' }, 'atlas');
    expect(confirmed.confirmedAt >= confirmed.updatedAt).toBe(true);
    m.forget(b.id, 'atlas');
    expect(m.get(b.id).status).toBe('archived');
    expect(m.alwaysOn(V('atlas'))).toEqual([]);
    m.update(b.id, { status: 'active' }, 'user');
    expect(m.alwaysOn(V('atlas')).map((x) => x.id)).toEqual([b.id]);

    const changes = m.changes('2000-01-01');
    expect(changes.map((c) => [c.memoryId, c.action])).toEqual([
      [b.id, 'restore'],
      [b.id, 'forget'],
      [a.id, 'confirm'],
      [a.id, 'update'],
      [b.id, 'add'],
      [a.id, 'add'],
    ]);
    // Only the latest change of a memory can be undone.
    const oldAdd = changes.find((c) => c.memoryId === b.id && c.action === 'add')!;
    expect(() => m.undo(oldAdd.id, 'user')).toThrow(/undo the newer change first/);
    const edit = changes.find((c) => c.action === 'update')!;
    expect(m.undo(edit.id, 'user').text).toBe('Prod ClickHouse is reachable through Teleport only');
    expect(() => m.undo(edit.id, 'user')).toThrow(/already undone/);
    const restore = changes[0]!;
    expect(m.undo(restore.id, 'user').status).toBe('archived');
    const c = m.add({ kind: 'fact', scope: 'shared', text: 'Something new' }, 'atlas');
    expect(m.undo(m.changes('2000-01-01')[0]!.id, 'user')).toMatchObject({ id: c.id, status: 'archived' }); // undo an add = archive
    expect(m.get(c.id)).toBeTruthy(); // never deleted
  });

  it('keeps the always-on memory within the budget, own + shared, and refuses writes past it', async () => {
    const e = await start();
    const m = e.memories;
    e.agents.create({ id: 'munih', modelId: e.agents.get('atlas').modelId });
    const rule = (n: number) => 'r'.repeat(n);
    for (let i = 0; i < 5; i++) m.add({ kind: 'rule', scope: 'agent:atlas', text: rule(500) }, 'atlas');
    expect(m.used(V('atlas'))).toBe(2500);
    m.add({ kind: 'preference', scope: 'agent:atlas', text: rule(400) }, 'atlas');
    expect(() => m.add({ kind: 'rule', scope: 'agent:atlas', text: rule(101) }, 'atlas')).toThrow(/3001\/3000.*Merge or shorten/s);
    // Facts aren't always on: no budget.
    const fact = m.add({ kind: 'fact', scope: 'agent:atlas', text: rule(500) }, 'atlas');
    expect(() => m.update(fact.id, { pinned: true }, 'user')).toThrow(/3400\/3000/);
    expect(() => m.update(fact.id, { kind: 'rule' }, 'user')).toThrow(/3400\/3000/);
    // Shared rows count for every agent: munih has room, atlas doesn't.
    expect(() => m.add({ kind: 'rule', scope: 'shared', text: rule(200) }, 'user')).toThrow(/@atlas would be 3100/);
    m.add({ kind: 'rule', scope: 'agent:munih', text: rule(200) }, 'user');
    expect(m.used(V('munih'))).toBe(200);
    // Forgetting makes room again; an agent already over the budget (v1 migration) can still shrink.
    const first = m.alwaysOn(V('atlas'))[0]!;
    m.forget(first.id, 'atlas');
    m.add({ kind: 'rule', scope: 'shared', text: rule(200) }, 'user');
    e.db.prepare("UPDATE memories SET text = ? WHERE id = ?").run(rule(1500), m.alwaysOn(V('atlas'))[0]!.id);
    expect(m.used(V('atlas'))).toBeGreaterThan(MEMORY_BUDGET);
    m.update(m.alwaysOn(V('atlas'))[0]!.id, { text: rule(100) }, 'atlas');
    expect(m.used(V('atlas'))).toBeLessThanOrEqual(MEMORY_BUDGET);
  });

  it('finds similar memories by shared keywords, not by common words', () => {
    expect(terms('The user LIKES short answers, the user!')).toEqual(['user', 'likes', 'short', 'answers']);
    expect(isSimilar('The user likes short answers', 'user likes answers that are short')).toBe(true);
    expect(isSimilar('Run tests before committing', 'run the tests before a commit')).toBe(true);
    expect(isSimilar('Run tests before committing', 'The orb is sea teal')).toBe(false);
    expect(isSimilar('npm is not on PATH', 'NPM is not on path ')).toBe(true);
  });
});

describe('memory v2: tools', () => {
  it('memory_add refuses while similar memories exist, until update: id or new: true', async () => {
    const e = await start();
    const ctx = ctxFor(e);
    expect(runTeamTool('memory_add', { kind: 'preference', text: 'The user likes short answers' }, ctx)).toMatchObject({ isError: false, output: expect.stringMatching(/^saved m1 \(preference, agent:atlas\) · always-on 28\/3000 chars$/) });
    const refused = runTeamTool('memory_add', { kind: 'preference', scope: 'shared', text: 'User likes answers that are short' }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.output).toMatch(/^Nothing saved: similar memories exist\.\n- \[m1 · preference · yours · \d{4}-\d\d-\d\d\] The user likes short answers\n.*update: <id>.*new: true/s);
    expect(e.memories.list()).toHaveLength(1);
    expect(runTeamTool('memory_add', { kind: 'preference', text: 'The user likes very short answers', update: 'm1' }, ctx).output).toMatch(/^updated m1/);
    expect(e.memories.get(1).text).toBe('The user likes very short answers');
    expect(runTeamTool('memory_add', { kind: 'fact', scope: 'shared', text: 'Short answers are also liked by the user in voice', new: true }, ctx).output).toMatch(/^saved m2 \(fact, shared\)/);
    // Unrelated text goes straight in.
    expect(runTeamTool('memory_add', { kind: 'fact', text: 'The orb is sea teal' }, ctx).isError).toBe(false);
  });

  it('update, forget and search work on own and shared memories only', async () => {
    const e = await start();
    e.agents.create({ id: 'munih', modelId: e.agents.get('atlas').modelId });
    const theirs = e.memories.add({ kind: 'fact', scope: 'agent:munih', text: 'Munih owns the billing service' }, 'munih');
    const shared = e.memories.add({ kind: 'fact', scope: 'shared', text: 'Billing service runs on port 4317' }, 'user');
    const ctx = ctxFor(e);
    expect(runTeamTool('memory_update', { id: theirs.id, text: 'x' }, ctx)).toMatchObject({ isError: true, output: expect.stringMatching(/belongs to agent:munih/) });
    expect(runTeamTool('memory_forget', { id: `m${theirs.id}` }, ctx).isError).toBe(true);
    expect(runTeamTool('memory_search', { query: 'billing' }, ctx).output).toBe(`- [m${shared.id} · fact · shared · ${shared.confirmedAt.slice(0, 10)}] Billing service runs on port 4317`);
    expect(runTeamTool('memory_update', { id: shared.id, text: 'Billing service runs on port 4317' }, ctx).output).toMatch(/^confirmed m2/);
    expect(runTeamTool('memory_update', { id: shared.id, text: 'Billing service runs on port 4318' }, ctx).output).toMatch(/^updated m2/);
    expect(runTeamTool('memory_forget', { id: 'm2' }, ctx).output).toMatch(/^forgot m2/);
    expect(runTeamTool('memory_search', { query: 'billing' }, ctx).output).toBe('no memory matches "billing"');
    expect(runTeamTool('memory_update', { id: 'nope', text: 'x' }, ctx)).toMatchObject({ isError: true, output: 'nope is not a memory id (m12)' });
  });
});

describe('memory v2: in the system prompt', () => {
  it('always shows rules/preferences, recalls the top facts matching the card, and drops project notes of ended cards', async () => {
    const fake = new FakeProvider([text('a'), text('b'), text('c')]);
    const e = await start(fake);
    const m = e.memories;
    m.add({ kind: 'rule', scope: 'agent:atlas', text: 'Reinstall the Mac app after every change' }, 'user');
    m.add({ kind: 'preference', scope: 'shared', text: 'Master loves the Linear look' }, 'user');
    m.add({ kind: 'fact', scope: 'agent:atlas', text: 'The orb overlay is drawn in apps/desktop/src/orb' }, 'atlas');
    m.add({ kind: 'fact', scope: 'agent:atlas', text: 'Billing runs on port 4317' }, 'atlas');
    for (let i = 0; i < 9; i++) m.add({ kind: 'fact', scope: 'shared', text: `Orb animation note ${i}` }, 'atlas');
    const card = e.kanban.create({ title: 'Orb animation stutters', body: 'The orb overlay drops frames', assignee: 'atlas', status: 'done' }, 'user');
    const project = m.add({ kind: 'project', scope: 'agent:atlas', text: 'Orb stutter: frame budget is 16ms, measured 40', cardId: card.id }, 'atlas');
    e.kanban.appendMessage(card.id, 'user', 'user', text('look'));
    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    const system = fake.calls[0]!.system;
    const tail = system.slice(fake.calls[0]!.cache!.systemStable);
    expect(tail).toMatch(/^# Memory\nAlways on \(rules, preferences, pinned: \d+\/3000 chars\)/);
    expect(tail).toContain('Yours:\n- [m1 · rule] Reinstall the Mac app after every change\nShared by all agents:\n- [m2 · preference] Master loves the Linear look');
    const recalled = tail.split('Recalled for this conversation')[1]!.split('\n\n')[0]!.split('\n').slice(1);
    expect(recalled).toHaveLength(8);
    expect(recalled.join('\n')).toContain('The orb overlay is drawn in apps/desktop/src/orb');
    expect(recalled.join('\n')).toMatch(new RegExp(`\\[m${project.id} · project · \\d{4}-\\d\\d-\\d\\d\\] Orb stutter`));
    expect(recalled.join('\n')).not.toContain('Billing');
    expect(recalled.join('\n')).not.toContain('Reinstall'); // already always on

    // Card closed → its project memory goes stale in the same change, out of recall.
    e.kanban.update(card.id, { status: 'ready' }, 'user');
    e.kanban.update(card.id, { status: 'closed' }, 'user');
    expect(m.get(project.id).status).toBe('stale');
    expect(m.changes('2000-01-01')[0]).toMatchObject<Partial<MemoryChange>>({ memoryId: project.id, action: 'stale', by: 'user' });
    expect(m.recall(V('atlas'), 'orb stutter frame').map((x) => x.id)).not.toContain(project.id);
    expect(m.search(V('atlas'), 'stutter').map((x) => [x.id, x.status])).toEqual([[project.id, 'stale']]); // memory_search still finds it
  });

  it('a project memory saved on a work card belongs to it and goes stale when it is done; a direct chat recalls on its first message', async () => {
    const fake = new FakeProvider([text('a')]);
    const e = await start(fake);
    const card = e.kanban.create({ title: 'Ship the DVOL ingest', assignee: 'atlas' }, 'user');
    const out = runTeamTool('memory_add', { kind: 'project', text: 'DVOL ingest: PR not opened yet' }, ctxFor(e, 'atlas', card.id));
    expect(out.output).toMatch(/until #\d+ ends/);
    const mem = e.memories.list()[0]!;
    expect(mem.cardId).toBe(card.id);
    e.kanban.update(card.id, { status: 'done' }, 'atlas');
    expect(e.memories.get(mem.id).status).toBe('stale');

    e.memories.add({ kind: 'fact', scope: 'shared', text: 'Teleport login: tsh login --proxy=teleport.example' }, 'user');
    const chat = e.kanban.newChat('atlas');
    e.kanban.appendMessage(chat.id, 'user', 'user', text('how do I log in to Teleport again?'));
    e.runner.wake(chat.id);
    await e.runner.settled(chat.id);
    expect(fake.calls[0]!.system).toMatch(/Recalled for this conversation[^\n]*\n- \[m2 · fact · \d{4}-\d\d-\d\d · shared\] Teleport login/);
  });
});

describe('memory v2: API', () => {
  it('lists with filters, adds, edits, pins, archives, restores and undoes', async () => {
    const e = await start();
    const u = e.url + '/api';
    const json = { 'content-type': 'application/json' };
    const call = async <T>(method: string, path: string, body?: unknown) => {
      const r = await fetch(u + path, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as T };
    };
    const made = await call<Memory>('POST', '/memories', { kind: 'fact', scope: 'shared', text: 'Repo is ~/atlas' });
    expect(made).toMatchObject({ status: 201, body: { kind: 'fact', scope: 'shared', updatedBy: 'user' } });
    expect((await call('POST', '/memories', { kind: 'nope', scope: 'shared', text: 'x' })).status).toBe(400);
    expect((await call('POST', '/memories', { kind: 'fact', scope: 'agent:ghost', text: 'x' })).status).toBe(404);
    const id = made.body.id;
    expect((await call<Memory>('PATCH', `/memories/${id}`, { pinned: true })).body.pinned).toBe(true);
    expect((await call<Memory>('PATCH', `/memories/m${id}`, { status: 'archived' })).body.status).toBe('archived');
    expect((await call<Memory[]>('GET', '/memories?status=archived')).body.map((x) => x.id)).toEqual([id]);
    expect((await call<Memory[]>('GET', '/memories?q=repo&scope=shared')).body.map((x) => x.id)).toEqual([id]);
    expect((await call<Memory[]>('GET', '/memories?kind=rule')).body).toEqual([]);
    expect((await call<Memory>('PATCH', `/memories/${id}`, { status: 'active' })).body.status).toBe('active');
    const changes = (await call<MemoryChange[]>('GET', '/memories/changes')).body;
    expect(changes.map((c) => c.action)).toEqual(['restore', 'forget', 'pin', 'add']);
    expect((await call<Memory>('POST', `/memories/changes/${changes[0]!.id}/undo`)).body.status).toBe('archived');
    expect((await call('POST', `/memories/changes/${changes[3]!.id}/undo`)).status).toBe(409);
    expect((await call('GET', '/memories/999')).status).toBe(404);
    expect((await call<{ used: number; limit: number }>('GET', '/agents/atlas/memory-budget')).body).toEqual({ used: 0, limit: 3000 });
  });
});
