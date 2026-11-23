// Images attached to a task (#119): create / add / remove through the API, limits, restarts, and what the agent sees.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { fileLine, WORK_KICK, type Card, type ImageBlock, type Upload } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';

const png = (w = 64, h = 48, background = '#3366ff') => sharp({ create: { width: w, height: h, channels: 3, background } }).png().toBuffer();
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
async function restart(e: Engine, fake: FakeProvider, db: string, dataDir: string) {
  await e.stop();
  engines = engines.filter((x) => x !== e);
  return start(fake, db, dataDir);
}
const json = (method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const stage = async (e: Engine, name: string, body: Buffer) => {
  const r = await fetch(`${e.url}/api/uploads?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(body) });
  return { status: r.status, body: (await r.json()) as Upload & { error?: string } };
};
const createCard = async (e: Engine, body: unknown) => {
  const r = await fetch(`${e.url}/api/cards`, json('POST', body));
  return { status: r.status, body: (await r.json()) as Card & { error?: string } };
};
const taskDir = (dataDir: string) => join(dataDir, 'task-images');
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);
/** The pictures (with bytes) in the first message of a model call. */
const firstPictures = (fake: FakeProvider, call: number) => fake.calls[call]!.messages[0]!.content.filter((b): b is ImageBlock => b.type === 'image' && !!b.data);
const firstTexts = (fake: FakeProvider, call: number) => fake.calls[call]!.messages[0]!.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));

describe('task images (#119)', () => {
  it('New task: staged with no task, restart, create with them, restart, assign: the agent sees them and has the files', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const db = join(dataDir, 'atlas.db');
    const fake = new FakeProvider([[{ type: 'text', text: 'A blue and a red square.' }], [{ type: 'text', text: 'Seen.' }]]);
    let e = await start(fake, db, dataDir);
    const a = await stage(e, 'Screen Shot.png', await png());
    const b = await stage(e, 'second.png', await png(32, 32, '#ff0000'));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    e = await restart(e, fake, db, dataDir); // between upload and Create: nothing lost
    const created = await createCard(e, { title: 'Look at these', status: 'todo', uploads: [a.body.id, b.body.id] });
    expect(created.status).toBe(201);
    const date = new Date().toISOString().slice(0, 10);
    expect(created.body.images.map((im) => im.path)).toEqual([join(taskDir(dataDir), `${date}-Screen-Shot.png`), join(taskDir(dataDir), `${date}-second.png`)]);
    expect(created.body.images[0]).toMatchObject({ type: 'image', media_type: 'image/png', width: 64, height: 48 });
    expect(files(join(dataDir, 'uploads'))).toEqual([]); // staged copies gone
    expect(JSON.stringify(created.body)).not.toContain('"data"'); // no bytes in SQLite

    e = await restart(e, fake, db, dataDir); // between Create and the first run: nothing lost
    const card = e.kanban.get(created.body.id);
    expect(card.images).toHaveLength(2);
    // The thumbnail route serves a task image.
    const thumb = await fetch(`${e.url}/api/cards/${card.id}/image?path=${encodeURIComponent(card.images[0]!.path)}`);
    expect(thumb.status).toBe(200);

    // Assigned later: its run opens with both pictures and their workspace paths.
    e.kanban.update(card.id, { assignee: 'atlas', status: 'ready' }, 'user');
    e.runner.wake(card.id, { kind: 'work', kick: WORK_KICK });
    await e.runner.settled(card.id);
    const pics = firstPictures(fake, 0);
    expect(pics).toHaveLength(2);
    expect(Buffer.from(pics[1]!.data!, 'base64').equals(readFileSync(card.images[1]!.path))).toBe(true);
    const n = card.number!;
    expect(firstTexts(fake, 0)).toEqual(
      expect.arrayContaining([`Images attached to task #${n} (2):`, `[attached: uploads/task-${n}-${date}-Screen-Shot.png]`, `[attached: uploads/task-${n}-${date}-second.png]`, WORK_KICK]),
    );
    const ws = join(dataDir, 'workspaces/atlas/uploads');
    expect(readFileSync(join(ws, `task-${n}-${date}-second.png`)).equals(readFileSync(card.images[1]!.path))).toBe(true);
    expect(fake.calls[0]!.system).toContain(`Images attached to this task: uploads/task-${n}-${date}-Screen-Shot.png, uploads/task-${n}-${date}-second.png`);
    // Never stored in the transcript.
    expect(JSON.stringify(e.kanban.messages(card.id))).not.toContain('task-images');

    // Reassigned: the new agent sees them too, and gets the files in its own workspace.
    e.agents.create({ id: 'munih', modelId: e.agents.get('atlas').modelId });
    e.kanban.update(card.id, { assignee: 'munih' }, 'user');
    e.kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'what is in the images?' }]);
    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    expect(firstPictures(fake, 1)).toHaveLength(2);
    expect(existsSync(join(dataDir, 'workspaces/munih/uploads', `task-${n}-${date}-Screen-Shot.png`))).toBe(true);
  });

  it('existing task: add, remove (file gone, gone for the next run), limits, refusals store nothing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const db = join(dataDir, 'atlas.db');
    const fake = new FakeProvider([[{ type: 'text', text: 'ok' }]]);
    let e = await start(fake, db, dataDir);
    const card = e.kanban.create({ title: 'x', status: 'todo', assignee: 'atlas' }, 'user');
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await stage(e, `s${i}.png`, await png(10 + i, 10))).body.id);
    // Not a picture by its bytes, or a picture over 10 MB: staged as a plain file (#348), not refused.
    const bad = await stage(e, 'evil.png', Buffer.from('<script>'));
    expect(bad.status).toBe(201);
    expect(bad.body).toMatchObject({ kind: 'file', name: 'evil.png' });
    const big = await stage(e, 'big.png', Buffer.concat([await png(), Buffer.alloc(10 * 1024 * 1024)]));
    expect(big.body).toMatchObject({ kind: 'file' });
    for (const x of [bad, big]) expect((await fetch(`${e.url}/api/uploads/${x.body.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(files(join(dataDir, 'uploads'))).toHaveLength(6);
    // Six on a new task: refused, nothing created.
    const six = await createCard(e, { title: 'six', uploads: ids });
    expect(six.status).toBe(400);
    expect(e.kanban.list().map((c) => c.title)).not.toContain('six');

    const add = (uploads: string[]) => fetch(`${e.url}/api/cards/${card.id}/images`, json('POST', { uploads }));
    expect((await add(ids.slice(0, 3))).status).toBe(201);
    expect((await add(ids.slice(3, 5))).status).toBe(201);
    const sixth = await add(ids.slice(5));
    expect(sixth.status).toBe(400);
    expect(((await sixth.json()) as { error: string }).error).toBe('5 pictures per task at most (it has 5)');
    expect(files(taskDir(dataDir))).toHaveLength(5); // the 6th wasn't copied
    expect(files(join(dataDir, 'uploads'))).toHaveLength(1); // and stays staged, until the user removes it…
    expect((await fetch(`${e.url}/api/uploads/${ids[5]}`, { method: 'DELETE' })).status).toBe(204);
    expect(files(join(dataDir, 'uploads'))).toHaveLength(0); // …or cancels the dialog

    // Remove one: the row first, then its file; the state survives a restart.
    const gone = e.kanban.get(card.id).images[1]!;
    const del = await fetch(`${e.url}/api/cards/${card.id}/images?path=${encodeURIComponent(gone.path)}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(existsSync(gone.path)).toBe(false);
    e = await restart(e, fake, db, dataDir);
    const kept = e.kanban.get(card.id).images;
    expect(kept).toHaveLength(4);
    expect(kept.map((im) => im.path)).not.toContain(gone.path);
    expect((await fetch(`${e.url}/api/cards/${card.id}/images`, json('POST', { uploads: ['up_missing'] }))).status).toBe(404);
    expect((await fetch(`${e.url}/api/cards/${card.id}/image?path=${encodeURIComponent(gone.path)}`)).status).toBe(404);

    // The next run shows only the 4 left.
    e.kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'look' }]);
    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    expect(firstPictures(fake, 0)).toHaveLength(4);
    expect(JSON.stringify(fake.calls[0]!.messages)).not.toContain(gone.path);

    // Deleting the task deletes its files.
    expect((await fetch(`${e.url}/api/cards/${card.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(files(taskDir(dataDir))).toEqual([]);
  });

  it('task files (#348): any file on a task, copied to the assignee, named in a line, limits 10 / 5 pictures, removed', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const db = join(dataDir, 'atlas.db');
    const fake = new FakeProvider([[{ type: 'text', text: 'ok' }]]);
    let e = await start(fake, db, dataDir);
    const pdf = await stage(e, 'spec v2.pdf', Buffer.from('%PDF-1.7 the spec'));
    const pic = await stage(e, 'mock.png', await png());
    const bare = await stage(e, 'Dockerfile', Buffer.from('FROM node:24'));
    expect([pdf.body.kind, pic.body.kind, bare.body.kind]).toEqual(['file', 'image', 'file']);
    e = await restart(e, fake, db, dataDir); // between upload and Create
    const created = await createCard(e, { title: 'Read the spec', status: 'ready', assignee: 'atlas', uploads: [pdf.body.id, pic.body.id, bare.body.id] });
    expect(created.status).toBe(201);
    const date = new Date().toISOString().slice(0, 10);
    expect(created.body.images).toHaveLength(1);
    expect(created.body.files).toEqual([
      { path: join(taskDir(dataDir), `${date}-spec-v2.pdf`), bytes: 17, media_type: 'application/pdf' },
      { path: join(taskDir(dataDir), `${date}-Dockerfile`), bytes: 12, media_type: 'application/octet-stream' },
    ]);
    e = await restart(e, fake, db, dataDir); // between Create and the run
    const card = e.kanban.get(created.body.id);
    expect(card.files).toHaveLength(2);
    e.runner.wake(card.id, { kind: 'work', kick: WORK_KICK });
    await e.runner.settled(card.id);
    const n = card.number!;
    expect(firstTexts(fake, 0)).toEqual(
      expect.arrayContaining([
        `Files attached to task #${n} (3):`,
        `[attached: uploads/task-${n}-${date}-mock.png]`,
        fileLine(`uploads/task-${n}-${date}-spec-v2.pdf`, 17, 'x.pdf'),
        fileLine(`uploads/task-${n}-${date}-Dockerfile`, 12),
      ]),
    );
    expect(JSON.stringify(fake.calls[0]!.messages)).not.toContain('the spec'); // no file bytes to the model
    expect(readFileSync(join(dataDir, 'workspaces/atlas/uploads', `task-${n}-${date}-spec-v2.pdf`), 'utf8')).toBe('%PDF-1.7 the spec');
    expect(fake.calls[0]!.system).toContain(`Files attached to this task: uploads/task-${n}-${date}-spec-v2.pdf, uploads/task-${n}-${date}-Dockerfile`);

    // A click on its chip: the pdf opens in the tab, the rest is downloaded.
    const open = await fetch(`${e.url}/api/cards/${card.id}/file?path=${encodeURIComponent(card.files[0]!.path)}`);
    expect(open.headers.get('content-type')).toBe('application/pdf');
    expect(open.headers.get('content-disposition')).toMatch(/^inline/);
    const dl = await fetch(`${e.url}/api/cards/${card.id}/file?path=${encodeURIComponent(card.files[1]!.path)}`);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(await dl.text()).toBe('FROM node:24');

    // Limits: 10 attachments per task, 5 pictures.
    const add = (uploads: string[]) => fetch(`${e.url}/api/cards/${card.id}/images`, json('POST', { uploads }));
    const more: string[] = [];
    for (let i = 0; i < 8; i++) more.push((await stage(e, `n${i}.txt`, Buffer.from(String(i)))).body.id);
    const eleven = await add(more);
    expect(eleven.status).toBe(400);
    expect(((await eleven.json()) as { error: string }).error).toBe('10 attachments per task at most (it has 3)');
    expect((await add(more.slice(0, 7))).status).toBe(201);
    const pics: string[] = [];
    for (let i = 0; i < 6; i++) pics.push((await stage(e, `p${i}.png`, await png(10 + i, 10))).body.id);
    const sixthPicture = await createCard(e, { title: 'six pics', uploads: pics });
    expect(sixthPicture.status).toBe(400);
    expect(sixthPicture.body.error).toBe('5 pictures per task at most');

    // Remove a file: the row, then its file.
    const gone = e.kanban.get(card.id).files[0]!;
    expect((await fetch(`${e.url}/api/cards/${card.id}/images?path=${encodeURIComponent(gone.path)}`, { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(gone.path)).toBe(false);
    expect(e.kanban.get(card.id).files.map((f) => f.path)).not.toContain(gone.path);
    expect((await fetch(`${e.url}/api/cards/${card.id}/file?path=${encodeURIComponent(gone.path)}`)).status).toBe(404);
  });

  it('the task pictures always go, even behind more than 6 newer pictures in the conversation', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const fake = new FakeProvider([[{ type: 'text', text: 'ok' }]]);
    const e = await start(fake, ':memory:', dataDir);
    const up = await stage(e, 'task.png', await png(20, 20, '#00ff00'));
    const card = (await createCard(e, { title: 't', status: 'todo', assignee: 'atlas', uploads: [up.body.id] })).body;
    const ws = join(dataDir, 'workspaces/atlas');
    mkdirSync(ws, { recursive: true });
    const later: ImageBlock[] = [];
    for (let i = 0; i < 7; i++) {
      const f = join(ws, `later${i}.png`);
      writeFileSync(f, await png(30 + i, 30));
      later.push({ type: 'image', path: f, media_type: 'image/png', width: 30 + i, height: 30, bytes: readFileSync(f).length, sha256: (await import('node:crypto')).createHash('sha256').update(readFileSync(f)).digest('hex') });
    }
    e.kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'many' }, ...later]);
    e.runner.wake(card.id);
    await e.runner.settled(card.id);
    const all = fake.calls[0]!.messages.flatMap((m) => m.content).filter((b): b is ImageBlock => b.type === 'image' && !!b.data);
    expect(all.map((b) => b.path)).toEqual([card.images[0]!.path, ...later.slice(1).map((b) => b.path)]); // the task's + the newest 6
  });

  it('at start, files no task lists (a crash between the copy and the row) are swept', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const db = join(dataDir, 'atlas.db');
    const fake = new FakeProvider([]);
    let e = await start(fake, db, dataDir);
    const up = await stage(e, 'keep.png', await png());
    const card = await createCard(e, { title: 'k', status: 'todo', uploads: [up.body.id] });
    mkdirSync(taskDir(dataDir), { recursive: true });
    writeFileSync(join(taskDir(dataDir), 'orphan.png'), await png());
    e = await restart(e, fake, db, dataDir);
    expect(files(taskDir(dataDir))).toEqual([card.body.images[0]!.path.split('/').pop()]);
  });

  it('a direct chat takes images as messages, not on the chat itself', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const e = await start(new FakeProvider([]), ':memory:', dataDir);
    const chat = e.kanban.newChat('atlas');
    const up = await stage(e, 'a.png', await png());
    const r = await fetch(`${e.url}/api/cards/${chat.id}/images`, json('POST', { uploads: [up.body.id] }));
    expect(r.status).toBe(400);
  });
});
