import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEngine, type Engine } from './index.ts';
import type { Card, ServerEvent } from '@atlas/shared';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});

describe('api', () => {
  it('serves cards over REST and pushes events over the WebSocket', async () => {
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0 });
    const ws = new WebSocket(engine.url.replace('http', 'ws') + '/api/events');
    await new Promise((r) => ws.once('open', r));
    const got: ServerEvent[] = [];
    ws.on('message', (d) => got.push(JSON.parse(String(d))));

    const res = await fetch(engine.url + '/api/cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Build the canvas' }),
    });
    expect(res.status).toBe(201);
    const card = (await res.json()) as Card;

    const bad = await fetch(engine.url + '/api/cards/' + card.id, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'nope' }),
    });
    expect(bad.status).toBe(400);
    expect((await fetch(engine.url + '/api/cards/missing')).status).toBe(404);

    await fetch(engine.url + `/api/cards/${card.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'start with the board' }),
    });
    await new Promise((r) => setTimeout(r, 50));
    const types = got.map((e) => e.type);
    expect(types[0]).toBe('card.updated');
    expect(types).toContain('message.appended');
    ws.close();
  });

  it('shuts down promptly with a WebSocket still open', async () => {
    const e = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0 });
    const ws = new WebSocket(e.url.replace('http', 'ws') + '/api/events');
    await new Promise((r) => ws.once('open', r));
    const t0 = Date.now();
    await e.stop();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
