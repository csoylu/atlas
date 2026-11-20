import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { anchorLabel, formatComment, parseComment, type ImageBlock } from '@atlas/shared';
import type { PageShot } from './comments.ts';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { userText } from './rewind.ts';
import type { SecretStore } from './secrets.ts';

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

const PLAN = '# Workflows v2 · build plan\n\nDesign: pages/atlas-redesign.html.\n\n## Decisions\n\nEditor: the canvas stays.\nPriorities: High / Medium / Low.\n';
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 260" width="360" height="260"><rect width="360" height="260" fill="#fff"/>' +
  '<g id="chromium"><rect x="200" y="110" width="150" height="54" fill="#36f"/><text x="212" y="133">Chromium (server)</text></g></svg>';
const PAGE = '<!doctype html><title>Settings mockup</title><body><div class="setting-row">Network</div></body>';
const CODE = Array.from({ length: 12 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');

class MemoryStore implements SecretStore {
  label = 'test store';
  map = new Map<string, string>();
  names = () => [...this.map.keys()];
  get = (n: string) => this.map.get(n);
  set = (n: string, v: string) => void this.map.set(n, v);
  delete = (n: string) => void this.map.delete(n);
}

async function setup(o: { fake?: FakeProvider; pageShots?: false | PageShot; dbFile?: string; dataDir?: string; secrets?: SecretStore } = {}) {
  const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-comments-'));
  const fake = o.fake ?? new FakeProvider([]);
  const engine = await startEngine({ dbFile: o.dbFile ?? ':memory:', dataDir, port: 0, dispatch: false, memoryReview: false, providers: () => fake, env: {}, pageShots: o.pageShots ?? false, ...(o.secrets ? { secrets: o.secrets } : {}) });
  engines.push(engine);
  const ws = join(dataDir, 'workspaces', 'atlas');
  const put = (rel: string, content: string | Buffer) => {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), content);
  };
  return { engine, fake, ws, put, dataDir };
}
const send = (e: Engine, card: string, body: unknown) =>
  fetch(`${e.url}/api/cards/${card}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('comments: the text block (shared)', () => {
  it('formats a comment the agent can act on and the UI can read back', () => {
    const text = formatComment(
      3,
      { title: 'docPanel.ts', what: 'file packages/ui/src/docPanel.ts' },
      { type: 'lines', from: 5, to: 6 },
      'Use the same breakpoints.',
      { source: { from: 5, lines: ['export const a = 1;', 'export const b = 2;'] } },
    );
    expect(text).toBe(
      '[comment 3] docPanel.ts · lines 5–6\n(on file packages/ui/src/docPanel.ts, lines 5–6)\n> export const a = 1;\n> export const b = 2;\nComment: Use the same breakpoints.',
    );
    expect(parseComment(text)).toEqual({
      n: 3,
      label: 'docPanel.ts · lines 5–6',
      docId: null,
      version: null,
      section: null,
      path: 'packages/ui/src/docPanel.ts',
      lines: [5, 6],
      quoted: ['export const a = 1;', 'export const b = 2;'],
      selected: null,
      comment: 'Use the same breakpoints.',
    });
    expect(parseComment('just text')).toBeNull();
    expect(anchorLabel({ type: 'element', selector: 'button.go', text: 'Search', tag: 'button' })).toBe('« Search » button');
    expect(anchorLabel({ type: 'spot', x: 62, y: 38, of: { w: 100, h: 100 }, unit: 'px', under: null })).toBe('a spot at 62 %, 38 %');
  });
});

describe('comments: what reaches the agent (#304)', () => {
  it('a paragraph of markdown, an svg element, an html area and lines of a file: each says exactly where', async () => {
    const fake = new FakeProvider([[{ type: 'text', text: 'On it.' }]]);
    const shots: Parameters<PageShot>[0][] = [];
    const shoot: PageShot = async (o) => {
      shots.push(o);
      const file = join(o.workdir, 'screenshots', 'area.png');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, await sharp({ create: { width: 40, height: 30, channels: 3, background: '#0a0' } }).png().toBuffer());
      return file;
    };
    const { engine, put, ws } = await setup({ fake, pageShots: shoot });
    put('docs/plan.md', PLAN);
    put('diagrams/browser.svg', SVG);
    put('pages/settings.html', PAGE);
    put('packages/ui/src/docPanel.ts', CODE);
    const md = engine.documents.indexFile('atlas', 'docs/plan.md', 'atlas');
    const svg = engine.documents.indexFile('atlas', 'diagrams/browser.svg', 'atlas');
    const page = engine.documents.indexFile('atlas', 'pages/settings.html', 'atlas');
    const chat = engine.kanban.newChat('atlas');

    const res = await send(engine, chat.id, {
      text: 'Three things on these, and one in the code.',
      comments: [
        { target: { kind: 'doc', docId: md.id, version: 1 }, anchor: { type: 'text', quote: 'Editor: the canvas stays.', section: null, lines: [7, 8] }, text: 'Say which canvas.' },
        {
          target: { kind: 'doc', docId: svg.id, version: 1 },
          anchor: { type: 'element', selector: 'svg > g#chromium > rect', text: 'Chromium (server)', tag: 'rect' },
          text: 'One process per chat, or one shared?',
        },
        {
          target: { kind: 'doc', docId: page.id, version: 1 },
          anchor: { type: 'area', box: { x: 20, y: 110, w: 300, h: 60 }, of: { w: 640, h: 900 }, unit: 'px', inside: [{ selector: 'div.setting-row', text: 'Network' }] },
          text: 'Say which hosts are allowed.',
        },
        { target: { kind: 'file', path: 'packages/ui/src/docPanel.ts' }, anchor: { type: 'lines', from: 5, to: 6 }, text: 'Use the same breakpoints.' },
      ],
    });
    expect(res.status).toBe(201);
    expect(shots).toEqual([{ page: '/api/files/atlas/pages/settings.html', width: 640, height: 900, region: { x: 20, y: 110, w: 300, h: 60 }, workdir: ws }]);

    engine.runner.wake(chat.id);
    await engine.runner.settled(chat.id);
    const sent = fake.calls[0]!.messages.at(-1)!.content;
    const texts = sent.flatMap((b) => (b.type === 'text' ? [b.text] : []));
    expect(texts[0]).toBe('Three things on these, and one in the code.');
    expect(texts[1]).toBe(
      `[comment 1] Workflows v2 · build plan · « Editor: the canvas stays. »\n(on markdown docs/plan.md in atlas's workspace, ${md.id} v1, section #decisions, lines 7–8)\nSelected: « Editor: the canvas stays. »\nComment: Say which canvas.`,
    );
    expect(texts[2]).toBe(
      `[comment 2] browser.svg · « Chromium (server) » box\n(on svg diagram diagrams/browser.svg in atlas's workspace, ${svg.id} v1, element svg > g#chromium > rect)\nElement text: « Chromium (server) »\nComment: One process per chat, or one shared?`,
    );
    expect(texts[3]).toContain(`(on html page pages/settings.html in atlas's workspace, ${page.id} v1, area x=20 y=110 w=300 h=60 px of 640×900)`);
    expect(texts[3]).toContain('Inside: div.setting-row « Network »');
    expect(texts[3]).toContain('Picture of the area: screenshots/area.png (attached below)');
    expect(texts[4]).toBe(
      '[comment 4] docPanel.ts · lines 5–6\n(on file packages/ui/src/docPanel.ts, lines 5–6)\n> const line5 = 5;\n> const line6 = 6;\nComment: Use the same breakpoints.',
    );
    // The area's picture goes to the model as an image, right after its comment.
    const pic = sent[sent.findIndex((b) => b.type === 'text' && b.text.startsWith('[comment 3]')) + 1] as ImageBlock;
    expect(pic).toMatchObject({ type: 'image', width: 40, height: 30, data: expect.any(String) });
    // The system prompt says what the blocks are.
    expect(fake.calls[0]!.system).toContain('A [comment N] block is');
    // Rewind puts back only what was typed.
    expect(userText(engine.kanban.messages(chat.id).find((m) => m.role === 'user')!)).toBe('Three things on these, and one in the code.');
  });

  it('crops an area of an svg or an image; says why when there is no picture; kept across a restart', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-comments-'));
    const dbFile = join(dataDir, 'atlas.db');
    const ok = () => new FakeProvider([[{ type: 'text', text: 'ok' }], [{ type: 'text', text: 'ok' }]]);
    let s = await setup({ dataDir, dbFile, fake: ok() });
    s.put('diagrams/browser.svg', SVG);
    s.put('shots/chat.png', await sharp({ create: { width: 200, height: 100, channels: 3, background: '#fff' } }).png().toBuffer());
    s.put('links/shot.url', '/api/files/atlas/shots/chat.png\n');
    s.put('pages/settings.html', PAGE);
    const svg = s.engine.documents.indexFile('atlas', 'diagrams/browser.svg', 'atlas');
    const link = s.engine.documents.indexFile('atlas', 'links/shot.url', 'atlas');
    const page = s.engine.documents.indexFile('atlas', 'pages/settings.html', 'atlas');
    const chat = s.engine.kanban.newChat('atlas');
    const area = (x: number, y: number, w: number, h: number, of: { w: number; h: number }, unit: 'px' | 'svg') => ({ type: 'area', box: { x, y, w, h }, of, unit, inside: [] });
    const res = await send(s.engine, chat.id, {
      comments: [
        { target: { kind: 'doc', docId: svg.id, version: 1 }, anchor: area(200, 110, 150, 54, { w: 360, h: 260 }, 'svg'), text: 'This box.' },
        { target: { kind: 'doc', docId: link.id, version: 1 }, anchor: area(100, 0, 50, 50, { w: 200, h: 100 }, 'px'), text: 'Too faint.' },
        { target: { kind: 'doc', docId: page.id, version: 1 }, anchor: area(0, 0, 50, 50, { w: 640, h: 900 }, 'px'), text: 'Here.' },
        { target: { kind: 'doc', docId: link.id, version: 1 }, anchor: { type: 'spot', x: 124, y: 38, of: { w: 200, h: 100 }, unit: 'px' }, text: 'A spot.' },
      ],
    });
    expect(res.status).toBe(201);
    const pics = s.engine.kanban.messages(chat.id).at(-1)!.content.filter((b): b is ImageBlock => b.type === 'image');
    // The svg is rendered at 2× (density 144): 150×54 svg units → 300×108 px; the image keeps its own pixels.
    expect(pics.map((p) => [p.width, p.height])).toEqual([[300, 108], [50, 50]]);
    for (const p of pics) expect(existsSync(p.path)).toBe(true);
    const texts = s.engine.kanban.messages(chat.id).at(-1)!.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
    expect(texts[1]).toContain(`address /api/files/atlas/shots/chat.png, area x=100 y=0 w=50 h=50 px of 200×100`);
    expect(texts[2]).toContain('No picture: pages are not shot here');
    expect(texts[3]).toContain('spot x=124 y=38 px of 200×100 (62 %, 38 %)');

    // A restart keeps the message, its pictures and the text the agent reads.
    await s.engine.runner.settled(chat.id);
    const before = JSON.stringify(s.engine.kanban.messages(chat.id));
    await s.engine.stop();
    engines = [];
    s = await setup({ dataDir, dbFile, fake: ok() });
    expect(JSON.stringify(s.engine.kanban.messages(chat.id))).toBe(before);
    expect(readFileSync(pics[0]!.path).length).toBeGreaterThan(0);
  });

  it('refuses a comment on a file that is not there, or on lines past its end', async () => {
    const { engine, put } = await setup();
    put('a.ts', 'one\ntwo\n');
    const chat = engine.kanban.newChat('atlas');
    const bad = await send(engine, chat.id, { comments: [{ target: { kind: 'file', path: 'missing.ts' }, anchor: { type: 'lines', from: 1, to: 1 }, text: 'x' }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/missing\.ts does not exist/);
    const past = await send(engine, chat.id, { comments: [{ target: { kind: 'file', path: 'a.ts' }, anchor: { type: 'lines', from: 9, to: 10 }, text: 'x' }] });
    expect(past.status).toBe(400);
    expect(engine.kanban.messages(chat.id).filter((m) => m.role === 'user')).toEqual([]);
  });

  it('never quotes a secret (rule 5): file lines are redacted before they are stored or sent; a dotfile is refused', async () => {
    const CANARY = 'canary-304-ZXCVBN-97531';
    const fake = new FakeProvider([[{ type: 'text', text: 'ok' }]]);
    const { engine, put } = await setup({ fake, secrets: new MemoryStore() });
    engine.secrets.create({ name: 'CANARY_KEY', value: CANARY, description: '', grant: 'all', agents: [], project: null }, { by: 'user' });
    put('src/config.ts', `const a = 1;\nconst key = '${CANARY}';\nconst b = 2;\n`);
    put('.env', `CANARY_KEY=${CANARY}\n`);
    put('.git/config', '[core]\n');
    const chat = engine.kanban.newChat('atlas');
    for (const path of ['.env', '.git/config']) {
      const hidden = await send(engine, chat.id, { comments: [{ target: { kind: 'file', path }, anchor: { type: 'lines', from: 1, to: 1 }, text: 'x' }] });
      expect(hidden.status).toBe(400);
      expect(((await hidden.json()) as { error: string }).error).toMatch(/hidden file/);
    }
    const res = await send(engine, chat.id, { text: 'Look', comments: [{ target: { kind: 'file', path: 'src/config.ts' }, anchor: { type: 'lines', from: 1, to: 3 }, text: `Move ${CANARY} out` }] });
    expect(res.status).toBe(201);
    const stored = JSON.stringify(engine.kanban.messages(chat.id));
    expect(stored).not.toContain(CANARY);
    expect(stored).toContain("> const key = '[secret CANARY_KEY]';");
    expect(stored).toContain('Comment: Move [secret CANARY_KEY] out');
    engine.runner.wake(chat.id);
    await engine.runner.settled(chat.id);
    expect(fake.calls.length).toBe(1);
    expect(JSON.stringify(fake.calls[0]!.messages)).toContain('[secret CANARY_KEY]');
    expect(JSON.stringify(fake.calls[0])).not.toContain(CANARY);
  });
});

describe('comments: a page in the pane (#304)', () => {
  it('?pane=1 serves an html page with the comment helper, secrets still hidden; without it the file is as on disk', async () => {
    const { engine, put } = await setup();
    put('pages/settings.html', PAGE);
    const url = `${engine.url}/api/files/atlas/pages/settings.html`;
    const plain = await (await fetch(url)).text();
    expect(plain).toBe(PAGE);
    const res = await fetch(url + '?pane=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toMatch(/^sandbox /);
    const pane = await res.text();
    expect(pane.startsWith(PAGE.slice(0, PAGE.indexOf('</body>')))).toBe(true);
    expect(pane).toContain('__atlasPane');
    // Not a page: served as it is.
    put('diagrams/b.svg', SVG);
    expect(await (await fetch(`${engine.url}/api/files/atlas/diagrams/b.svg?pane=1`)).text()).toBe(SVG);
  });
});

describe('comments: a chat named by its words (#304)', () => {
  it('a first message made only of comments names the chat after the comment, not its place line', async () => {
    const fake = new FakeProvider([[{ type: 'text', text: 'ok' }]]);
    const { engine, put } = await setup({ fake });
    put('docs/plan.md', PLAN);
    const md = engine.documents.indexFile('atlas', 'docs/plan.md', 'atlas');
    const chat = engine.kanban.newChat('atlas');
    const res = await send(engine, chat.id, { text: '', comments: [{ target: { kind: 'doc', docId: md.id, version: 1 }, anchor: { type: 'text', quote: 'Editor: the canvas stays.', section: 'decisions', lines: [7, 7] }, text: 'Say which canvas.' }] });
    expect(res.status).toBe(201);
    expect(engine.kanban.get(chat.id)!.title).toBe('Say which canvas.');
    const parsed = parseComment(((await res.json()) as { content: { type: string; text: string }[] }).content[0]!.text)!;
    expect(parsed.selected).toBe('Editor: the canvas stays.');
    expect(parsed.section).toBe('decisions');
  });
});
