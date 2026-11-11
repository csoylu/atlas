import { afterEach, describe, expect, it, vi } from 'vitest';
import { Models } from './models.ts';
import { openDb } from './store/db.ts';

afterEach(() => vi.unstubAllGlobals());

describe('legacy Claude subscription requests', () => {
  function models(env: NodeJS.ProcessEnv) {
    const db = openDb(':memory:');
    const models = new Models(db, undefined, env);
    models.create({ id: 'subscription', provider: 'claude_code', name: 'claude-opus-5-5', baseUrl: 'https://example.test' });
    return { db, models };
  }

  it.each([true, false])('sends the right authentication and hardcoded client identity (OAuth=%s)', async (oauth) => {
    const calls: { url: string; headers: Headers }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'test rejection' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }));
    const { db, models: m } = models({ ANTHROPIC_API_KEY: 'test-key', ...(oauth ? { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' } : {}) });
    try {
      expect(m.get('subscription').credentialPresent).toBe(true);
      const result = await m.test('subscription');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('test rejection');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://example.test/v1/messages');
      const h = calls[0]!.headers;
      expect(h.get('user-agent')).toBe('claude-code/2.1.322');
      expect(h.get('authorization')).toBe(oauth ? 'Bearer test-token' : null);
      expect(h.get('x-api-key')).toBe(oauth ? null : 'test-key');
      expect(h.get('anthropic-beta')).toBe(oauth ? 'oauth-2025-04-20' : null);
    } finally {
      db.close();
    }
  });

  it('fails clearly when no credentials are available', () => {
    const { db, models: m } = models({});
    try {
      expect(() => m.provider('subscription')).toThrow('needs CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY');
    } finally {
      db.close();
    }
  });
});
