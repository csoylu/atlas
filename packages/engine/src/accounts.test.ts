import { describe, expect, it } from 'vitest';
import { openDb } from './store/db.ts';
import { Accounts, type ProviderMaker } from './accounts.ts';
import { AnthropicError } from './providers/anthropic.ts';
import type { ModelRequest, ModelResponse } from './providers/types.ts';

const req: ModelRequest = { model: 'claude-x', system: '', messages: [], tools: [], maxTokens: 10 };
const ok = (text: string): ModelResponse => ({ content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input: 100, output: 20 } });

class MemoryStore {
  label = 'test';
  m = new Map<string, string>();
  names = () => [...this.m.keys()];
  get = (n: string) => this.m.get(n);
  set = (n: string, v: string) => void this.m.set(n, v);
  delete = (n: string) => void this.m.delete(n);
}

/** Each key behaves as scripted: 'ok', 'rate' (429 with reset headers), 'auth' (401), 'bad' (400 request error), 'mid' (fails after text). */
function setup(behaviour: Record<string, 'ok' | 'rate' | 'auth' | 'bad' | 'mid'>, env: NodeJS.ProcessEnv = {}) {
  let t = Date.parse('2026-11-10T12:00:00Z');
  const calls: string[] = [];
  const reset = new Date(t + 90_000).toISOString();
  const make: ProviderMaker = (key, onHeaders) => ({
    complete: async (_r, onText) => {
      calls.push(key);
      const b = behaviour[key];
      const h = new Headers({
        'anthropic-ratelimit-requests-limit': '50',
        'anthropic-ratelimit-requests-remaining': b === 'rate' ? '0' : '49',
        'anthropic-ratelimit-requests-reset': reset,
        'anthropic-ratelimit-input-tokens-limit': '30000',
        'anthropic-ratelimit-input-tokens-remaining': '29900',
      });
      onHeaders(h);
      if (b === 'rate') throw new AnthropicError('Anthropic API error 429: rate_limit_error', true, 429, h);
      if (b === 'auth') throw new AnthropicError('Anthropic API error 401: invalid x-api-key', false, 401, h);
      if (b === 'bad') throw new AnthropicError('Anthropic API error 400: messages: field required', false, 400, h);
      if (b === 'mid') {
        onText('partial ');
        throw new AnthropicError('Anthropic API error 529: overloaded', true, 529, h);
      }
      onText('hi');
      return ok('hi from ' + key);
    },
  });
  const db = openDb(':memory:');
  const store = new MemoryStore();
  const accounts = new Accounts(db, env, store as never, make, () => t);
  return { accounts, calls, store, env, advance: (ms: number) => (t += ms), reset };
}

describe('anthropic accounts', () => {
  it('turns ANTHROPIC_API_KEY into the first account', () => {
    const { accounts } = setup({}, { ANTHROPIC_API_KEY: 'k0' });
    expect(accounts.list()).toMatchObject([{ label: 'Default', secret: 'ANTHROPIC_API_KEY', keyPresent: true, priority: 0 }]);
  });

  it('stores keys in the keychain, never in the table, and removes them with the account', () => {
    const { accounts, store, env } = setup({});
    const a = accounts.create({ label: 'Work', key: 'sk-ant-work-123' });
    expect(a).toMatchObject({ label: 'Work', keyPresent: true, priority: 0 });
    expect(JSON.stringify(accounts.list())).not.toContain('sk-ant-work-123');
    expect(store.get(a.secret)).toBe('sk-ant-work-123');
    expect(env[a.secret]).toBe('sk-ant-work-123');
    accounts.remove(a.id);
    expect(store.get(a.secret)).toBeUndefined();
  });

  it('fails over in priority order, cools a rate-limited account until its reset, keeps limits and usage', async () => {
    const { accounts, calls, advance, reset } = setup({ k1________: 'rate', k2________: 'ok' });
    const one = accounts.create({ label: 'Max', key: 'k1________' });
    const two = accounts.create({ label: 'Backup', key: 'k2________' });
    expect(accounts.list().map((a) => a.label)).toEqual(['Max', 'Backup']);

    const p = accounts.provider();
    const res = await p.complete(req, () => {}, AbortSignal.timeout(1000));
    expect(res.content).toEqual([{ type: 'text', text: 'hi from k2________' }]);
    expect(calls).toEqual(['k1________', 'k2________']);
    const [max, backup] = accounts.list();
    expect(max!.cooldownUntil).toBe(reset);
    expect(max!.lastError).toMatch(/429/);
    expect(max!.limits?.requests).toEqual({ limit: 50, remaining: 0, reset });
    expect(backup!.today).toEqual({ calls: 1, input: 100, output: 20 });
    expect(backup!.limits?.input).toMatchObject({ limit: 30000, remaining: 29900 });

    // While cooling down the first account is skipped; after the reset it's tried first again.
    calls.length = 0;
    await p.complete(req, () => {}, AbortSignal.timeout(1000));
    expect(calls).toEqual(['k2________']);
    advance(91_000);
    calls.length = 0;
    await p.complete(req, () => {}, AbortSignal.timeout(1000)).catch(() => {});
    expect(calls[0]).toBe('k1________');

    // Reorder: Backup first.
    accounts.reorder([two.id, one.id]);
    expect(accounts.list().map((a) => a.label)).toEqual(['Backup', 'Max']);
  });

  it('does not replay a call that already streamed text, nor a request the API rejects', async () => {
    const mid = setup({ m_________: 'mid', k2________: 'ok' });
    mid.accounts.create({ label: 'A', key: 'm_________' });
    mid.accounts.create({ label: 'B', key: 'k2________' });
    await expect(mid.accounts.provider().complete(req, () => {}, AbortSignal.timeout(1000))).rejects.toThrow(/529/);
    expect(mid.calls).toEqual(['m_________']);

    const bad = setup({ b_________: 'bad', k2________: 'ok' });
    bad.accounts.create({ label: 'A', key: 'b_________' });
    bad.accounts.create({ label: 'B', key: 'k2________' });
    await expect(bad.accounts.provider().complete(req, () => {}, AbortSignal.timeout(1000))).rejects.toThrow(/400/);
    expect(bad.calls).toEqual(['b_________']);
  });

  it('says why when every account is out', async () => {
    const { accounts } = setup({ a_________: 'auth', r_________: 'rate' });
    accounts.create({ label: 'Old key', key: 'a_________' });
    accounts.create({ label: 'Max', key: 'r_________' });
    const p = accounts.provider();
    await expect(p.complete(req, () => {}, AbortSignal.timeout(1000))).rejects.toThrow(/every Anthropic account failed: Old key: .*401.* \| Max: .*429/);
    await expect(p.complete(req, () => {}, AbortSignal.timeout(1000))).rejects.toThrow(/every Anthropic account is unavailable .*first one back at/);
    const none = setup({});
    expect(() => none.accounts.provider()).toThrow(/no Anthropic account/);
  });
});
