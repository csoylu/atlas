import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContentBlock, SecretInfo, SecretList } from '@atlas/shared';
import { eventually, launch } from '../test/kit/index.ts';
import type { ModelRequest } from './providers/types.ts';
import type { SecretStore } from './secrets.ts';

/** #207: secret_set / secret_delete, and « needs secret X » on task_block. */

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
const rev = (s: string) => [...s].reverse().join('');
const MODEL_KEY = 'sk-ant-model-key-0000000000';

async function setup(script: ConstructorParameters<typeof import('./providers/fake.ts').FakeProvider>[0], more: Partial<Parameters<typeof launch>[0]> = {}) {
  const store = more.secrets instanceof MemoryStore ? more.secrets : new MemoryStore();
  if (!store.map.size) store.set('ANTHROPIC_API_KEY', MODEL_KEY);
  const l = await launch({ script, secrets: store, dispatch: false, env: {}, ...more });
  return { ...l, store };
}

async function run(l: Awaited<ReturnType<typeof setup>>, msg = 'go') {
  const card = l.engine.kanban.create({ title: 'secrets', assignee: 'atlas' }, 'user');
  l.engine.kanban.appendMessage(card.id, 'user', 'user', text(msg));
  l.engine.runner.wake(card.id);
  await l.engine.runner.settled(card.id);
  return card;
}

/** Everything stored about the conversation: messages, tool calls (input and output). */
const stored = (l: Awaited<ReturnType<typeof setup>>) =>
  JSON.stringify(l.engine.db.prepare('SELECT content FROM messages').all()) + JSON.stringify(l.engine.db.prepare('SELECT input, output FROM tool_calls').all());
const info = async (l: Awaited<ReturnType<typeof setup>>, name: string) =>
  (await l.call<SecretList>('GET', '/secrets')).body.secrets.find((s) => s.name === name);

describe('secret_set and secret_delete', () => {
  it('command form: the output is stored unseen, granted to its creator only, usable as $NAME; failures store nothing', async () => {
    const V = 'gen-secret-value-1234567';
    const l = await setup([
      use('t1', 'secret_set', { name: 'GEN_KEY', description: 'made by a command', command: 'cat key.txt' }),
      use('t2', 'shell', { command: 'printf "%s" "$GEN_KEY" | rev' }),
      use('t3', 'secret_set', { name: 'BAD_KEY', command: 'cat key.txt; echo "oops: no keychain item" >&2; exit 3' }),
      use('t4', 'secret_set', { name: 'EMPTY_KEY', command: 'true' }),
      use('t5', 'secret_set', { name: 'BOTH', command: 'echo x', value: 'y' }),
      use('t6', 'secret_set', { name: 'NEITHER' }),
      text('done'),
    ]);
    writeFileSync(join(l.workdir, 'key.txt'), `  ${V}\n`); // e.g. a keychain lookup's output
    const card = await run(l);
    expect(results(l.fake.calls[1]!)[0]).toBe('stored GEN_KEY, 24 chars, granted to you only. Use it as $GEN_KEY in shell commands.');
    expect(l.store.get('GEN_KEY')).toBe(V);
    expect(results(l.fake.calls[2]!)[0]).toBe(`exit 0\n${rev(V)}\n`);
    const bad = results(l.fake.calls[3]!)[0]!;
    expect(bad).toMatch(/exited with 3: nothing stored/);
    expect(bad).toContain('oops: no keychain item');
    expect(results(l.fake.calls[4]!)[0]).toMatch(/printed nothing/);
    expect(results(l.fake.calls[5]!)[0]).toMatch(/exactly one of command or value/);
    expect(results(l.fake.calls[6]!)[0]).toMatch(/exactly one of command or value/);
    for (const n of ['BAD_KEY', 'EMPTY_KEY', 'BOTH', 'NEITHER']) {
      expect(l.store.get(n)).toBeUndefined();
      expect(await info(l, n)).toBeUndefined();
    }
    expect(await info(l, 'GEN_KEY')).toMatchObject({ kind: 'agent', grant: 'agents', agents: ['atlas'], createdBy: 'atlas', createdCard: card.id, description: 'made by a command', hasValue: true });
    // The value never reached the provider, the transcript or the tool calls.
    for (const req of l.fake.calls) expect(JSON.stringify(req)).not.toContain(V);
    expect(stored(l)).not.toContain(V);
    // Granted to atlas only: listed in its instructions from the next turn on, never to another agent.
    expect(l.fake.calls[2]!.system).toContain('- $GEN_KEY: made by a command');
    expect(l.engine.secrets.granted('zurich', 'atlas').map((s) => s.name)).not.toContain('GEN_KEY');
  });

  it('value form: stored, and [secret NAME] in the stored tool call and in every later request', async () => {
    const V = 'typed-secret-value-98765';
    const l = await setup([use('t1', 'secret_set', { name: 'TYPED_KEY', value: V }), use('t2', 'shell', { command: 'printf "%s" "$TYPED_KEY"' }), text('done')]);
    await run(l);
    expect(l.store.get('TYPED_KEY')).toBe(V);
    expect(results(l.fake.calls[1]!)[0]).toMatch(/^stored TYPED_KEY, 24 chars/);
    expect(results(l.fake.calls[2]!)[0]).toBe('exit 0\n[secret TYPED_KEY]');
    expect(stored(l)).not.toContain(V);
    expect(stored(l)).toContain('[secret TYPED_KEY]');
    // The provider saw it only in its own answer: no later request carries it.
    for (const req of l.fake.calls.slice(1)) expect(JSON.stringify(req)).not.toContain(V);
  });

  it("ownership: an agent overwrites and deletes only its own secrets, never the user's, another agent's or a model key", async () => {
    const l = await setup([
      use('t1', 'secret_set', { name: 'MINE', value: 'mine-value-000000001' }),
      use('t2', 'secret_set', { name: 'MINE', value: 'mine-value-000000002', description: 'rotated' }),
      use('t3', 'secret_set', { name: 'USERS', value: 'overwrite-attempt-1' }),
      use('t4', 'secret_set', { name: 'ZURICHS', value: 'overwrite-attempt-2' }),
      use('t5', 'secret_set', { name: 'ANTHROPIC_API_KEY', value: 'overwrite-attempt-3' }),
      use('t6', 'secret_delete', { name: 'USERS' }),
      use('t7', 'secret_delete', { name: 'ZURICHS' }),
      use('t8', 'secret_delete', { name: 'ANTHROPIC_API_KEY' }),
      use('t9', 'secret_set', { name: 'PATH', value: 'overwrite-attempt-4' }),
      use('t10', 'secret_delete', { name: 'MINE' }),
      text('done'),
    ]);
    l.engine.agents.create({ id: 'zurich', rolePrompt: '', modelId: 'sonnet' } as Parameters<typeof l.engine.agents.create>[0]);
    expect((await l.call('POST', '/secrets', { name: 'USERS', value: 'user-value-123456789', grant: 'all' })).status).toBe(201);
    l.engine.secrets.agentSet('zurich', 'atlas', null, 'ZURICHS', 'zurich-value-12345678');
    await run(l);
    const r = (i: number) => results(l.fake.calls[i]!)[0]!;
    expect(r(1)).toMatch(/^stored MINE/);
    expect(r(2)).toMatch(/^stored MINE, 20 chars \(replaced its value\)/);
    expect(r(3)).toMatch(/USERS belongs to the user/);
    expect(r(4)).toMatch(/ZURICHS belongs to @zurich/);
    expect(r(5)).toMatch(/ANTHROPIC_API_KEY is a model key/);
    expect(r(6)).toMatch(/USERS belongs to the user/);
    expect(r(7)).toMatch(/ZURICHS belongs to @zurich/);
    expect(r(8)).toMatch(/model key/);
    expect(r(9)).toMatch(/PATH is a variable every shell needs/);
    expect(r(10)).toBe('deleted MINE');
    expect(l.store.get('USERS')).toBe('user-value-123456789');
    expect(l.store.get('ZURICHS')).toBe('zurich-value-12345678');
    expect(l.store.get('ANTHROPIC_API_KEY')).toBe(MODEL_KEY);
    expect(l.store.get('MINE')).toBeUndefined();
    expect(await info(l, 'MINE')).toBeUndefined();
  });
});

describe('needs secret X (task_block with secret)', () => {
  const V = 'dune-api-key-abcdef123456';
  const blockThenUse = () => [
    use('t1', 'task_block', { kind: 'capability', question: 'I need a Dune API key to run the query.', secret: 'DUNE_API_KEY', secret_description: 'Dune Analytics API key' }),
    use('t2', 'shell', { command: 'printf "%s" "$DUNE_API_KEY" | rev' }),
    use('t3', 'task_complete', { summary: 'ran it' }),
  ];

  it('blocks with a « no value » row; adding the value restarts the task by itself; Dismiss deletes the row', async () => {
    const l = await setup(blockThenUse(), { dispatch: true });
    const card = l.engine.kanban.create({ title: 'dune query', assignee: 'atlas' }, 'user');
    await eventually(() => l.engine.kanban.get(card.id).status === 'blocked', { timeout: 8000, what: 'the task to block' });
    const c = l.engine.kanban.get(card.id);
    expect(c.block).toMatchObject({ kind: 'capability' });
    expect(c.block!.reason).toContain('Needs secret DUNE_API_KEY');
    expect(await info(l, 'DUNE_API_KEY')).toMatchObject<Partial<SecretInfo>>({ kind: 'agent', hasValue: false, grant: 'agents', agents: ['atlas'], createdBy: 'atlas', createdCard: card.id, waitingCard: card.id, description: 'Dune Analytics API key' });

    expect((await l.call('PUT', '/secrets/DUNE_API_KEY', { value: V })).status).toBe(204);
    await eventually(() => l.engine.kanban.get(card.id).status === 'done', { timeout: 8000, what: 'the task to resume and finish' });
    expect(JSON.stringify(l.fake.calls[1]!.messages.at(-1))).toContain('The secret DUNE_API_KEY now has a value');
    expect(results(l.fake.calls[2]!)[0]).toBe(`exit 0\n${rev(V)}\n`);
    expect(await info(l, 'DUNE_API_KEY')).toMatchObject({ hasValue: true, waitingCard: null });

    // Dismiss: another request, deleted without a value.
    l.engine.secrets.need('atlas', 'atlas', card.id, 'OTHER_KEY');
    expect(await info(l, 'OTHER_KEY')).toMatchObject({ hasValue: false });
    expect((await l.call('DELETE', '/secrets/OTHER_KEY')).status).toBe(204);
    expect(await info(l, 'OTHER_KEY')).toBeUndefined();
  });

  it('refuses a model key, a dependency block, and a secret the agent already has', async () => {
    const l = await setup([
      use('t1', 'task_block', { kind: 'capability', question: 'q', secret: 'ANTHROPIC_API_KEY' }),
      use('t2', 'task_block', { kind: 'transient', question: 'q', secret: 'X_KEY' }),
      use('t3', 'task_block', { kind: 'capability', question: 'q', secret: 'HAVE_IT' }),
      text('ok'),
    ]);
    expect((await l.call('POST', '/secrets', { name: 'HAVE_IT', value: 'have-it-value-1234567', grant: 'all' })).status).toBe(201);
    const card = await run(l);
    expect(results(l.fake.calls[1]!)[0]).toMatch(/model key/);
    expect(results(l.fake.calls[2]!)[0]).toMatch(/kind capability/);
    expect(results(l.fake.calls[3]!)[0]).toMatch(/already has a value and is granted to you/);
    expect(l.engine.kanban.get(card.id).status).not.toBe('blocked');
    expect(await info(l, 'X_KEY')).toBeUndefined();
  });

  it('restart-safe: the row survives a restart, and a value written just before a crash resumes the task at start', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-sec7-'));
    const dbFile = join(dataDir, 'atlas.db');
    const store = new MemoryStore();
    const a = await setup(blockThenUse().slice(0, 1), { dbFile, dataDir, secrets: store, dispatch: true });
    const card = a.engine.kanban.create({ title: 'dune query', assignee: 'atlas' }, 'user');
    await eventually(() => a.engine.kanban.get(card.id).status === 'blocked', { timeout: 8000, what: 'the task to block' });
    await a.engine.stop();
    // The value reached the store, then the engine died before the task moved.
    store.set('DUNE_API_KEY', V);
    const b = await setup(blockThenUse().slice(1), { dbFile, dataDir, secrets: store, dispatch: true });
    await eventually(() => b.engine.kanban.get(card.id).status === 'done', { timeout: 8000, what: 'the task to resume after the restart' });
    expect(results(b.fake.calls[1]!)[0]).toBe(`exit 0\n${rev(V)}\n`);
    expect(await info(b, 'DUNE_API_KEY')).toMatchObject({ kind: 'agent', hasValue: true, waitingCard: null, createdBy: 'atlas' });
  });
});
