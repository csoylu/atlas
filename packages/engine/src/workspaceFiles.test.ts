import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, FileTab, PanelTab, WsFile, WsListing, WsSaveResult } from '@atlas/shared';
import { eventually, launch, type Launched } from '../test/kit/index.ts';
import type { SecretStore } from './secrets.ts';
import { letterOf, parseStatus } from './workspaceFiles.ts';

/** #303: the pane's Files tab reads and writes the chat's agent workspace through the engine, inside its boundary. */

const put = (root: string, rel: string, content: string | Buffer) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

async function setup(o: Parameters<typeof launch>[0] = {}) {
  const l = await launch({ dispatch: false, env: {}, ...o });
  const chat = await l.chat();
  const files = (path: string) => `/chats/${chat.id}/files/${path}`;
  return { l, chat, files, ws: l.workdir };
}

describe('workspace files (#303)', () => {
  it('refuses .., absolute paths, links out (file and folder) and git\'s folder; lists only what stays inside', async () => {
    const { l, files, ws } = await setup();
    const outside = mkdtempSync(join(tmpdir(), 'atlas-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    put(ws, 'a.txt', 'hello');
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'out-file'));
    symlinkSync(outside, join(ws, 'out-dir'));
    symlinkSync(join(ws, 'a.txt'), join(ws, 'in-link'));
    // Dangling links out (review of PR #118): to a file not there yet, and to a folder not there yet.
    symlinkSync(join(outside, 'new.txt'), join(ws, 'dang'));
    symlinkSync(join(outside, 'nodir'), join(ws, 'dang-dir'));
    mkdirSync(join(ws, '.git'));
    writeFileSync(join(ws, '.git', 'config'), '[core]');

    for (const p of ['../x', '../../atlas.db', 'docs/../../x', 'out-file', 'out-dir/secret.txt', '.git/config']) {
      const r = await l.call<{ error: string }>('GET', files(`read?path=${encodeURIComponent(p)}`));
      expect(r.status, p).toBe(409);
    }
    const abs = await l.call<{ error: string }>('GET', files(`read?path=${encodeURIComponent(join(ws, 'a.txt'))}`));
    expect(abs.status).toBe(400);
    expect(abs.body.error).toMatch(/relative/);
    // Writes too: nothing lands outside, through .. or a link.
    for (const p of ['../escape.txt', 'out-dir/new.txt', 'out-file', 'dang', 'dang-dir/new.txt', 'dang-dir/a/b.txt']) {
      for (const base of [null, 'x']) {
        const r = await l.call('POST', files('save'), { path: p, content: 'pwned', base });
        expect(r.status === 409 || (base !== null && (r.body as WsSaveResult).ok === false), `${p} base ${base}`).toBe(true);
      }
    }
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
    expect(readdirSync(outside)).toEqual(['secret.txt']);
    for (const p of ['dang', 'dang-dir/new.txt']) expect((await l.call('GET', files(`read?path=${p}`))).status, p).not.toBe(200);
    // A link that stays inside reads; links out and .git are not listed.
    expect((await l.call<WsFile>('GET', files('read?path=in-link'))).body.content).toBe('hello');
    const list = (await l.call<WsListing>('GET', files('list?dir='))).body;
    expect(list.entries.map((e) => e.name).sort()).toEqual(['a.txt', 'in-link']);
    expect(list.agentId).toBe('atlas');
    rmSync(outside, { recursive: true, force: true });
  });

  it('never reaches another project\'s clone: a link to it is refused', async () => {
    const { l, files, ws } = await setup();
    const clone = join(l.dataDir, 'projects', 'datinel', 'atlas');
    put(clone, 'src/key.ts', 'export const k = 1;');
    symlinkSync(clone, join(ws, 'datinel'));
    expect((await l.call('GET', files('read?path=datinel/src/key.ts'))).status).toBe(409);
    expect((await l.call<Record<string, string | null>>('POST', files('links'), { paths: ['src/key.ts', 'datinel/src/key.ts'] })).body).toEqual({ 'src/key.ts': null, 'datinel/src/key.ts': null });
  });

  it('reads text, images and binaries; over 1 MB is read only with the first 2,000 lines', async () => {
    const { l, files, ws } = await setup();
    put(ws, 'src/a.ts', 'const a = 1;\n');
    put(ws, 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    put(ws, 'data.sqlite', Buffer.from([1, 2, 0, 3]));
    put(ws, 'big.json', Array.from({ length: 40_000 }, (_, i) => `{"id": ${i}, "title": "tender number ${i}"}`).join('\n'));
    const text = (await l.call<WsFile>('GET', files('read?path=src/a.ts'))).body;
    expect(text).toMatchObject({ kind: 'text', content: 'const a = 1;\n', readOnly: null, size: 13 });
    expect(text.hash).toMatch(/^[0-9a-f]{32}$/);
    expect((await l.call<WsFile>('GET', files('read?path=shot.png'))).body).toMatchObject({ kind: 'image', content: null, readOnly: 'image' });
    const img = await fetch(`${l.api}${files('image?path=shot.png')}`);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer())[1]).toBe(0x50);
    expect((await l.call('GET', files('image?path=src/a.ts'))).status).toBe(400);
    expect((await l.call<WsFile>('GET', files('read?path=data.sqlite'))).body).toMatchObject({ kind: 'binary', content: null, readOnly: 'binary' });
    const big = (await l.call<WsFile>('GET', files('read?path=big.json'))).body;
    expect(big.readOnly).toBe('large');
    expect(big.content!.split('\n').filter(Boolean)).toHaveLength(2000);
    expect((await l.call('POST', files('save'), { path: 'big.json', content: 'x', base: big.hash })).status).toBe(409);
  });

  it('serves a file as itself for « can\'t be shown » (#348): a pdf in a tab, the rest downloaded, inside only', async () => {
    const { l, files, ws } = await setup();
    put(ws, 'uploads/audit.pdf', '%PDF-1.7 audit');
    put(ws, 'uploads/logs.zip', Buffer.from([0x50, 0x4b, 3, 4]));
    const pdf = await fetch(`${l.api}${files('raw?path=uploads/audit.pdf')}`);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toMatch(/^inline/);
    expect(await pdf.text()).toBe('%PDF-1.7 audit');
    const zip = await fetch(`${l.api}${files('raw?path=uploads/logs.zip')}`);
    expect(zip.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''logs.zip");
    expect(zip.headers.get('content-security-policy')).toBe('sandbox');
    expect((await fetch(`${l.api}${files('raw?path=uploads/audit.pdf&download=1')}`)).headers.get('content-disposition')).toMatch(/^attachment/);
    expect((await fetch(`${l.api}${files('raw?path=../outside.txt')}`)).status).toBeGreaterThanOrEqual(400);
  });

  it('serves no secret value: a file holding one is redacted and read only (#226)', async () => {
    const store: SecretStore & { map: Map<string, string> } = {
      label: 'test',
      map: new Map(),
      names() {
        return [...this.map.keys()];
      },
      get(n) {
        return this.map.get(n);
      },
      set(n, v) {
        this.map.set(n, v);
      },
      delete(n) {
        this.map.delete(n);
      },
    };
    const { l, files, ws } = await setup({ secrets: store });
    const VALUE = 'canary-303-ZXCVBN-97531';
    expect((await l.call('POST', '/secrets', { name: 'K303', value: VALUE, grant: 'all', agents: [], description: '' })).status).toBe(201);
    put(ws, '.env', `K303=${VALUE}\n`);
    put(ws, 'big.txt', `key ${VALUE}\n` + 'x\n'.repeat(700_000));
    const r = await l.call<WsFile>('GET', files('read?path=.env'));
    expect(JSON.stringify(r.body)).not.toContain(VALUE);
    expect(r.body).toMatchObject({ content: 'K303=[secret K303]\n', readOnly: 'secret' });
    expect(JSON.stringify((await l.call('GET', files('read?path=big.txt'))).body)).not.toContain(VALUE);
    // Saving it would write the mark over the value: refused, the file unchanged.
    expect((await l.call('POST', files('save'), { path: '.env', content: 'K303=[secret K303]\nX=1\n', base: r.body.hash })).status).toBe(409);
    expect(readFileSync(join(ws, '.env'), 'utf8')).toBe(`K303=${VALUE}\n`);
  });

  it('a save never overwrites the agent\'s write silently: changed, deleted, exists; then Keep mine', async () => {
    const { l, files, ws } = await setup();
    put(ws, 'notes.md', 'v1\n');
    const opened = (await l.call<WsFile>('GET', files('read?path=notes.md'))).body;
    // The agent writes the file while it is open.
    put(ws, 'notes.md', 'v2 by the agent\n');
    const r1 = (await l.call<WsSaveResult>('POST', files('save'), { path: 'notes.md', content: 'mine\n', base: opened.hash })).body;
    expect(r1).toMatchObject({ ok: false, conflict: 'changed', file: { content: 'v2 by the agent\n' } });
    expect(readFileSync(join(ws, 'notes.md'), 'utf8')).toBe('v2 by the agent\n');
    // Keep mine: a save from what is there now.
    const theirs = r1.ok ? null : r1.file!;
    const r2 = (await l.call<WsSaveResult>('POST', files('save'), { path: 'notes.md', content: 'mine\n', base: theirs!.hash })).body;
    expect(r2).toMatchObject({ ok: true, file: { content: 'mine\n' } });
    expect(readFileSync(join(ws, 'notes.md'), 'utf8')).toBe('mine\n');
    // Deleted by the agent: not recreated…
    rmSync(join(ws, 'notes.md'));
    const r3 = (await l.call<WsSaveResult>('POST', files('save'), { path: 'notes.md', content: 'again\n', base: r2.ok ? r2.file.hash : '' })).body;
    expect(r3).toMatchObject({ ok: false, conflict: 'deleted', file: null });
    expect((await l.call('GET', files('stat?path=notes.md'))).body).toMatchObject({ exists: false, stamp: null });
    // …until « Save it again » (base null), which refuses a file that came back meanwhile.
    expect((await l.call<WsSaveResult>('POST', files('save'), { path: 'notes.md', content: 'again\n', base: null })).body).toMatchObject({ ok: true });
    expect((await l.call<WsSaveResult>('POST', files('save'), { path: 'notes.md', content: 'x', base: null })).body).toMatchObject({ ok: false, conflict: 'exists' });
    expect(readFileSync(join(ws, 'notes.md'), 'utf8')).toBe('again\n');
    // Over the editing limit: refused.
    expect((await l.call('POST', files('save'), { path: 'huge.txt', content: 'x'.repeat(1024 * 1024 + 1), base: null })).status).toBe(400);
  });

  it('Master\'s save is what the agent\'s next read_file sees', async () => {
    const tool = (id: string, name: string, input: Record<string, unknown>): ContentBlock[] => [{ type: 'tool_use', id, name, input }];
    const l = await launch({ env: {}, script: [tool('t1', 'read_file', { path: 'plan.md' }), [{ type: 'text', text: 'read it' }]] });
    put(l.workdir, 'plan.md', 'old line\n');
    const chat = await l.chat();
    const f = (await l.call<WsFile>('GET', `/chats/${chat.id}/files/read?path=plan.md`)).body;
    expect((await l.call<WsSaveResult>('POST', `/chats/${chat.id}/files/save`, { path: 'plan.md', content: 'edited by Master\n', base: f.hash })).body.ok).toBe(true);
    await l.say(chat.id, 'read plan.md');
    await l.idle(chat.id);
    const result = l.engine.kanban
      .messages(chat.id)
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result');
    expect(JSON.stringify(result)).toContain('edited by Master');
  });

  it('git letters: A for new or untracked, M for changed; folders carry their content\'s, a clone its own', async () => {
    const { l, files, ws } = await setup();
    const repo = join(ws, 'clone');
    put(repo, 'src/kept.ts', '1');
    put(repo, 'src/edit.ts', '1');
    put(repo, 'README.md', '#');
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    put(repo, 'src/edit.ts', '2');
    put(repo, 'docs/new.md', 'new');
    put(ws, 'loose.txt', 'not in a repo');
    const top = (await l.call<WsListing>('GET', files('list?dir='))).body;
    expect(top.gitError).toBeNull();
    expect(top.entries.map((e) => [e.name, e.dir, e.git])).toEqual([
      ['clone', true, 'M'],
      ['loose.txt', false, null],
    ]);
    const inClone = (await l.call<WsListing>('GET', files('list?dir=clone'))).body;
    expect(inClone.entries.map((e) => [e.path, e.git])).toEqual([
      ['clone/docs', 'A'],
      ['clone/src', 'M'],
      ['clone/README.md', null],
    ]);
    const src = (await l.call<WsListing>('GET', files('list?dir=clone/src'))).body;
    expect(src.entries.map((e) => [e.name, e.git])).toEqual([
      ['edit.ts', 'M'],
      ['kept.ts', null],
    ]);
    expect((await l.call<WsListing>('GET', files('list?dir=clone/docs'))).body.entries.map((e) => e.git)).toEqual(['A']);
  });

  it('parses git status: renames, untracked folders, folder letters', () => {
    const st = parseStatus(' M a/b.ts\0R  new.ts\0old.ts\0?? docs/\0A  c.ts\0?? x.txt\0');
    expect([...st.files]).toEqual([
      ['a/b.ts', 'M'],
      ['new.ts', 'M'],
      ['c.ts', 'A'],
      ['x.txt', 'A'],
    ]);
    expect(st.untracked).toEqual(['docs']);
    expect(letterOf(st, 'docs/deep/y.md', false)).toBe('A');
    expect(letterOf(st, 'a', true)).toBe('M');
    expect(letterOf(st, 'b', true)).toBeNull();
  });

  it('finds files by words (name first), skipping node_modules and git-ignored files', async () => {
    const { l, files, ws } = await setup();
    const repo = join(ws, 'app');
    put(repo, '.gitignore', 'dist/\n');
    put(repo, 'src/docPanel.ts', '');
    put(repo, 'src/panel/DocPanel.tsx', '');
    put(repo, 'dist/docPanel.js', '');
    git(repo, 'init', '-q');
    put(ws, 'node_modules/x/docPanel.js', '');
    put(ws, 'notes/docpanel-ideas.md', '');
    const r = (await l.call<{ paths: string[] }>('GET', files('find?q=docpanel'))).body;
    // Name starting with the word first, then shorter paths.
    expect(r.paths).toEqual(['app/src/docPanel.ts', 'notes/docpanel-ideas.md', 'app/src/panel/DocPanel.tsx']);
    expect((await l.call<{ paths: string[] }>('GET', files('find?q=src%20panel.tsx'))).body.paths).toEqual(['app/src/panel/DocPanel.tsx']);
  });

  it('turns chat paths into workspace paths: as given, inside a clone (latest written), absolute inside only', async () => {
    const { l, files, ws } = await setup();
    put(ws, 'docs/a.md', '#');
    for (const r of ['one', 'two']) {
      put(join(ws, r), 'src/x.ts', r);
      mkdirSync(join(ws, r, '.git'));
    }
    writeFileSync(join(ws, 'two', 'src/x.ts'), 'two, later'); // written last
    const r = (await l.call<Record<string, string | null>>('POST', files('links'), { paths: ['docs/a.md', './docs/a.md', 'src/x.ts', 'nope.ts', join(ws, 'docs/a.md'), '/etc/hosts'] })).body;
    expect(r).toEqual({ 'docs/a.md': 'docs/a.md', './docs/a.md': 'docs/a.md', 'src/x.ts': 'two/src/x.ts', 'nope.ts': null, [join(ws, 'docs/a.md')]: 'docs/a.md', '/etc/hosts': null });
  });
});

describe('file tabs in the pane (#303)', () => {
  const files = (ts: PanelTab[]) => ts.map((t) => (t.kind === 'file' ? ['file', t.path, t.line, t.active] : t.kind === 'artifact' ? ['artifact', t.doc.path, null, t.active] : ['browser', t.tab.url, null, t.active]));

  it('opens, focuses (line), closes beside artifacts; the active one and the order survive a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-303-'));
    const dbFile = join(dataDir, 'atlas.db');
    const a: Launched = await launch({ dbFile, dataDir, dispatch: false, env: {} });
    const chat = await a.chat();
    put(a.workdir, 'docs/spec.md', '# Spec');
    put(a.workdir, 'src/a.ts', 'a');
    put(a.workdir, 'src/b.ts', 'b');
    const doc = a.engine.documents.indexFile('atlas', 'docs/spec.md', 'atlas');
    a.engine.documents.open(chat.id, doc.id, 'atlas');
    const open = (path: string, line?: number) => a.call<PanelTab[]>('POST', `/chats/${chat.id}/panel/file/open`, { path, line });
    await open('src/a.ts', 42);
    const r = await open('./src/b.ts');
    expect(files(r.body)).toEqual([
      ['artifact', 'docs/spec.md', null, false],
      ['file', 'src/a.ts', 42, false],
      ['file', 'src/b.ts', null, true],
    ]);
    // Opening a missing file or one outside is refused, nothing stored.
    expect((await open('src/none.ts')).status).toBe(404);
    expect((await open('../x')).status).toBe(409);
    const focused = (await a.call<PanelTab[]>('POST', `/chats/${chat.id}/panel/file/focus`, { path: 'src/a.ts' })).body;
    expect(files(focused)[1]).toEqual(['file', 'src/a.ts', null, true]);
    const before = (await a.call<PanelTab[]>('POST', `/chats/${chat.id}/panel/file/close`, { path: 'src/b.ts' })).body;
    expect(before).toHaveLength(2);
    await a.engine.stop();

    const b = await launch({ dbFile, dataDir, dispatch: false, env: {} });
    const after = (await b.call<PanelTab[]>('GET', `/chats/${chat.id}/panel`)).body;
    expect(after).toEqual(before);
    expect((after.find((t) => t.active) as FileTab).path).toBe('src/a.ts');
    // Closing the panel closes files too.
    expect((await b.call<PanelTab[]>('POST', `/chats/${chat.id}/panel/close`, { docId: null })).body).toEqual([]);
    await eventually(() => b.engine.documents.tabs(chat.id).length === 0, { what: 'no tab' });
  });

  it('a link to a served file opens its artifact, else the file of the chat\'s workspace; anything else is 404 (#339)', async () => {
    const l = await launch({ dispatch: false, env: {} });
    const chat = await l.chat();
    put(l.workdir, 'images/atlas x.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    put(l.workdir, 'pages/a.html', '<h1>A</h1>');
    mkdirSync(join(l.workdir, 'empty'));
    const doc = l.engine.documents.indexFile('atlas', 'pages/a.html', 'atlas');
    const link = (url: unknown) => l.call<PanelTab[]>('POST', `/chats/${chat.id}/panel/link`, { url });
    const r = await link('http://127.0.0.1:1/api/files/atlas/pages/a.html');
    const page = r.body;
    expect(page.find((t) => t.active)).toMatchObject({ kind: 'artifact', doc: { id: doc.id } });
    const image = (await link('/api/files/atlas/images/atlas%20x.png')).body;
    expect(files(image)).toEqual([
      ['artifact', 'pages/a.html', null, false],
      ['file', 'images/atlas x.png', null, true],
    ]);
    expect((await link('/api/files/atlas/images/none.png')).status).toBe(404);
    expect((await link('/api/files/atlas/empty')).status).toBe(404);
    expect((await link('/api/files/nobody/a.png')).status).toBe(404);
    expect((await link('/api/cards')).status).toBe(400);
    expect((await link(42)).status).toBe(400);
    await l.engine.stop();
  });
});
