import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatQuote, parseComment, parseQuote } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { userText } from './rewind.ts';

// #368: a selection on every surface (a document, a page, a code file, the browser, a tool row, the task's text)
// reaches the agent with what it needs to find the exact place: pane tabs as #304 comments with a text anchor, chat
// surfaces as [quote N] blocks.

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

const PLAN = '# Plan\n\n## Decisions\n\nEditor: the canvas stays.\nPriorities: High / Medium / Low.\n';
const PAGE = '<!doctype html><title>Settings</title><body><div class="setting-row">Network hosts allowed</div></body>';
const CODE = Array.from({ length: 12 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-quotes-all-'));
  const fake = new FakeProvider([[{ type: 'text', text: 'On it.' }]]);
  const engine = await startEngine({ dbFile: ':memory:', dataDir, port: 0, dispatch: false, memoryReview: false, providers: () => fake, env: {}, pageShots: false });
  engines.push(engine);
  const ws = join(dataDir, 'workspaces', 'atlas');
  const put = (rel: string, content: string) => {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), content);
  };
  return { engine, fake, put };
}
const send = (e: Engine, card: string, body: unknown) =>
  fetch(`${e.url}/api/cards/${card}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** What the model got as the last user message's text blocks. */
async function toModel(engine: Engine, fake: FakeProvider, chatId: string): Promise<string[]> {
  engine.runner.wake(chatId);
  await engine.runner.settled(chatId);
  return fake.calls[0]!.messages.at(-1)!.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
}

describe('quotes everywhere: the text blocks (shared, #368)', () => {
  it('a tool row and the task description have their own head, read back with where they are from', () => {
    const tool = formatQuote({ n: 3, on: { kind: 'tool', seq: 12, call: 'toolu_01' }, passage: 'npm ERR! missing script', code: true, note: 'Why?' }, 'atlas', '27 Nov 2026, 10:05', 'shell');
    expect(tool).toBe('[quote 3] atlas · 27 Nov 2026, 10:05 · shell call toolu_01 in message 12 in this chat\n```\nnpm ERR! missing script\n```\nNote: Why?');
    expect(parseQuote(tool)).toMatchObject({ n: 3, seq: 12, on: { kind: 'tool', seq: 12, call: 'toolu_01' }, tool: 'shell', code: true, note: 'Why?' });
    const task = formatQuote({ n: 1, on: { kind: 'task' }, passage: 'One PR, one changelog entry.', code: false, note: '' }, 'task #368', '27 Nov 2026, 09:00');
    expect(task).toBe("[quote 1] task #368 · 27 Nov 2026, 09:00 · this task's description\n> One PR, one changelog entry.");
    expect(parseQuote(task)).toMatchObject({ n: 1, who: 'task #368', seq: 0, on: { kind: 'task' }, tool: null, passage: 'One PR, one changelog entry.' });
    expect(parseQuote('[quote 1] atlas · 27 Nov 2026, 10:05 · message 4 in this chat\n> hi')).toMatchObject({ on: { kind: 'message', seq: 4 }, seq: 4, tool: null });
  });
});

describe('quotes everywhere: what reaches the model (#368, fake provider)', () => {
  it('markdown, an html page, a code file, a browser page and a shell output: each one block that says where', async () => {
    const { engine, fake, put } = await setup();
    put('docs/plan.md', PLAN);
    put('pages/settings.html', PAGE);
    put('src/app.ts', CODE);
    const md = engine.documents.indexFile('atlas', 'docs/plan.md', 'atlas');
    const page = engine.documents.indexFile('atlas', 'pages/settings.html', 'atlas');
    const chat = engine.kanban.newChat('atlas');
    engine.kanban.appendMessage(chat.id, 'assistant', 'atlas', [
      { type: 'text', text: 'Running the build.' },
      { type: 'tool_use', id: 'toolu_build', name: 'shell', input: { command: 'npm run build' } },
    ]);
    const seq = engine.kanban.messages(chat.id).at(-1)!.seq;
    engine.kanban.appendMessage(chat.id, 'user', 'tool', [{ type: 'tool_result', tool_use_id: 'toolu_build', content: 'npm ERR! missing script: build' }]);

    const res = await send(engine, chat.id, {
      text: 'Five places.',
      comments: [
        { n: 1, target: { kind: 'doc', docId: md.id, version: 1 }, anchor: { type: 'text', quote: 'the canvas stays', section: null, lines: [5, 5] }, text: 'Which canvas?' },
        { n: 2, target: { kind: 'doc', docId: page.id, version: 1 }, anchor: { type: 'text', quote: 'hosts allowed', selector: 'body > div.setting-row' } },
        { n: 3, target: { kind: 'file', path: 'src/app.ts' }, anchor: { type: 'text', quote: 'line4 = 4;\nconst line5', lines: [4, 5] }, text: 'Rename.' },
        { n: 4, target: { kind: 'browser', url: 'https://example.com/docs', title: 'Example docs' }, anchor: { type: 'text', quote: 'Install the CLI', selector: 'main > h2:nth-of-type(2)' }, text: 'Do this first.' },
      ],
      quotes: [{ n: 5, on: { kind: 'tool', seq, call: 'toolu_build' }, passage: 'missing script: build', code: true, note: 'Add it.' }],
    });
    expect(res.status).toBe(201);
    const texts = await toModel(engine, fake, chat.id);
    expect(texts.at(-1)).toBe('Five places.');
    expect(texts[0]).toBe(
      `[comment 1] Plan · « the canvas stays »\n(on markdown docs/plan.md in atlas's workspace, ${md.id} v1, section #decisions, line 5)\nSelected: « the canvas stays »\nComment: Which canvas?`,
    );
    // No note: the passage alone (a quote's note is optional); the element it sits in.
    expect(texts[1]).toBe(
      `[comment 2] Settings · « hosts allowed »\n(on html page pages/settings.html in atlas's workspace, ${page.id} v1, in element body > div.setting-row)\nSelected: « hosts allowed »`,
    );
    expect(texts[2]).toBe('[comment 3] app.ts · « line4 = 4; const line5 »\n(on file src/app.ts, lines 4–5)\nSelected: « line4 = 4; const line5 »\n> const line4 = 4;\n> const line5 = 5;\nComment: Rename.');
    expect(texts[3]).toBe(
      "[comment 4] Example docs · « Install the CLI »\n(on page https://example.com/docs in the chat's browser, in element main > h2:nth-of-type(2))\nSelected: « Install the CLI »\nComment: Do this first.",
    );
    expect(texts[4]).toMatch(new RegExp(`^\\[quote 5\\] atlas · .+ · shell call toolu_build in message ${seq} in this chat\\n\`\`\`\\nmissing script: build\\n\`\`\`\\nNote: Add it\\.$`));
    // The cards read them back: the page's comment, its passage, no words.
    expect(parseComment(texts[1]!)).toMatchObject({ n: 2, docId: page.id, version: 1, selected: 'hosts allowed', selector: 'body > div.setting-row', comment: '' });
    expect(parseComment(texts[2]!)).toMatchObject({ path: 'src/app.ts', lines: [4, 5], quoted: ['const line4 = 4;', 'const line5 = 5;'], comment: 'Rename.' });
    expect(parseComment(texts[3]!)).toMatchObject({ url: 'https://example.com/docs', selector: 'main > h2:nth-of-type(2)', selected: 'Install the CLI' });
    expect(userText(engine.kanban.messages(chat.id).find((m) => m.author === 'user')!)).toBe('Five places.');
  });

  it('three surfaces and a chat quote in one message, numbered in the order they were added', async () => {
    const { engine, fake, put } = await setup();
    put('docs/plan.md', PLAN);
    put('src/app.ts', CODE);
    const md = engine.documents.indexFile('atlas', 'docs/plan.md', 'atlas');
    const task = engine.kanban.create({ title: 'Quote everything', body: 'Typing q in an input types a q.', assignee: 'atlas', status: 'done' }, 'user');
    engine.kanban.appendMessage(task.id, 'assistant', 'atlas', [{ type: 'text', text: 'The pill is the same everywhere.' }]);
    const said = engine.kanban.messages(task.id).at(-1)!.seq;
    const res = await send(engine, task.id, {
      text: '',
      comments: [
        { n: 3, target: { kind: 'file', path: 'src/app.ts' }, anchor: { type: 'text', quote: 'const line2', lines: [2, 2] } },
        { n: 1, target: { kind: 'doc', docId: md.id, version: 1 }, anchor: { type: 'text', quote: 'High / Medium / Low', lines: [6, 6] } },
      ],
      quotes: [
        { n: 4, on: { kind: 'message', seq: said }, passage: 'the same everywhere' },
        { n: 2, on: { kind: 'task' }, passage: 'types a q', note: 'Test it.' },
      ],
    });
    expect(res.status).toBe(201);
    const texts = await toModel(engine, fake, task.id);
    expect(texts.map((t) => parseComment(t)?.n ?? parseQuote(t)?.n)).toEqual([1, 2, 3, 4]);
    expect(texts[1]).toMatch(new RegExp(`^\\[quote 2\\] task #${task.number} · .+ · this task's description\\n> types a q\\nNote: Test it\\.$`));
  });

  it('refuses what is not there: a tool call the message lacks, file lines past its end, a comment with no words', async () => {
    const { engine, put } = await setup();
    put('src/app.ts', CODE);
    const chat = engine.kanban.newChat('atlas');
    engine.kanban.appendMessage(chat.id, 'assistant', 'atlas', [{ type: 'text', text: 'No tools here.' }]);
    const seq = engine.kanban.messages(chat.id).at(-1)!.seq;
    const noCall = await send(engine, chat.id, { quotes: [{ n: 1, on: { kind: 'tool', seq, call: 'toolu_x' }, passage: 'x' }] });
    expect(noCall.status).toBe(400);
    expect(await noCall.text()).toContain(`message ${seq} has no tool call toolu_x`);
    const past = await send(engine, chat.id, { comments: [{ target: { kind: 'file', path: 'src/app.ts' }, anchor: { type: 'text', quote: 'x', lines: [40, 41] } }] });
    expect(past.status).toBe(400);
    expect(await past.text()).toContain('has 12 lines, not 40–41');
    // Only a selected passage may come without words; a pin or an area needs them.
    const bare = await send(engine, chat.id, { comments: [{ target: { kind: 'file', path: 'src/app.ts' }, anchor: { type: 'lines', from: 1, to: 2 } }] });
    expect(bare.status).toBe(400);
  });
});
