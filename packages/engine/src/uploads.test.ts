import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ImageBlock, Upload } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { safeName, Uploads } from './uploads.ts';

const png = (w = 64, h = 48) => sharp({ create: { width: w, height: h, channels: 3, background: '#3366ff' } }).png().toBuffer();
let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});
async function start(fake: FakeProvider, dbFile: string, dataDir: string) {
  const e = await startEngine({ memoryReview: false, dbFile, dataDir, port: 0, dispatch: false, providers: () => fake, env: {} });
  engines.push(e);
  return e;
}
const upload = (e: Engine, card: string, name: string, body: Buffer) =>
  fetch(`${e.url}/api/cards/${card}/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(body) });
const send = (e: Engine, card: string, body: unknown) =>
  fetch(`${e.url}/api/cards/${card}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('uploads', () => {
  it('names files safely', () => {
    expect(safeName('Screenshot 2026-11-18 at 10.42.01.png')).toBe('Screenshot-2026-11-18-at-10-42-01');
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('.png')).toBe('image');
  });

  it('refuses what is not an image (by its bytes) and files over 10 MB, saying why', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const e = await start(new FakeProvider([]), ':memory:', dataDir);
    const card = e.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    const notImage = await upload(e, card.id, 'evil.png', Buffer.from('<script>alert(1)</script>'));
    expect(notImage.status).toBe(400);
    expect(((await notImage.json()) as { error: string }).error).toMatch(/evil\.png is not a png, jpeg, gif or webp image/);
    const big = await upload(e, card.id, 'big.png', Buffer.concat([await png(), Buffer.alloc(10 * 1024 * 1024)]));
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: string }).error).toMatch(/big\.png is 10\.0 MB: images over 10\.0 MB are refused/);
    const huge = await upload(e, card.id, 'huge.png', Buffer.alloc(11 * 1024 * 1024));
    expect(huge.status).toBe(413);
    expect(((await huge.json()) as { error: string }).error).toMatch(/over 10\.0 MB/);
    expect((await send(e, card.id, { text: '' })).status).toBe(400); // neither text nor image
    expect((await send(e, card.id, { text: 'x', uploads: ['up_missing'] })).status).toBe(404);
  });

  it('upload, restart, send: the image lands in the workspace, the message carries it, the model sees it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const db = join(dataDir, 'atlas.db');
    const fake = new FakeProvider([[{ type: 'text', text: 'A blue square.' }]]);
    let e = await start(fake, db, dataDir);
    const card = e.kanban.create({ title: 'Look', assignee: 'atlas' }, 'user');
    const res = await upload(e, card.id, 'Screen Shot.png', await png());
    expect(res.status).toBe(201);
    const up = (await res.json()) as Upload;
    expect(up).toMatchObject({ name: 'Screen Shot.png', media_type: 'image/png', width: 64, height: 48 });

    await e.stop();
    engines = [];
    e = await start(fake, db, dataDir);
    // Images only, no text: allowed.
    const sent = await send(e, card.id, { uploads: [up.id] });
    expect(sent.status).toBe(201);
    const msg = e.kanban.messages(card.id).at(-1)!;
    const img = msg.content[0] as ImageBlock;
    expect(img).toMatchObject({ type: 'image', media_type: 'image/png', width: 64, height: 48 });
    expect(img.data).toBeUndefined(); // no bytes in SQLite
    const date = new Date().toISOString().slice(0, 10);
    expect(img.path).toBe(join(dataDir, 'workspaces/atlas/uploads', `${date}-Screen-Shot.png`));
    expect(msg.content[1]).toEqual({ type: 'text', text: `[attached: uploads/${date}-Screen-Shot.png]` });
    expect(readdirSync(join(dataDir, 'uploads'))).toEqual([]); // staged copy gone
    // Sent once only.
    expect((await send(e, card.id, { text: 'again', uploads: [up.id] })).status).toBe(404);

    // The thumbnail route serves it (and nothing the conversation doesn't reference).
    const thumb = await fetch(`${e.url}/api/cards/${card.id}/image?path=${encodeURIComponent(img.path)}`);
    expect(thumb.status).toBe(200);
    expect(Buffer.from(await thumb.arrayBuffer()).equals(readFileSync(img.path))).toBe(true);
    expect((await fetch(`${e.url}/api/cards/${card.id}/image?path=${encodeURIComponent(db)}`)).status).toBe(404);

    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    const seen = fake.calls[0]!.messages.at(-1)!.content[0] as ImageBlock;
    expect(seen.type).toBe('image');
    expect(Buffer.from(seen.data!, 'base64').equals(readFileSync(img.path))).toBe(true);
    // The stored transcript still has no bytes.
    expect(JSON.stringify(e.kanban.messages(card.id))).not.toContain('"data"');
  });

  it('read_file of a screenshot goes to the model as a picture inside the tool result', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const fake = new FakeProvider([[{ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'shot.png' } }], [{ type: 'text', text: 'I see it.' }]]);
    const e = await start(fake, ':memory:', dataDir);
    const card = e.kanban.create({ title: 'Shot', assignee: 'atlas' }, 'user');
    const ws = join(dataDir, 'workspaces/atlas');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'shot.png'), await png(200, 100));
    e.kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'look at shot.png' }]);
    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    const tr = fake.calls[1]!.messages.at(-1)!.content[0]!;
    expect(tr).toMatchObject({ type: 'tool_result', tool_use_id: 'r1', images: [{ type: 'image', width: 200, height: 100, data: expect.any(String) }] });
  });

  it('prunes staged files nobody sent after a day', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const u = new Uploads(dataDir);
    const f = join(u.dir, 'up_x--old.png');
    mkdirSync(u.dir, { recursive: true });
    writeFileSync(f, 'x');
    const old = new Date(Date.now() - 2 * 86_400_000);
    utimesSync(f, old, old);
    expect(u.prune()).toBe(1);
    expect(existsSync(f)).toBe(false);
  });
});
