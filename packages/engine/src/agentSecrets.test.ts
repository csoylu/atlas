import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContentBlock, SecretInfo, SecretList } from '@atlas/shared';
import { eventually, launch } from '../test/kit/index.ts';
import type { ModelRequest } from './providers/types.ts';
import type { SecretStore } from './secrets.ts';

/** #206: agent secrets: metadata in SQLite, values in the store, given to shells by grant, hidden from every output. */

class MemoryStore implements SecretStore {
  label = 'test store';
  map = new Map<string, string>();
  failGet = false;
  failSet = false;
  names = () => [...this.map.keys()];
  get = (n: string) => {
    if (this.failGet) throw new Error('keychain locked');
    return this.map.get(n);
  };
  set = (n: string, v: string) => {
    if (this.failSet) throw new Error('keychain refused the write');
    this.map.set(n, v);
  };
  delete = (n: string) => void this.map.delete(n);
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const shell = (id: string, command: string, background = false): ContentBlock[] => [{ type: 'tool_use', id, name: 'shell', input: { command, background } }];
/** The tool results the model got in a request. */
const results = (req: ModelRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === 'tool_result' ? [b.content] : []));
const rev = (s: string) => [...s].reverse().join('');

const B = 'b-value-1234567890';
const C = 'c-value-abcdefghij';
const MODEL_KEY = 'sk-ant-model-key-0000000000';

async function setup(script: ConstructorParameters<typeof import('./providers/fake.ts').FakeProvider>[0]) {
  const store = new MemoryStore();
  store.set('ANTHROPIC_API_KEY', MODEL_KEY); // a model key from before #206
  store.set('CLAUDE_TOKENS', JSON.stringify({ accessToken: 'plan-access-token-xyz', refreshToken: 'plan-refresh-token-xyz', expiresAt: 1 }));
  const l = await launch({ script, secrets: store, dispatch: false, env: {} });
  for (const id of ['munih', 'zurich']) l.engine.agents.create({ id, rolePrompt: '', modelId: 'sonnet' } as Parameters<typeof l.engine.agents.create>[0]);
  const post = (name: string, value: string, grant: string, agents: string[] = [], description = '') =>
    l.call<SecretInfo>('POST', '/secrets', { name, value, grant, agents, description });
  expect((await post('S_A', 'a-value-1234567890', 'none')).status).toBe(201);
  expect((await post('S_B', B, 'agents', ['atlas'], 'Etherscan API key')).status).toBe(201);
  expect((await post('S_C', C, 'all')).status).toBe(201);
  expect((await post('S_D', 'd-value-1234567890', 'agents', ['munih'])).status).toBe(201);
  return { ...l, store };
}

async function run(l: Awaited<ReturnType<typeof setup>>, msg = 'go') {
  const card = l.engine.kanban.create({ title: 'secrets', assignee: 'atlas' }, 'user');
  l.engine.kanban.appendMessage(card.id, 'user', 'user', text(msg));
  l.engine.runner.wake(card.id);
  await l.engine.runner.settled(card.id);
  return card;
}

describe('agent secrets', () => {
  it('API: create, list, edit, rotate, delete; no response ever holds a value; names fixed; model keys never granted', async () => {
    const l = await setup([]);
    const bodies: string[] = [];
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(l.api + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const t = await r.text();
      bodies.push(t);
      return { status: r.status, body: t ? JSON.parse(t) : null };
    };
    const list = (await call('GET', '/secrets')).body as SecretList;
    expect(list.store).toBe('test store');
    expect(list.names).toEqual(['ANTHROPIC_API_KEY', 'S_A', 'S_B', 'S_C', 'S_D']); // plan tokens never listed
    const byName = Object.fromEntries(list.secrets.map((s) => [s.name, s]));
    expect(Object.keys(byName).sort()).toEqual(['ANTHROPIC_API_KEY', 'S_A', 'S_B', 'S_C', 'S_D']);
    expect(byName.ANTHROPIC_API_KEY).toMatchObject({ kind: 'model_key', grant: 'none', hasValue: true, createdBy: 'user' });
    expect(byName.S_B).toMatchObject({ kind: 'agent', project: null, grant: 'agents', agents: ['atlas'], description: 'Etherscan API key', hasValue: true, lastUsedAt: null });

    expect((await call('PATCH', '/secrets/S_A', { grant: 'agents', agents: ['zurich'], description: 'new' })).body).toMatchObject({ grant: 'agents', agents: ['zurich'], description: 'new' });
    expect((await call('PATCH', '/secrets/S_A', { name: 'S_Z' })).status).toBe(400); // no rename
    expect((await call('PATCH', '/secrets/S_A', { grant: 'agents', agents: [] })).status).toBe(409);
    expect((await call('PATCH', '/secrets/S_A', { grant: 'agents', agents: ['ghost'] })).status).toBe(409);
    expect((await call('PATCH', '/secrets/ANTHROPIC_API_KEY', { grant: 'all' })).status).toBe(409);
    expect((await call('PATCH', '/secrets/ANTHROPIC_API_KEY', { description: 'Work account' })).body).toMatchObject({ description: 'Work account', grant: 'none' });
    expect((await call('POST', '/secrets', { name: 'ANTHROPIC_API_KEY', value: 'x'.repeat(12) })).status).toBe(409);
    expect((await call('POST', '/secrets', { name: 'CLAUDE_TOKENS', value: 'x'.repeat(12) })).status).toBe(409);
    expect((await call('POST', '/secrets', { name: 'S_B', value: 'x'.repeat(12) })).status).toBe(409);
    expect((await call('POST', '/secrets', { name: 'bad-name', value: 'x'.repeat(12) })).status).toBe(400);
    expect((await call('POST', '/secrets', { name: 'PATH', value: 'x'.repeat(12) })).status).toBe(409);
    expect((await call('PATCH', '/secrets/NOPE', { description: 'x' })).status).toBe(404);

    expect((await call('PUT', '/secrets/S_B', { value: 'rotated-value-123456' })).status).toBe(204);
    expect(l.store.map.get('S_B')).toBe('rotated-value-123456');
    expect((await call('DELETE', '/secrets/S_C')).status).toBe(204);
    expect(l.store.map.has('S_C')).toBe(false);
    const after = (await call('GET', '/secrets')).body as SecretList;
    expect(after.secrets.map((s) => s.name)).not.toContain('S_C');

    // A model key added the old way (API keys page) gets its row; deleting it removes both.
    expect((await call('PUT', '/secrets/OPENROUTER_API_KEY', { value: 'or-key-1234567890' })).status).toBe(204);
    expect(((await call('GET', '/secrets')).body as SecretList).secrets.find((s) => s.name === 'OPENROUTER_API_KEY')).toMatchObject({ kind: 'model_key' });

    const all = bodies.join('\n');
    for (const v of [B, C, MODEL_KEY, 'rotated-value-123456', 'or-key-1234567890', 'a-value-1234567890', 'plan-access-token-xyz']) expect(all).not.toContain(v);
  });

  it('a store write that fails leaves no row; a row whose value is missing (crash) shows « no value » and fails loudly when used', async () => {
    const l = await setup([
      shell('t1', 'echo "$S_B" > used.txt'),
      shell('t2', 'echo ok'),
      text('done'),
    ]);
    l.store.failSet = true;
    expect((await l.call('POST', '/secrets', { name: 'S_E', value: 'e-value-1234567890' })).status).toBe(500);
    l.store.failSet = false;
    expect((await l.call<SecretList>('GET', '/secrets')).body.secrets.map((s) => s.name)).not.toContain('S_E');

    // A crash between the row and the value: the row stays, with no value.
    l.store.map.delete('S_B');
    l.engine.secrets.sync();
    expect((await l.call<SecretList>('GET', '/secrets')).body.secrets.find((s) => s.name === 'S_B')).toMatchObject({ hasValue: false, kind: 'agent' });
    await run(l);
    const [first, second] = [results(l.fake.calls[1]!), results(l.fake.calls[2]!)];
    expect(first[0]).toMatch(/secret S_B has no value: add it in Settings → Secrets/);
    expect(existsSync(join(l.workdir, 'used.txt'))).toBe(false);
    expect(second[0]).toBe('exit 0\nok\n'); // a command that doesn't use it still runs
  });

  it('grants decide what a command gets; model keys and plan tokens never; a rotation applies to the next command; last used is recorded', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', MODEL_KEY); // server mode: the model key is in the engine's own environment
    vi.stubEnv('ATLAS_PASSWORD', 'server-password-123');
    let l!: Awaited<ReturnType<typeof setup>>;
    l = await setup([
      shell('t1', "env | cut -d= -f1 | grep -E '^(S_|ANTHROPIC|CLAUDE_TOKENS|ATLAS_PASSWORD)' | sort | tr '\\n' ' '"),
      shell('t2', 'printf "%s" "$S_B" | rev'),
      () => {
        l.store.set('S_B', 'rotated-value-123456');
        return shell('t3', 'printf "%s" "$S_B" | rev');
      },
      shell('t4', 'echo "$S_D" > ran.txt'),
      text('done'),
      // second run: a background command
      shell('b1', 'printf "%s" "$S_C" | rev > bg.txt', true),
      text('started'),
      text('noted'), // the exit note wakes the agent
    ]);
    await run(l);
    vi.unstubAllEnvs();
    expect(results(l.fake.calls[1]!)[0]).toBe('exit 0\nS_B S_C ');
    expect(results(l.fake.calls[2]!)[0]).toBe(`exit 0\n${rev(B)}\n`);
    expect(results(l.fake.calls[3]!)[0]).toBe(`exit 0\n${rev('rotated-value-123456')}\n`);
    expect(results(l.fake.calls[4]!)[0]).toBe('secret S_D is not granted to atlas: ask the user to grant it in Settings → Secrets');
    expect(existsSync(join(l.workdir, 'ran.txt'))).toBe(false);
    const s = (await l.call<SecretList>('GET', '/secrets')).body.secrets;
    expect(s.find((x) => x.name === 'S_B')).toMatchObject({ lastUsedBy: 'atlas' });
    expect(s.find((x) => x.name === 'S_C')!.lastUsedAt).toBeNull(); // injected but not used by these commands

    // Background commands get them too.
    await run(l, 'again');
    await eventually(() => {
      expect(existsSync(join(l.workdir, 'bg.txt'))).toBe(true);
      expect(readFileSync(join(l.workdir, 'bg.txt'), 'utf8')).toBe(rev(C) + '\n');
    }, { timeout: 5000, what: 'the background command to write bg.txt' });
  });

  it('every secret value is hidden from what the model receives and from the stored transcript; the count reaches the UI', async () => {
    const l = await setup([
      shell('t1', 'echo "key=$S_B and again $S_B"'),
      [{ type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'leak.txt' } }],
      shell('t3', 'seq 1 20000; echo "long $S_C"'),
      text('done'),
    ]);
    // A file holding a model key, another agent's secret and a plan token: hidden even though atlas has none of them.
    writeFileSync(join(l.workdir, 'leak.txt'), `model ${MODEL_KEY}\nother d-value-1234567890\nplan plan-access-token-xyz\n`);
    const card = await run(l);
    expect(results(l.fake.calls[1]!)[0]).toBe('exit 0\nkey=[secret S_B] and again [secret S_B]\n');
    const read = results(l.fake.calls[2]!)[0]!;
    expect(read).toContain('model [secret ANTHROPIC_API_KEY]');
    expect(read).toContain('other [secret S_D]');
    expect(read).toContain('plan [secret CLAUDE_TOKENS]');
    // A long output is saved to a file: that file is redacted too.
    const long = results(l.fake.calls[3]!)[0]!;
    const saved = long.match(/the full output is in (\S+)/)![1]!;
    expect(readFileSync(saved, 'utf8')).toContain('long [secret S_C]');

    const stored = JSON.stringify(l.engine.db.prepare('SELECT content FROM messages').all()) + JSON.stringify(l.engine.db.prepare('SELECT output FROM tool_calls').all());
    for (const v of [B, C, MODEL_KEY, 'd-value-1234567890', 'plan-access-token-xyz']) {
      expect(stored).not.toContain(v);
      for (const req of l.fake.calls) expect(JSON.stringify(req)).not.toContain(v);
    }
    const calls = l.engine.runner.toolCalls(card.id);
    expect(calls.map((c) => c.secretsHidden ?? 0)).toEqual([2, 3, 1]);
    expect((await l.call<{ secretsHidden?: number }[]>('GET', `/cards/${card.id}/tool-calls`)).body.map((c) => c.secretsHidden ?? 0)).toEqual([2, 3, 1]);
  });

  it('an unreadable store stops the command and withholds outputs, with a clear error', async () => {
    let l!: Awaited<ReturnType<typeof setup>>;
    l = await setup([
      () => {
        l.store.failGet = true;
        return shell('t1', 'echo "$S_B" > ran.txt');
      },
      text('done'),
    ]);
    await run(l);
    const r = results(l.fake.calls[1]!)[0]!;
    expect(r).toMatch(/secret store \(test store\)|could not be read/);
    expect(r).toContain('keychain locked');
    expect(existsSync(join(l.workdir, 'ran.txt'))).toBe(false);
  });

  it("the agent's instructions list its secrets' names and descriptions, never a value", async () => {
    const l = await setup([text('hi')]);
    await run(l);
    const system = l.fake.calls[0]!.system;
    expect(system).toContain('# Secrets');
    expect(system).toContain('- $S_B: Etherscan API key');
    expect(system).toContain('- $S_C');
    expect(system).not.toContain('S_A');
    expect(system).not.toContain('S_D');
    expect(system).not.toContain('ANTHROPIC_API_KEY');
    for (const v of [B, C, MODEL_KEY]) expect(system).not.toContain(v);
  });

  it('a restart keeps grants and metadata; a value without a row is read back as a model key, never as an agent secret', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-sec-'));
    const dbFile = join(dataDir, 'atlas.db');
    const store = new MemoryStore();
    const a = await launch({ dbFile, dataDir, secrets: store, dispatch: false, env: {} });
    expect((await a.call('POST', '/secrets', { name: 'S_B', value: B, grant: 'all', description: 'kept' })).status).toBe(201);
    await a.engine.stop();
    store.set('LEGACY_KEY', 'legacy-key-1234567890'); // e.g. written by an older Atlas
    const b = await launch({ dbFile, dataDir, secrets: store, dispatch: false, env: {}, script: [shell('t1', 'printf "%s" "$S_B" | rev; echo " $LEGACY_KEY."'), text('done')] });
    const list = (await b.call<SecretList>('GET', '/secrets')).body.secrets;
    expect(list.find((s) => s.name === 'S_B')).toMatchObject({ kind: 'agent', grant: 'all', description: 'kept', hasValue: true });
    expect(list.find((s) => s.name === 'LEGACY_KEY')).toMatchObject({ kind: 'model_key', grant: 'none' });
    const card = b.engine.kanban.create({ title: 'after restart', assignee: 'atlas' }, 'user');
    b.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    b.engine.runner.wake(card.id);
    await b.engine.runner.settled(card.id);
    expect(results(b.fake.calls[1]!)[0]).toBe(`exit 0\n${rev(B)}\n .\n`);
  });
});
