import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDb } from './store/db.ts';
import { Models } from './models.ts';

let servers: Server[] = [];
afterEach(() => {
  servers.forEach((s) => s.close());
  servers = [];
});

/** An OpenAI-compatible server that answers chat calls, plus extra JSON routes (e.g. Ollama's /api/ps). */
async function server(routes: Record<string, unknown>): Promise<string> {
  const s = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'pong' }, finish_reason: 'stop' }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    if (req.url && req.url in routes) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(routes[req.url]));
    }
    res.writeHead(404).end();
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`;
}

describe('models: context window', () => {
  it('defaults by provider and can be edited', () => {
    const models = new Models(openDb(':memory:'));
    expect(models.create({ id: 'claude', provider: 'anthropic', name: 'c', credentialEnv: 'K' }).contextWindow).toBe(200_000);
    expect(models.create({ id: 'loc', provider: 'openai_compat', name: 'q', baseUrl: 'http://x/v1' }).contextWindow).toBe(32_768);
    expect(models.update('loc', { contextWindow: 65_536 }).contextWindow).toBe(65_536);
    expect(() => models.update('loc', { contextWindow: 100 })).toThrow();
  });

  it("detects Ollama's runtime window from /api/ps on test", async () => {
    const url = await server({ '/api/ps': { models: [{ name: 'other', context_length: 4096 }, { name: 'qwen3.8:27b', context_length: 32_768 }] } });
    const models = new Models(openDb(':memory:'));
    models.create({ id: 'ol', provider: 'openai_compat', name: 'qwen3.8:27b', baseUrl: url, contextWindow: 8192 });
    const t = await models.test('ol');
    expect(t).toMatchObject({ ok: true, detectedContextWindow: 32_768 });
    expect(models.get('ol').contextWindow).toBe(32_768);
  });

  it("detects llama.cpp's n_ctx from /props, and keeps the setting when a server reports nothing", async () => {
    const models = new Models(openDb(':memory:'));
    models.create({ id: 'll', provider: 'openai_compat', name: 'm', baseUrl: await server({ '/props': { default_generation_settings: { n_ctx: 131_072 } } }) });
    expect((await models.test('ll')).detectedContextWindow).toBe(131_072);
    expect(models.get('ll').contextWindow).toBe(131_072);

    models.create({ id: 'plain', provider: 'openai_compat', name: 'm', baseUrl: await server({}), contextWindow: 50_000 });
    expect(await models.test('plain')).toMatchObject({ ok: true, detectedContextWindow: null });
    expect(models.get('plain').contextWindow).toBe(50_000);
  });
});
