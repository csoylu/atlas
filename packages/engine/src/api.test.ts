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
  it('serves the Library: canvases as whiteboards, pin, and the whiteboard of a canvas', async () => {
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false });
    const post = (path: string, body: unknown) =>
      fetch(engine!.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const canvas = (await (await post('/api/canvases', { name: 'Sketch' })).json()) as { id: string };
    const doc = (await (await post(`/api/canvases/${canvas.id}/document`, {})).json()) as { id: string; kind: string; agentId: string };
    expect(doc).toMatchObject({ kind: 'whiteboard', agentId: 'user' });
    const lib = (await (await fetch(engine.url + '/api/documents')).json()) as { id: string }[];
    expect(lib.map((d) => d.id)).toEqual([doc.id]);
    expect(await (await post(`/api/documents/${doc.id}/pin`, { pinned: true })).json()).toMatchObject({ id: doc.id, pinned: true });
    expect((await post(`/api/documents/${doc.id}/pin`, { pinned: 'yes' })).status).toBe(400);
    expect((await post('/api/documents/doc_none/pin', { pinned: true })).status).toBe(404);
  });

  it('reports the version and data folder for Settings → About', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    engine = await startEngine({ dbFile: ':memory:', dataDir, port: 0, version: '1.2.3' });
    expect(await (await fetch(engine.url + '/api/about')).json()).toEqual({ version: '1.2.3', dataDir, server: false, voice: false });
  });

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
