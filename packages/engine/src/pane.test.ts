import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PANE_MARK, USER, VOICE_MARK, paneLabel, paneLine, type Card, type Message, type PaneSees } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import { paneNote } from './pane.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});
const json = { 'content-type': 'application/json' };

const doc: PaneSees = { kind: 'artifact', docId: 'doc_ab12', title: 'Build plan (#250)', agentId: 'paris', path: 'docs/build-plan.md', version: 3 };
const file: PaneSees = { kind: 'file', path: 'packages/ui/src/docPanel.ts', from: 40, to: 82 };
const task: PaneSees = { kind: 'task', number: 12, title: 'Fix the empty state' };
const page: PaneSees = { kind: 'browser', url: 'http://localhost:5173/tenders?q=road', title: 'Tenders' };

describe('what the agent sees (#305)', () => {
  it('gives one short line per kind, and the tab name the composer shows', () => {
    expect(paneLine(doc)).toBe(`${PANE_MARK}Open in my pane: artifact « Build plan (#250) » (doc_ab12 v3, @paris:docs/build-plan.md)`);
    expect(paneLine(file)).toBe(`${PANE_MARK}Open in my pane: file packages/ui/src/docPanel.ts, lines 40–82`);
    expect(paneLine(task)).toBe(`${PANE_MARK}Open in my pane: task #12 « Fix the empty state »`);
    expect(paneLine(page)).toBe(`${PANE_MARK}Open in my pane: web page « Tenders » at http://localhost:5173/tenders?q=road`);
    expect([doc, file, task, page].map(paneLabel)).toEqual(['Build plan (#250)', 'docPanel.ts', '#12 Fix the empty state', 'Tenders · localhost:5173']);
  });

  it('says it again after the summary folded the message that said it', () => {
    const said: Message = { id: 'm1', conversationId: 'v', seq: 1, role: 'user', author: USER, content: [{ type: 'text', text: 'hi' }, { type: 'text', text: paneLine(doc) }], at: '', pane: doc };
    expect(paneNote([said], doc, null)).toBeNull();
    expect(paneNote([said], doc, 1)).toBe(paneLine(doc));
    expect(paneNote([said], null, null)).toBeNull();
  });

  it('attaches the open tab to Master’s message when it changed, stores it, and voice messages take what the pane reported', async () => {
    const fake = new FakeProvider(Array.from({ length: 12 }, () => [{ type: 'text' as const, text: 'ok' }]));
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, providers: () => fake, memoryReview: false });
    const u = engine.url + '/api';
    const chat = (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as Card;
    // Sends a message (with `pane` when given, none at all for a voice message) and returns what the model got.
    const send = async (text: string, pane?: PaneSees | null): Promise<string> => {
      const n = fake.calls.length;
      const res = await fetch(u + `/cards/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify(pane === undefined ? { text } : { text, pane }) });
      expect(res.status).toBe(201);
      await expect.poll(() => fake.calls.length > n && !engine!.kanban.get(chat.id).working, { timeout: 5000 }).toBe(true);
      const last = fake.calls.at(-1)!.messages.filter((m) => m.role === 'user').at(-1)!;
      return (typeof last.content === 'string' ? last.content : last.content.map((b) => (b.type === 'text' ? b.text : ''))).join('\n');
    };
    const marks = (s: string) => s.split('\n').filter((l) => l.startsWith(PANE_MARK));

    // Each kind: its line, after Master's text.
    const first = await send('what do you think?', doc);
    expect(marks(first)).toEqual([paneLine(doc)]);
    expect(first.indexOf('what do you think?')).toBeLessThan(first.indexOf(PANE_MARK));
    expect(engine.kanban.get(chat.id).title).toBe('what do you think?'); // the line never names the chat
    // Unchanged: not repeated (the prompt stays small).
    expect(marks(await send('and the second part?', doc))).toEqual([]);
    // The eye off (or the pane closed): nothing.
    expect(marks(await send('unrelated', null))).toEqual([]);
    // Back on with the same tab: it changed since the last message (nothing was open), so it is said again.
    expect(marks(await send('back to it', doc))).toEqual([paneLine(doc)]);
    // Another version of the same artifact is a change.
    expect(marks(await send('v4 now', { ...doc, version: 4 }))).toEqual([paneLine({ ...doc, version: 4 })]);
    expect(marks(await send('this code', file))).toEqual([paneLine(file)]);
    expect(marks(await send('scrolled', { ...file, from: 90, to: 130 }))).toEqual([paneLine({ ...file, from: 90, to: 130 })]);
    expect(marks(await send('this task', task))).toEqual([paneLine(task)]);
    expect(marks(await send('this page', page))).toEqual([paneLine(page)]);

    // Voice (no composer): what the chat's UI last reported; nothing once it reports the pane closed.
    const report = (pane: PaneSees | null) => fetch(u + `/cards/${chat.id}/pane`, { method: 'PUT', headers: json, body: JSON.stringify({ pane }) });
    expect((await report(task)).status).toBe(204);
    expect(marks(await send(VOICE_MARK + 'read it to me'))).toEqual([paneLine(task)]);
    await report(null);
    expect(marks(await send(VOICE_MARK + 'thanks'))).toEqual([]);
    expect((await fetch(u + `/cards/${chat.id}/pane`, { method: 'PUT', headers: json, body: JSON.stringify({ pane: { kind: 'file', path: '' } }) })).status).toBe(400);

    // Stored with each message (rule 2): the pane state, and the line only where it was said.
    const mine = engine.kanban.messages(chat.id).filter((m) => m.author === USER);
    expect(mine.map((m) => m.pane?.kind ?? null)).toEqual(['artifact', 'artifact', null, 'artifact', 'artifact', 'file', 'file', 'task', 'browser', 'task', null]);
    expect(mine.map((m) => m.content.some((b) => b.type === 'text' && b.text.startsWith(PANE_MARK)))).toEqual([true, false, false, true, true, true, true, true, true, true, false]);
  });
});
