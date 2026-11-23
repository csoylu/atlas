import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { fileLine, parseFileLine, type ImageBlock, type Upload } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { safeExt, safeName, Uploads } from './uploads.ts';

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
    expect(safeName('..\\..\\Windows\\evil.dll')).toBe('evil');
    expect(safeName('.png', 'image')).toBe('image');
    expect(safeName('.env')).toBe('file');
    expect(safeExt('report.PDF')).toBe('pdf');
    expect(safeExt('archive.tar.gz')).toBe('gz');
    expect(safeExt('Makefile')).toBe('');
    expect(safeExt('x.p/../../y')).toBe('');
    expect(safeExt('x.<script>')).toBe('');
  });

  it('takes any file up to 100 MB; a picture is read from its bytes, the rest is a file; over 100 MB is refused, nothing staged', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const e = await start(new FakeProvider([]), ':memory:', dataDir);
    const card = e.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    const notImage = await upload(e, card.id, 'evil.png', Buffer.from('<script>alert(1)</script>'));
    expect(notImage.status).toBe(201);
    expect(await notImage.json()).toMatchObject({ kind: 'file', name: 'evil.png', bytes: 25 });
    const pdf = await upload(e, card.id, 'Q3 report.pdf', Buffer.from('%PDF-1.7 test'));
    expect(await pdf.json()).toMatchObject({ kind: 'file', media_type: 'application/pdf' });
    const picture = await upload(e, card.id, 'shot', await png()); // no extension: its bytes say png
    expect(await picture.json()).toMatchObject({ kind: 'image', media_type: 'image/png' });
    const bigPicture = await upload(e, card.id, 'big.png', Buffer.concat([await png(), Buffer.alloc(10 * 1024 * 1024)]));
    expect(await bigPicture.json()).toMatchObject({ kind: 'file' }); // over the picture limit: a file the agent opens
    const before = readdirSync(join(dataDir, 'uploads')).length;
    const huge = await upload(e, card.id, 'mainnet.parquet', Buffer.alloc(100 * 1024 * 1024 + 1));
    expect(huge.status).toBe(400);
    expect(((await huge.json()) as { error: string }).error).toBe('mainnet.parquet is 100.0 MB: files over 100 MB are refused');
    expect(readdirSync(join(dataDir, 'uploads'))).toHaveLength(before); // nothing staged, no .part left
    expect((await send(e, card.id, { text: '' })).status).toBe(400); // neither text nor file
    expect((await send(e, card.id, { text: 'x', uploads: ['up_missing'] })).status).toBe(404);
  });

  it('a stream past 100 MB (no length told) is cut off, its part file removed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const u = new Uploads(dataDir);
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    const body = Readable.from((function* () {
      for (let i = 0; i < 13; i++) yield chunk;
    })());
    await expect(u.stage('dump.bin', body)).rejects.toThrow('dump.bin is over 100 MB: files over 100 MB are refused');
    expect(readdirSync(u.dir)).toEqual([]);
  });

  it('exactly 100 MB is taken', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const e = await start(new FakeProvider([]), ':memory:', dataDir);
    const card = e.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    const res = await upload(e, card.id, 'logs.zip', Buffer.alloc(100 * 1024 * 1024));
    expect(res.status).toBe(201);
    const up = (await res.json()) as Upload;
    expect(up).toMatchObject({ kind: 'file', bytes: 100 * 1024 * 1024, media_type: 'application/zip' });
    expect((await send(e, card.id, { uploads: [up.id] })).status).toBe(201);
    const date = new Date().toISOString().slice(0, 10);
    expect(statSync(join(dataDir, 'workspaces/atlas/uploads', `${date}-logs.zip`)).size).toBe(100 * 1024 * 1024);
  });

  it('files: placed in uploads/, named to the agent in one line (never sent as bytes), restart-safe between the two steps', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const db = join(dataDir, 'atlas.db');
    const fake = new FakeProvider([[{ type: 'text', text: 'Got them.' }]]);
    let e = await start(fake, db, dataDir);
    const card = e.kanban.create({ title: 'Files', assignee: 'atlas' }, 'user');
    const csv = (await (await upload(e, card.id, 'q3 volumes.csv', Buffer.from('date,chain\n2026-07-01,solana\n'))).json()) as Upload;
    const bare = (await (await upload(e, card.id, 'README', Buffer.from('no extension here'))).json()) as Upload;
    const zip = (await (await upload(e, card.id, '../../evil/../logs.zip', Buffer.from('PK\x03\x04 not really'))).json()) as Upload;
    const pic = (await (await upload(e, card.id, 'board.png', await png())).json()) as Upload;
    expect([csv.kind, bare.kind, zip.kind, pic.kind]).toEqual(['file', 'file', 'file', 'image']);

    // Killed between staging and sending: everything is still there after a restart.
    await e.stop();
    engines = [];
    e = await start(fake, db, dataDir);
    const sent = await send(e, card.id, { text: 'the numbers', uploads: [csv.id, pic.id, bare.id, zip.id] });
    expect(sent.status).toBe(201);
    const date = new Date().toISOString().slice(0, 10);
    const ws = join(dataDir, 'workspaces/atlas');
    expect(readdirSync(join(ws, 'uploads')).sort()).toEqual([`${date}-README`, `${date}-board.png`, `${date}-logs.zip`, `${date}-q3-volumes.csv`].sort());
    expect(readFileSync(join(ws, 'uploads', `${date}-q3-volumes.csv`), 'utf8')).toBe('date,chain\n2026-07-01,solana\n');
    expect(readdirSync(join(dataDir, 'uploads'))).toEqual([]); // staged copies gone
    const msg = e.kanban.messages(card.id).at(-1)!;
    const texts = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
    // Pictures first (as today), then a line per file, in the order sent.
    expect(msg.content.map((b) => b.type)).toEqual(['text', 'image', 'text', 'text', 'text', 'text']);
    expect(texts.slice(2)).toEqual([
      fileLine(`uploads/${date}-q3-volumes.csv`, 29),
      fileLine(`uploads/${date}-README`, 17),
      fileLine(`uploads/${date}-logs.zip`, 15),
    ]);
    expect(texts[2]).toBe(`[file attached: uploads/${date}-q3-volumes.csv (29 B, CSV), not sent to you: open it with your tools]`);
    expect(parseFileLine(texts[4]!)).toEqual({ path: `uploads/${date}-logs.zip`, size: '15 B', label: 'zip archive' });

    // The model reads the lines; no file bytes go to it.
    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    const seen = JSON.stringify(fake.calls[0]!.messages);
    expect(seen).toContain(`uploads/${date}-q3-volumes.csv (29 B, CSV)`);
    expect(seen).not.toContain('2026-07-01,solana');

    // A click on a chip in the task: served from the workspace; only files the conversation names.
    const get = (p: string, dl = false) => fetch(`${e.url}/api/cards/${card.id}/file?path=${encodeURIComponent(p)}${dl ? '&download=1' : ''}`);
    const r = await get(`uploads/${date}-q3-volumes.csv`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toMatch(/^inline/);
    expect(r.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await r.text()).toBe('date,chain\n2026-07-01,solana\n');
    expect((await get(`uploads/${date}-logs.zip`)).headers.get('content-disposition')).toMatch(/^attachment/);
    expect((await get(`uploads/${date}-q3-volumes.csv`, true)).headers.get('content-disposition')).toMatch(/^attachment/);
    expect((await get('../../atlas.db')).status).toBe(404);
    expect((await get(db)).status).toBe(404);
    writeFileSync(join(ws, 'secret.txt'), 'x');
    expect((await get('secret.txt')).status).toBe(404);
  });

  it('a crash after the copies but before the row: the staged file stays, sending again works', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const u = new Uploads(dataDir);
    const up = await u.stage('notes.txt', Buffer.from('hello'));
    const ws = join(dataDir, 'ws');
    await expect(u.send([up.id], ws, () => {
      throw new Error('killed before the row');
    })).rejects.toThrow('killed before the row');
    expect(readdirSync(join(ws, 'uploads'))).toEqual([]); // the copy removed
    expect(readdirSync(u.dir)).toHaveLength(1); // still staged
    const placed = await u.send([up.id], ws, (p) => p);
    expect(placed.files).toHaveLength(1);
    expect(readFileSync(placed.files[0]!.path, 'utf8')).toBe('hello');
    expect(readdirSync(u.dir)).toEqual([]);
    await expect(u.send([up.id], ws, (p) => p)).rejects.toThrow(/not found/); // never placed twice
  });

  it('limits: 10 attachments per message, of which 5 pictures', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const e = await start(new FakeProvider([]), ':memory:', dataDir);
    const card = e.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    const stageFile = async (n: string, b: Buffer) => ((await (await upload(e, card.id, n, b)).json()) as Upload).id;
    const pics = [];
    for (let i = 0; i < 6; i++) pics.push(await stageFile(`p${i}.png`, await png(10 + i, 10)));
    const docs = [];
    for (let i = 0; i < 6; i++) docs.push(await stageFile(`d${i}.txt`, Buffer.from(`doc ${i}`)));
    const six = await send(e, card.id, { uploads: pics });
    expect(six.status).toBe(400);
    expect(((await six.json()) as { error: string }).error).toBe('5 pictures per message at most');
    const eleven = await send(e, card.id, { uploads: [...pics.slice(0, 5), ...docs] });
    expect(eleven.status).toBe(400);
    expect(JSON.stringify(await eleven.json())).toMatch(/10/);
    expect(readdirSync(join(dataDir, 'uploads'))).toHaveLength(12); // refusals copy nothing, stage stays
    expect((await send(e, card.id, { uploads: [...pics.slice(0, 5), ...docs.slice(0, 5)] })).status).toBe(201);
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
