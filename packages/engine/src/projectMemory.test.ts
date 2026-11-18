import { describe, expect, it } from 'vitest';
import { MEMORY_BUDGET, MEMORY_BUDGET_GLOBAL, type ContentBlock, type Memory, type SecretList } from '@atlas/shared';
import { launch } from '../test/kit/index.ts';
import type { ModelRequest } from './providers/types.ts';
import type { SecretStore } from './secrets.ts';

/** #215: memory and secrets per project. A run in project B sees nothing of project A, and global everywhere. */

class MemoryStore implements SecretStore {
  label = 'test store';
  map = new Map<string, string>();
  names = () => [...this.map.keys()];
  get = (n: string) => this.map.get(n);
  set = (n: string, v: string) => void this.map.set(n, v);
  delete = (n: string) => void this.map.delete(n);
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id, name, input }];
const results = (req: ModelRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));

const A_SHARED = 'Atlas repo lives in publish-atlas, never push to main';
const A_OWN = 'Atlas engine port changes at every launch';
const A_FACT = 'Atlas ClickHouse sandbox answers on port 9440';
const GLOBAL_PREF = 'Master wants short answers in English';
const A_SECRET = 'atlas-only-secret-value-1234';
const B_SECRET = 'datinel-secret-value-98765';
const G_SECRET = 'global-secret-value-55555';

async function twoProjects(script: ContentBlock[][]) {
  const store = new MemoryStore();
  const l = await launch({ script, secrets: store, dispatch: false, env: {}, memoryReview: false });
  const e = l.engine;
  const datinel = e.projects.create({ name: 'Datinel', repo: null, lead: 'atlas', members: [] });
  const add = (m: Parameters<typeof e.memories.add>[0]) => e.memories.add(m, 'user');
  const a = {
    shared: add({ kind: 'rule', scope: 'shared', projectId: 'atlas', text: A_SHARED }),
    own: add({ kind: 'rule', scope: 'agent:atlas', projectId: 'atlas', text: A_OWN }),
    fact: add({ kind: 'fact', scope: 'shared', projectId: 'atlas', text: A_FACT }),
  };
  const g = add({ kind: 'preference', scope: 'global', text: GLOBAL_PREF });
  const call = l.call;
  expect((await call('POST', '/secrets', { name: 'A_KEY', value: A_SECRET, grant: 'all', project: 'atlas' })).status).toBe(201);
  expect((await call('POST', '/secrets', { name: 'B_KEY', value: B_SECRET, grant: 'all', project: 'Datinel' })).status).toBe(201);
  expect((await call('POST', '/secrets', { name: 'G_KEY', value: G_SECRET, grant: 'all' })).status).toBe(201);
  return { ...l, store, datinel, a, g };
}

describe('memory and secrets per project (#215)', () => {
  it('a run in project B sees no project-A memory or secret in its prompt, tool results or env; global ones everywhere', async () => {
    const l = await twoProjects([
      use('t1', 'memory_search', { query: 'ClickHouse port' }),
      use('t2', 'memory_update', { id: 'm1', text: 'hijacked' }),
      use('t3', 'shell', { command: 'echo "A=[$A_KEY] B=[$B_KEY] G=[$G_KEY]"; env | grep -c _KEY=' }),
      use('t4', 'memory_add', { kind: 'fact', scope: 'shared', text: 'Datinel ingests DVOL every hour' }),
      use('t5', 'secret_set', { name: 'NEW_KEY', value: 'new-secret-value-424242' }),
      text('done'),
    ]);
    const e = l.engine;
    const card = e.kanban.create({ title: 'ClickHouse port check', body: 'which port does ClickHouse answer on', projectId: 'datinel', assignee: 'atlas' }, 'user');
    e.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    e.runner.wake(card.id);
    await e.runner.settled(card.id);

    const everything = JSON.stringify(l.fake.calls);
    for (const leak of [A_SHARED, A_OWN, A_FACT, A_SECRET]) expect(everything).not.toContain(leak);
    const system = l.fake.calls[0]!.system;
    expect(system).not.toContain('A_KEY'); // not even its name (the command below names it itself)
    expect(system).toContain(`Global (the user's own rules and preferences, every project):\n- [m${l.g.id} · preference] ${GLOBAL_PREF}`);
    expect(system).toContain('$B_KEY');
    expect(system).toContain('$G_KEY');
    expect(results(l.fake.calls[1]!)[0]).toBe('no memory matches "ClickHouse port"');
    expect(results(l.fake.calls[2]!)[0]).toBe('memory m1 not found');
    expect(e.memories.get(l.a.shared.id).text).toBe(A_SHARED);
    // The env holds B's and the global secret, never A's (the output is redacted: names, not values).
    expect(results(l.fake.calls[3]!)[0]).toBe('exit 0\nA=[] B=[[secret B_KEY]] G=[[secret G_KEY]]\n2\n');
    // Written from B: in B.
    expect(results(l.fake.calls[4]!)[0]).toMatch(/^saved m\d+ \(fact, shared\)/);
    const added = e.memories.list({ q: 'DVOL' })[0]!;
    expect(added).toMatchObject<Partial<Memory>>({ scope: 'shared', projectId: 'datinel' });
    const secrets = (await l.call<SecretList>('GET', '/secrets?project=datinel')).body.secrets.map((s) => s.name).sort();
    expect(secrets).toEqual(['B_KEY', 'NEW_KEY']);
    expect((await l.call<SecretList>('GET', '/secrets?project=global')).body.secrets.map((s) => s.name)).toContain('G_KEY');
    expect((await l.call<SecretList>('GET', '/secrets?project=global')).body.secrets.map((s) => s.name)).not.toContain('A_KEY');

    // A run in Atlas does not see B's new memory or secret.
    expect(e.memories.search({ agentId: 'atlas', projectId: 'atlas' }, 'DVOL')).toEqual([]);
    expect(e.secrets.granted('atlas', 'atlas').map((s) => s.name).sort()).toEqual(['A_KEY', 'G_KEY']);
    const env = e.secrets.envFor('atlas', 'atlas', { B_KEY: 'from-the-engine-env' }, 'echo');
    expect(env.B_KEY).toBeUndefined();
    expect(env.A_KEY).toBe(A_SECRET);
    // A's own budget is untouched by B's memories; global counts in both.
    expect(e.memories.used({ agentId: 'atlas', projectId: 'atlas' })).toBe(A_SHARED.length + A_OWN.length + GLOBAL_PREF.length);
    expect(e.memories.used({ agentId: 'atlas', projectId: 'datinel' })).toBe(GLOBAL_PREF.length);
  });

  it('a change in project A reaches only runs of A as a [memory] note; recall in B never returns A facts', async () => {
    const l = await twoProjects([text('first'), text('second')]);
    const e = l.engine;
    const card = e.kanban.create({ title: 'ClickHouse sandbox', projectId: 'datinel', assignee: 'atlas', board: 'direct' } as never, 'user');
    e.kanban.appendMessage(card.id, 'user', 'user', text('ClickHouse sandbox port?'));
    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    e.memories.update(l.a.shared.id, { text: A_SHARED + ' (checked)' }, 'user');
    e.kanban.appendMessage(card.id, 'user', 'user', text('and now?'));
    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    expect(JSON.stringify(l.fake.calls)).not.toContain('publish-atlas');
    expect(e.memories.recall({ agentId: 'atlas', projectId: 'datinel' }, 'ClickHouse sandbox port').map((m) => m.id)).toEqual([]);
    expect(e.memories.recall({ agentId: 'atlas', projectId: 'atlas' }, 'ClickHouse sandbox port').map((m) => m.id)).toEqual([l.a.fact.id]);
  });

  it('budget: global counts for every project and has its own cap; a project fills only its own members', async () => {
    const l = await twoProjects([]);
    const m = l.engine.memories;
    const r = (n: number, c = 'r') => c.repeat(n);
    // Global up to MEMORY_BUDGET_GLOBAL, then refused.
    for (let used = m.usedGlobal(); used + 500 <= MEMORY_BUDGET_GLOBAL; used += 500) m.add({ kind: 'rule', scope: 'global', text: r(500, String(used % 7)) }, 'user');
    const room = MEMORY_BUDGET_GLOBAL - m.usedGlobal();
    expect(() => m.add({ kind: 'rule', scope: 'global', text: r(room + 1, 'g') }, 'user')).toThrow(/global always-on memory .* would be \d+\/2000/);
    // Datinel has the rest of the per-run budget, Atlas has less (its own memories).
    const inB = MEMORY_BUDGET - m.used({ agentId: 'atlas', projectId: 'datinel' });
    m.add({ kind: 'rule', scope: 'shared', projectId: 'datinel', text: r(Math.min(inB, 500), 'b') }, 'user');
    expect(m.used({ agentId: 'atlas', projectId: 'atlas' })).toBe(m.usedGlobal() + A_SHARED.length + A_OWN.length);
    // A global rule that would push a project over the per-run budget is refused, naming that project.
    const fillA = MEMORY_BUDGET - m.used({ agentId: 'atlas', projectId: 'atlas' });
    for (let left = fillA; left > 0; left -= 500) m.add({ kind: 'rule', scope: 'shared', projectId: 'atlas', text: r(Math.min(500, left), String(left % 9)) }, 'user');
    expect(m.used({ agentId: 'atlas', projectId: 'atlas' })).toBe(MEMORY_BUDGET);
    const left = MEMORY_BUDGET_GLOBAL - m.usedGlobal();
    if (left > 0) expect(() => m.add({ kind: 'rule', scope: 'global', text: r(left, 'z') }, 'user')).toThrow(/@atlas in Atlas would be/);
  });

  it('PATCH /api/memories/:id moves a memory to global and back; undo restores its project', async () => {
    const l = await twoProjects([]);
    const moved = await l.call<Memory>('PATCH', `/memories/${l.a.shared.id}`, { scope: 'global' });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ scope: 'global', projectId: null });
    expect(l.engine.memories.alwaysOn({ agentId: 'atlas', projectId: 'datinel' }).map((x) => x.id)).toContain(l.a.shared.id);
    const change = l.engine.memories.changes('2000-01-01')[0]!;
    expect(l.engine.memories.undo(change.id, 'user')).toMatchObject({ scope: 'shared', projectId: 'atlas' });
    expect((await l.call('PATCH', `/memories/${l.a.own.id}`, { scope: 'global', projectId: 'atlas' })).status).toBe(400);
    expect((await l.call<Memory[]>('GET', '/memories?project=datinel')).body.map((x) => x.projectId)).toEqual([]);
    expect((await l.call<Memory[]>('GET', '/memories?scope=global')).body.map((x) => x.id)).toEqual([l.g.id]);
  });
});
