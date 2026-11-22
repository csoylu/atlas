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
  it('serves the Library: pin, folders (delete → Unfiled), move, search', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    engine = await startEngine({ dbFile: ':memory:', dataDir, port: 0, dispatch: false });
    const send = (method: string, path: string, body?: unknown) =>
      fetch(engine!.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const doc = engine.documents.create('atlas', { kind: 'markdown', title: 'Spec', content: '# Spec\nThe version picker.' }, 'atlas');
    const lib = (await (await fetch(engine.url + '/api/documents')).json()) as { id: string }[];
    expect(lib.map((d) => d.id)).toEqual([doc.id]);
    expect(await (await send('POST', `/api/documents/${doc.id}/pin`, { pinned: true })).json()).toMatchObject({ id: doc.id, pinned: true });
    expect((await send('POST', `/api/documents/${doc.id}/pin`, { pinned: 'yes' })).status).toBe(400);
    expect((await send('POST', '/api/documents/doc_none/pin', { pinned: true })).status).toBe(404);

    const f = (await (await send('POST', '/api/folders', { name: 'Data feeds' })).json()) as { id: string; name: string };
    expect((await send('POST', '/api/folders', { name: 'data feeds' })).status).toBe(409);
    expect((await send('POST', '/api/folders', { name: ' ' })).status).toBe(400);
    expect(await (await send('POST', `/api/documents/${doc.id}/move`, { folderId: f.id })).json()).toMatchObject({ folderId: f.id });
    expect((await send('POST', `/api/documents/${doc.id}/move`, { folderId: 3 })).status).toBe(400);
    expect(await (await send('PATCH', `/api/folders/${f.id}`, { name: 'Feeds' })).json()).toMatchObject({ name: 'Feeds' });
    expect((await send('DELETE', `/api/folders/${f.id}`)).status).toBe(204);
    expect(await (await fetch(engine.url + '/api/folders')).json()).toEqual([]);
    expect(engine.documents.get(doc.id).folderId).toBeNull();

    const hits = (await (await fetch(engine.url + '/api/documents/search?q=picker')).json()) as { doc: { id: string }; snippet: string }[];
    expect(hits).toEqual([{ doc: expect.objectContaining({ id: doc.id }), snippet: expect.stringContaining('version picker') }]);
    expect((await send('GET', '/api/canvases')).status).not.toBe(200);
  });

  it('reports the version and data folder for Settings → About', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    engine = await startEngine({ dbFile: ':memory:', dataDir, port: 0, version: '1.2.3' });
    expect(await (await fetch(engine.url + '/api/about')).json()).toEqual({ version: '1.2.3', dataDir, server: false, voice: false, shellPath: { path: process.env.PATH ?? '', source: 'engine', shell: null, error: null } });
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

  it('refuses an unknown model provider on create and update, writing nothing (#122, #341)', async () => {
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, env: {} });
    const send = (method: string, path: string, body: unknown) =>
      fetch(engine!.url + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    type Issues = { error: string; issues: { path: string[]; message: string }[] };
    const ids = () => engine!.models.list().map((m) => m.id);
    const before = ids();

    const created = await send('POST', '/api/models', { id: 'cc', provider: 'cli_subscription', name: 'x' });
    expect(created.status).toBe(400);
    expect(((await created.json()) as Issues).issues[0]).toMatchObject({ path: ['provider'] });
    expect(ids()).toEqual(before);

    expect((await send('POST', '/api/models', { id: 'own', provider: 'anthropic', name: 'claude-sonnet-5-5' })).status).toBe(201);
    const own = engine.models.get('own');
    expect((await send('PATCH', '/api/models/own', { provider: 'cli_subscription' })).status).toBe(400);
    expect(engine.models.get('own')).toEqual(own);
    expect((await send('PATCH', '/api/models/own', { name: 'claude-opus-5-5' })).status).toBe(200);
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
