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

  it('refuses Running by hand on create and on update (only the dispatcher sets it)', async () => {
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false });
    const send = (method: string, path: string, body: unknown) =>
      fetch(engine!.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const created = await send('POST', '/api/cards', { title: 'x', status: 'running' });
    expect(created.status).toBe(400);
    expect(((await created.json()) as { error: string }).error).toMatch(/dispatcher when a run starts/);
    expect(engine.kanban.list()).toEqual([]);

    const card = (await (await send('POST', '/api/cards', { title: 'y', status: 'todo' })).json()) as Card;
    const events = () => engine!.db.prepare("SELECT COUNT(*) AS n FROM card_events WHERE card_id = ? AND kind = 'status'").get(card.id);
    const before = events();
    const moved = await send('PATCH', `/api/cards/${card.id}`, { status: 'running' });
    expect(moved.status).toBe(400);
    expect(((await moved.json()) as { error: string }).error).toMatch(/dispatcher when a run starts/);
    expect(engine.kanban.get(card.id).status).toBe('todo');
    expect(events()).toEqual(before);
    // The dispatcher path is untouched.
    expect(engine.kanban.update(card.id, { status: 'running' }, 'dispatcher').status).toBe('running');
  });

  it('refuses the removed claude_code provider on model create and update; legacy rows stay readable (#122)', async () => {
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, env: {} });
    const send = (method: string, path: string, body: unknown) =>
      fetch(engine!.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    type Issues = { error: string; issues: { path: string[]; message: string }[] };
    const ids = () => engine!.models.list().map((m) => m.id);
    const before = ids();

    // 1. Create is refused with a clear reason; no row is written.
    const created = await send('POST', '/api/models', { id: 'cc', provider: 'claude_code', name: 'x' });
    expect(created.status).toBe(400);
    const cBody = (await created.json()) as Issues;
    expect(cBody.issues[0]).toMatchObject({ path: ['provider'], message: expect.stringMatching(/claude_code was removed/) });
    expect(ids()).toEqual(before);

    // 2. Update to claude_code is refused; the row is unchanged. Other edits still work.
    expect((await send('POST', '/api/models', { id: 'own', provider: 'anthropic', name: 'claude-sonnet-5-5' })).status).toBe(201);
    const own = engine.models.get('own');
    const moved = await send('PATCH', '/api/models/own', { provider: 'claude_code' });
    expect(moved.status).toBe(400);
    expect(((await moved.json()) as Issues).issues[0]!.message).toMatch(/claude_code was removed/);
    expect(engine.models.get('own')).toEqual(own);
    expect((await send('PATCH', '/api/models/own', { name: 'claude-opus-5-5' })).status).toBe(200);

    // 3. A legacy row (seeded below the API) still lists, and still fails loudly when run.
    engine.models.create({ id: 'legacy', provider: 'claude_code', name: 'claude-opus-5-5' });
    const listed = (await (await fetch(engine.url + '/api/models')).json()) as { id: string; provider: string }[];
    expect(listed.find((m) => m.id === 'legacy')).toMatchObject({ provider: 'claude_code' });
    expect(() => engine!.models.provider('legacy')).toThrow(/needs CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY/);
    // Editing the legacy row without changing its provider is still possible (e.g. renaming it).
    expect((await send('PATCH', '/api/models/legacy', { name: 'old' })).status).toBe(200);
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
