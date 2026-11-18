import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ContentBlock, Doc, DocContent, DocVersion } from '@atlas/shared';
import { launch, type Launched } from '../test/kit/index.ts';
import type { SecretStore } from './secrets.ts';
import type { Db } from './store/db.ts';

/** #226: a secret value written into a workspace file never reaches SQLite, the Library, the API or /api/files. */

class MemoryStore implements SecretStore {
  label = 'test store';
  map = new Map<string, string>();
  names = () => [...this.map.keys()];
  get = (n: string) => this.map.get(n);
  set = (n: string, v: string) => void this.map.set(n, v);
  delete = (n: string) => void this.map.delete(n);
}

const CANARY = 'canary-226-QWERTY-13579';
const LATER = 'later-226-ASDFGH-24680';
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const tool = (id: string, name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id, name, input }];

/** Every row of every table, as one string. */
function dump(db: Db): string {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n');
}

/** The database file and its WAL and SHM, raw bytes. */
function rawDb(dbFile: string): Buffer {
  return Buffer.concat(['', '-wal', '-shm'].flatMap((s) => (existsSync(dbFile + s) ? [readFileSync(dbFile + s)] : [])));
}

async function run(l: Launched) {
  const card = l.engine.kanban.create({ title: 'files', assignee: 'atlas' }, 'user');
  l.engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
  l.engine.runner.wake(card.id);
  await l.engine.runner.settled(card.id);
  return card;
}

/** Everything the API gives about every artifact: the Library list, each one, each of its versions, a search. */
async function apiText(l: Launched, q: string): Promise<string> {
  const out: string[] = [];
  const docs = (await l.call<Doc[]>('GET', '/documents')).body;
  out.push(JSON.stringify(docs));
  for (const d of docs) {
    out.push(JSON.stringify((await l.call<DocContent>('GET', `/documents/${d.id}`)).body));
    const versions = (await l.call<DocVersion[]>('GET', `/documents/${d.id}/versions`)).body;
    for (const v of versions) out.push(JSON.stringify((await l.call<DocContent>('GET', `/documents/${d.id}?version=${v.version}`)).body));
  }
  out.push(JSON.stringify((await l.call('GET', `/documents/search?q=${encodeURIComponent(q)}`)).body));
  return out.join('\n');
}

describe('secret values in workspace files (#226)', () => {
  it('echo "$KEY" > docs/note.md, then a file tool: nothing stored, listed or served holds the value; restart-safe', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-226-'));
    const dbFile = join(dataDir, 'atlas.db');
    const store = new MemoryStore();
    const script = [
      tool('t1', 'shell', { command: 'mkdir -p docs pages; echo "# Key $CANARY_KEY" > docs/note.md; echo "k: $CANARY_KEY" > saved.txt; echo "<svg><text>$CANARY_KEY</text></svg>" > pages/p.svg' }),
      tool('t2', 'write_file', { path: 'docs/other.md', content: 'hello' }),
      text('done'),
    ];
    const a = await launch({ dbFile, dataDir, secrets: store, dispatch: false, env: {}, script });
    expect((await a.call('POST', '/secrets', { name: 'CANARY_KEY', value: CANARY, grant: 'all', agents: [], description: '' })).status).toBe(201);
    await run(a);

    // The file the agent wrote stays as it is on disk (accepted limit, design §10b)…
    expect(readFileSync(join(a.workdir, 'docs/note.md'), 'utf8')).toContain(CANARY);
    // …its artifact holds [secret NAME], in SQLite, in its title, and through the API.
    const note = a.engine.documents.byPath('atlas', 'docs/note.md');
    expect(note).not.toBeNull();
    expect(note!.title).toBe('Key [secret CANARY_KEY]');
    expect(a.engine.documents.content(note!.id).content).toBe('# Key [secret CANARY_KEY]\n');
    expect(dump(a.engine.db)).not.toContain(CANARY);
    const api = await apiText(a, 'Key');
    expect(api).toContain('[secret CANARY_KEY]');
    expect(api).not.toContain(CANARY);

    // /api/files: text files are served redacted; the type stays; other files are untouched.
    for (const [path, type] of [['docs/note.md', 'markdown'], ['saved.txt', 'text/plain'], ['pages/p.svg', 'image/svg+xml']] as const) {
      const r = await fetch(`${a.api}/files/atlas/${path}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain(type);
      expect(r.headers.get('content-security-policy')).toContain('sandbox');
      const body = await r.text();
      expect(body).toContain('[secret CANARY_KEY]');
      expect(body).not.toContain(CANARY);
    }
    writeFileSync(join(a.workdir, 'plain.txt'), 'nothing secret here');
    expect(await (await fetch(`${a.api}/files/atlas/plain.txt`)).text()).toBe('nothing secret here');

    await a.engine.stop();
    expect(rawDb(dbFile).includes(Buffer.from(CANARY))).toBe(false);

    // Restart: still nowhere; a Library re-read of the unchanged file adds nothing raw.
    const b = await launch({ dbFile, dataDir, secrets: store, dispatch: false, env: {} });
    const api2 = await apiText(b, 'Key');
    expect(api2).not.toContain(CANARY);
    expect(dump(b.engine.db)).not.toContain(CANARY);
    await b.engine.stop();
    expect(rawDb(dbFile).includes(Buffer.from(CANARY))).toBe(false);
  });

  it('artifact_create / artifact_update / restore: content and title are stored redacted', async () => {
    const store = new MemoryStore();
    const l = await launch({ secrets: store, dispatch: false, env: {} });
    l.engine.secrets.create({ name: 'CANARY_KEY', value: CANARY, description: '', grant: 'all', agents: [], project: null }, { by: 'user' });
    const doc = l.engine.documents.create('atlas', { kind: 'markdown', title: `Notes ${CANARY}`, content: `key=${CANARY}\n` }, 'atlas');
    expect(doc.title).toBe('Notes [secret CANARY_KEY]');
    l.engine.documents.update(doc.id, { content: `v2 ${CANARY}`, title: `T ${CANARY}` }, 'atlas');
    l.engine.documents.restore(doc.id, 1, 'user');
    expect(dump(l.engine.db)).not.toContain(CANARY);
    expect(l.engine.documents.content(doc.id, 1).content).toBe("key=[secret CANARY_KEY]\n");
  });

  it('a value added (or rotated) later is hidden in versions stored before; the start pass catches rows an older engine left', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-226-'));
    const dbFile = join(dataDir, 'atlas.db');
    const store = new MemoryStore();
    const a = await launch({ dbFile, dataDir, secrets: store, dispatch: false, env: {} });
    mkdirSync(join(a.workdir, 'docs'), { recursive: true });
    writeFileSync(join(a.workdir, 'docs/later.md'), `# Later ${LATER}\n`);
    await a.call('GET', '/documents'); // the Library indexes it: no secret yet, stored as is
    const doc = a.engine.documents.byPath('atlas', 'docs/later.md')!;
    expect(a.engine.documents.content(doc.id).content).toContain(LATER);

    // The user adds the value now: the stored version and the title are rewritten at once.
    expect((await a.call('POST', '/secrets', { name: 'LATER_KEY', value: LATER, grant: 'none', agents: [], description: '' })).status).toBe(201);
    expect(dump(a.engine.db)).not.toContain(LATER);
    expect(await apiText(a, 'Later')).not.toContain(LATER);
    expect(a.engine.documents.get(doc.id).title).toBe('Later [secret LATER_KEY]');
    expect(a.engine.documents.versions(doc.id)).toHaveLength(1); // no new version: the old one is rewritten

    // Rotation: a version stored with the new value before it was set (written raw, as an older engine did).
    const NEXT = 'next-226-ZXCVBN-11223';
    a.engine.db.prepare('UPDATE document_versions SET content = ? WHERE doc_id = ?').run(`old ${NEXT}`, doc.id);
    a.engine.secrets.setValue('LATER_KEY', NEXT, { by: 'user' });
    expect(dump(a.engine.db)).not.toContain(NEXT);

    // An older engine's row: raw in SQLite while the engine is down; the next start rewrites it.
    a.engine.db.prepare('UPDATE document_versions SET content = ? WHERE doc_id = ?').run(`stale ${NEXT}`, doc.id);
    await a.engine.stop();
    expect(rawDb(dbFile).includes(Buffer.from(NEXT))).toBe(true);
    const b = await launch({ dbFile, dataDir, secrets: store, dispatch: false, env: {} });
    expect(b.engine.documents.content(doc.id, 1).content).toBe('stale [secret LATER_KEY]');
    expect(dump(b.engine.db)).not.toContain(NEXT);
    await b.engine.stop();
    // secure_delete + a truncated WAL: the old bytes are gone from the files too.
    expect(rawDb(dbFile).includes(Buffer.from(NEXT))).toBe(false);
  });

  it('redactBytes replaces every occurrence and leaves other bytes alone', async () => {
    const store = new MemoryStore();
    const l = await launch({ secrets: store, dispatch: false, env: {} });
    l.engine.secrets.create({ name: 'CANARY_KEY', value: CANARY, description: '', grant: 'none', agents: [], project: null }, { by: 'user' });
    const bin = Buffer.from([0, 255, 1]);
    const r = l.engine.secrets.redactBytes(Buffer.concat([bin, Buffer.from(`${CANARY}é${CANARY}`), bin]));
    expect(r.hidden).toBe(2);
    expect(r.buf.equals(Buffer.concat([bin, Buffer.from('[secret CANARY_KEY]é[secret CANARY_KEY]'), bin]))).toBe(true);
    expect(l.engine.secrets.redactBytes(bin).hidden).toBe(0);
  });
});
