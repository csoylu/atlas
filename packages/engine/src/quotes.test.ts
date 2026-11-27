import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatQuote, parseQuote, quoteTime } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { userText } from './rewind.ts';

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-quotes-'));
  const engine = await startEngine({ dbFile: ':memory:', dataDir, port: 0, dispatch: false, memoryReview: false, providers: () => new FakeProvider([]), env: {}, pageShots: false });
  engines.push(engine);
  return engine;
}
const send = (e: Engine, card: string, body: unknown) =>
  fetch(`${e.url}/api/cards/${card}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
type Sent = { content: { type: string; text: string }[] };

describe('quotes: the text block (shared, #367)', () => {
  it('formats a quote the agent can read and the UI reads back: prose as > lines, code fenced, the note last', () => {
    const prose = formatQuote({ n: 1, on: { kind: 'message', seq: 42 }, passage: 'quotes reuse the chips.\n\nBoth in one message.', code: false, note: 'Yes, one family' }, 'atlas', '26 Nov 2026, 21:28');
    expect(prose).toBe('[quote 1] atlas · 26 Nov 2026, 21:28 · message 42 in this chat\n> quotes reuse the chips.\n>\n> Both in one message.\nNote: Yes, one family');
    expect(parseQuote(prose)).toEqual({ n: 1, who: 'atlas', when: '26 Nov 2026, 21:28', seq: 42, on: { kind: 'message', seq: 42 }, tool: null, passage: 'quotes reuse the chips.\n\nBoth in one message.', code: false, note: 'Yes, one family' });
    const code = formatQuote({ n: 2, on: { kind: 'message', seq: 7 }, passage: 'const a = `x`;\n```nested```\n', code: true, note: '' }, 'Master', '1 Dec 2026, 09:05');
    expect(code).toBe('[quote 2] Master · 1 Dec 2026, 09:05 · message 7 in this chat\n````\nconst a = `x`;\n```nested```\n````');
    expect(parseQuote(code)).toMatchObject({ n: 2, code: true, passage: 'const a = `x`;\n```nested```', note: '' });
    expect(parseQuote('[quote 1] atlas said\nhi')).toBeNull();
    expect(parseQuote('Just text')).toBeNull();
    expect(quoteTime('2026-11-26T20:28:00Z', 'Europe/Paris')).toBe('26 Nov 2026, 21:28');
  });
});

describe('quotes: what reaches the agent (#367)', () => {
  it('a quote of a message in the chat: one block before the text, numbered with the comments, the full passage', async () => {
    const engine = await setup();
    const chat = engine.kanban.newChat('atlas');
    engine.kanban.appendMessage(chat.id, 'assistant', 'atlas', [{ type: 'text', text: 'Same family as comments: quotes reuse the chips.\n\n```ts\nconst x = 1;\n```' }]);
    const seq = engine.kanban.messages(chat.id).at(-1)!.seq;
    const res = await send(engine, chat.id, {
      text: 'And a question.',
      quotes: [
        { n: 2, on: { kind: 'message', seq }, passage: 'const x = 1;', code: true },
        { n: 1, on: { kind: 'message', seq }, passage: 'quotes reuse the chips.', note: 'Yes, one family' },
      ],
    });
    expect(res.status).toBe(201);
    const { content } = (await res.json()) as Sent;
    expect(content.map((b) => parseQuote(b.text)?.n ?? b.text)).toEqual([1, 2, 'And a question.']);
    expect(content[0]!.text).toMatch(new RegExp(`^\\[quote 1\\] atlas · \\d{1,2} \\w{3} \\d{4}, \\d{2}:\\d{2} · message ${seq} in this chat\\n> quotes reuse the chips\\.\\nNote: Yes, one family$`));
    expect(content[1]!.text).toContain('```\nconst x = 1;\n```');
    // The text Master typed (a rewind puts it back) leaves the quotes out.
    expect(userText(engine.kanban.messages(chat.id).at(-1)!)).toBe('And a question.');
  });

  it('quotes only: Master’s own message is quoted under their name; a message no longer in the chat is refused', async () => {
    const engine = await setup();
    const chat = engine.kanban.newChat('atlas');
    engine.kanban.appendMessage(chat.id, 'user', 'user', [{ type: 'text', text: 'my first words' }]);
    const seq = engine.kanban.messages(chat.id).at(-1)!.seq;
    const res = await send(engine, chat.id, { quotes: [{ n: 1, on: { kind: 'message', seq }, passage: 'first words', note: 'Look again' }] });
    expect(res.status).toBe(201);
    expect(parseQuote(((await res.json()) as Sent).content[0]!.text)).toMatchObject({ who: 'the user', note: 'Look again', passage: 'first words' });
    const gone = await send(engine, chat.id, { quotes: [{ n: 1, on: { kind: 'message', seq: 999 }, passage: 'x' }] });
    expect(gone.status).toBe(400);
    expect(await gone.text()).toContain('message 999 is no longer in this chat');
    expect((await send(engine, chat.id, { text: '', quotes: [] })).status).toBe(400);
  });
});
