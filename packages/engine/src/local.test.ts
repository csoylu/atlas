import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalPull, ServerEvent } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import type { Provider } from './providers/types.ts';

/**
 * A fake `ollama` binary: `serve` starts a tiny server on OLLAMA_HOST that speaks the parts of Ollama's API Atlas uses,
 * and records OLLAMA_CONTEXT_LENGTH so the test can check it was passed.
 */
const FAKE = `#!/usr/bin/env node
const http = require('node:http');
const [host, port] = process.env.OLLAMA_HOST.split(':');
const ctx = Number(process.env.OLLAMA_CONTEXT_LENGTH);
const models = [{ name: 'qwen3:8b', size: 5e9, modified_at: '2026-11-01T10:00:00Z', capabilities: ['completion', 'tools'], details: { family: 'qwen3', parameter_size: '8.2B', quantization_level: 'Q4_K_M' } }];
let loaded = [];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const j = body ? JSON.parse(body) : {};
    const send = (o) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(o)));
    if (req.url === '/api/version') return send({ version: '9.9.9' });
    if (req.url === '/test/env') return send({ maxLoaded: process.env.OLLAMA_MAX_LOADED_MODELS });
    if (req.url === '/api/tags') return send({ models });
    if (req.url === '/api/ps') return send({ models: loaded });
    if (req.url === '/api/generate') { loaded = loaded.filter((m) => m.name !== j.model); if (j.keep_alive !== 0) loaded.push({ name: j.model, size_vram: 6e9, context_length: ctx, expires_at: '2318-01-01T00:00:00Z' }); return send({ done: true }); }
    if (req.url === '/api/delete') { const i = models.findIndex((m) => m.name === j.model); if (i < 0) { res.statusCode = 404; return res.end('{}'); } models.splice(i, 1); return send({}); }
    if (req.url === '/api/pull') {
      if (j.model.includes('missing')) { res.write(JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\\n'); return res.end(); }
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\\n');
      res.write(JSON.stringify({ status: 'downloading', completed: 50, total: 100 }) + '\\n');
      res.write(JSON.stringify({ status: 'success' }) + '\\n');
      models.push({ name: j.model, size: 100, modified_at: '2026-11-10T10:00:00Z', details: {} });
      return res.end();
    }
    if (req.url === '/v1/chat/completions') { res.setHeader('content-type', 'text/event-stream'); res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }) + '\\n\\n'); return res.end('data: [DONE]\\n\\n'); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(Number(port), host);
`;

function fakeBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-ollama-'));
  const bin = join(dir, 'ollama');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  return bin;
}
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}
const json = { 'content-type': 'application/json' };

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});

describe('local model server', () => {
  it('starts Ollama itself, downloads, loads, wires a model for agents, starts on demand, stops', async () => {
    const port = await freePort();
    const events: ServerEvent[] = [];
    // A provider that records calls, so we see the server was started before the call reached it.
    let calls = 0;
    const providers = (): Provider => ({
      complete: async () => {
        calls++;
        return { content: [{ type: 'text', text: 'hi' }], stopReason: 'end', usage: { input: 1, output: 1 } };
      },
    });
    engine = await startEngine({
      dbFile: ':memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'atlas-')),
      port: 0,
      dispatch: false,
      providers,
      local: { url: `http://127.0.0.1:${port}`, binary: fakeBinary() },
    });
    engine.bus.on((e) => events.push(e));
    const api = (method: string, path: string, body?: unknown) =>
      fetch(engine!.url + '/api/local' + path, { method, headers: body ? json : undefined, body: body ? JSON.stringify(body) : undefined });

    expect(((await (await api('GET', '')).json()) as { running: boolean }).running).toBe(false);
    expect((await api('PATCH', '', { contextLength: 65536 })).status).toBe(200);
    const started = (await (await api('POST', '/start')).json()) as { running: boolean; owner: string; version: string };
    expect(started).toMatchObject({ running: true, owner: 'atlas', version: '9.9.9' });

    // Download from the Ollama library: progress events, then it's installed.
    await api('POST', '/pull', { name: 'gemma4:12b' });
    await expect.poll(() => events.some((e) => e.type === 'local.pull' && e.pull.done), { timeout: 5000 }).toBe(true);
    const pulls = events.filter((e): e is { type: 'local.pull'; pull: LocalPull } => e.type === 'local.pull').map((e) => e.pull);
    expect(pulls.at(-1)).toMatchObject({ done: true, error: null, status: 'success' });
    const bad = (await (await api('POST', '/pull', { name: 'missing:1b' })).json()) as LocalPull;
    expect(bad.name).toBe('missing:1b');
    await expect.poll(() => pulls.length < events.filter((e) => e.type === 'local.pull').length, { timeout: 5000 }).toBe(true);
    await expect
      .poll(() => events.some((e) => e.type === 'local.pull' && e.pull.name === 'missing:1b' && e.pull.done && /check the name/.test(e.pull.error ?? '')), { timeout: 5000 })
      .toBe(true);
    expect((await api('POST', '/pull', { name: 'rm -rf /' })).status).toBe(400);
    // Hugging Face repos are refused with the reason (only the Ollama library is used).
    const hf = await api('POST', '/pull', { name: 'hf.co/unsloth/Qwen3-8B-GGUF:Q4_K_M' });
    expect(hf.status).toBe(400);
    expect(JSON.stringify(await hf.json())).toMatch(/Hugging Face models are not used/);

    // Load: the context length set above reached the server.
    expect((await api('POST', '/load', { name: 'qwen3:8b' })).status).toBe(204);
    const list = (await (await api('GET', '/models')).json()) as { models: { name: string; loaded: { contextLength: number; until: string | null } | null }[] };
    expect(list.models.find((m) => m.name === 'qwen3:8b')?.loaded).toMatchObject({ contextLength: 65536, until: null });

    // One model in memory at a time: the server is told so, and loading another unloads the first.
    expect(await (await fetch(`http://127.0.0.1:${port}/test/env`)).json()).toEqual({ maxLoaded: '1' });
    expect((await api('POST', '/load', { name: 'other:1b' })).status).toBe(204);
    expect((await (await fetch(`http://127.0.0.1:${port}/api/ps`)).json()) as { models: { name: string }[] }).toMatchObject({ models: [{ name: 'other:1b' }] });
    expect((await api('POST', '/load', { name: 'qwen3:8b' })).status).toBe(204);
    expect(((await (await fetch(`http://127.0.0.1:${port}/api/ps`)).json()) as { models: { name: string }[] }).models.map((m) => m.name)).toEqual(['qwen3:8b']);

    // Use it: an Atlas model pointing at the server; deleting the Ollama model is refused while it's used.
    const model = (await (await api('POST', '/use', { name: 'qwen3:8b' })).json()) as { id: string; baseUrl: string; contextWindow: number };
    expect(model).toMatchObject({ id: 'qwen3-8b', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 65536 });
    expect(((await (await api('POST', '/use', { name: 'qwen3:8b' })).json()) as { id: string }).id).toBe('qwen3-8b');
    expect((await api('DELETE', '/models?name=qwen3%3A8b')).status).toBe(409);
    expect((await api('DELETE', '/models?name=' + encodeURIComponent('gemma4:12b'))).status).toBe(204);

    // Stopped server + a call to the local model: started on demand, then the call goes through.
    await api('POST', '/stop');
    expect(engine.local.status().running).toBe(false);
    const { provider } = engine.models.provider('qwen3-8b');
    await provider.complete({ model: 'qwen3:8b', system: '', messages: [], tools: [], maxTokens: 1 }, () => {}, AbortSignal.timeout(20_000));
    expect(calls).toBe(1);
    expect(engine.local.status()).toMatchObject({ running: true, owner: 'atlas' });

    // Autostart off: the call fails with a clear reason instead.
    await api('PATCH', '', { autostart: false });
    await api('POST', '/stop');
    await expect(provider.complete({ model: 'qwen3:8b', system: '', messages: [], tools: [], maxTokens: 1 }, () => {}, AbortSignal.timeout(5000))).rejects.toThrow(
      /stopped/,
    );
  }, 60_000);

  it('says how to install when there is no binary', async () => {
    engine = await startEngine({
      dbFile: ':memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'atlas-')),
      port: 0,
      dispatch: false,
      local: { url: `http://127.0.0.1:${await freePort()}`, binary: null },
    });
    const res = await fetch(engine.url + '/api/local/start', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/not installed/);
  });
});
