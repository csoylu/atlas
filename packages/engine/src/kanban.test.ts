import { describe, expect, it } from 'vitest';
import { openDb } from './store/db.ts';
import { Bus } from './events.ts';
import { Kanban, NotFoundError } from './kanban.ts';
import { runCardTool } from './cardTools.ts';
import { runTeamTool, type TeamToolContext } from './teamTools.ts';
import type { ServerEvent } from '@atlas/shared';

function setup() {
  const db = openDb(':memory:');
  const bus = new Bus();
  const events: ServerEvent[] = [];
  bus.on((e) => events.push(e));
  return { db, kanban: new Kanban(db, bus), events };
}

describe('kanban', () => {
  it('creates a card in triage with its own conversation', () => {
    const { kanban, events } = setup();
    const card = kanban.create({ title: 'Landing page' }, 'user');
    expect(card.status).toBe('triage');
    expect(card.conversationId).toBe('conv_' + card.id);
    expect(events).toEqual([{ type: 'card.updated', card }]);
  });

  it('records status changes as events', () => {
    const { db, kanban } = setup();
    const card = kanban.create({ title: 'x' }, 'user');
    kanban.update(card.id, { status: 'ready' }, 'atlas');
    const ev = db.prepare('SELECT kind, payload FROM card_events WHERE card_id = ? ORDER BY id').all(card.id);
    expect(ev).toEqual([
      { kind: 'created', payload: JSON.stringify({ by: 'user' }) },
      { kind: 'status', payload: JSON.stringify({ from: 'triage', to: 'ready', by: 'atlas' }) },
    ]);
  });

  it('a card moved to blocked by hand gets a block (the Inbox needs a reason); an existing block is kept', () => {
    const { kanban } = setup();
    const card = kanban.create({ title: 'x', status: 'review' }, 'user');
    expect(kanban.update(card.id, { status: 'blocked' }, 'user').block).toMatchObject({ kind: 'needs_input', reason: expect.stringContaining('by you') });
    const asked = kanban.create({ title: 'y', status: 'ready' }, 'user');
    kanban.block(asked.id, { kind: 'capability', reason: 'no key' }, 'atlas');
    expect(kanban.update(asked.id, { status: 'blocked' }, 'user').block).toMatchObject({ kind: 'capability', reason: 'no key' });
  });

  it('rejects invalid input and unknown cards', () => {
    const { kanban } = setup();
    expect(() => kanban.create({ title: '  ' }, 'user')).toThrow();
    expect(() => kanban.update('nope', { title: 'a' }, 'user')).toThrow(NotFoundError);
    const card = kanban.create({ title: 'x' }, 'user');
    expect(() => kanban.update(card.id, { status: 'bogus' as never }, 'user')).toThrow();
  });

  it('appends chat messages in sequence', () => {
    const { kanban } = setup();
    const card = kanban.create({ title: 'x' }, 'user');
    kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'hi' }]);
    kanban.appendMessage(card.id, 'assistant', 'atlas', [{ type: 'text', text: 'hello' }]);
    expect(kanban.messages(card.id).map((m) => [m.seq, m.author])).toEqual([
      [1, 'user'],
      [2, 'atlas'],
    ]);
  });

  it('deletes a card with its conversation', () => {
    const { db, kanban } = setup();
    const card = kanban.create({ title: 'x' }, 'user');
    kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'hi' }]);
    kanban.remove(card.id);
    expect(kanban.list()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 0 });
  });

  it('numbers board cards #1, #2, … and never reuses a number; direct chats have none', () => {
    const { kanban } = setup();
    const a = kanban.create({ title: 'a' }, 'user');
    const b = kanban.create({ title: 'b' }, 'user');
    expect([a.number, b.number]).toEqual([1, 2]);
    kanban.update(a.id, { status: 'archived' }, 'user');
    kanban.remove(b.id);
    expect(kanban.create({ title: 'c' }, 'user').number).toBe(3);
    expect(kanban.newChat('atlas').number).toBeNull();
    expect(kanban.create({ title: 'd' }, 'user').number).toBe(4);
  });

  it('resolves card references: #12, 12 and the id; parents too', () => {
    const { kanban } = setup();
    const a = kanban.create({ title: 'a' }, 'user');
    const b = kanban.create({ title: 'b' }, 'user');
    expect([kanban.resolve('#2'), kanban.resolve('2'), kanban.resolve(` ${b.id} `)]).toEqual([b.id, b.id, b.id]);
    expect(() => kanban.resolve('#99')).toThrow(NotFoundError);
    expect(() => kanban.resolve('nope')).toThrow(NotFoundError);
    expect(kanban.update(b.id, { parents: ['#1'] }, 'user').parents).toEqual([a.id]);
    expect(kanban.create({ title: 'c', parents: ['1', b.id] }, 'user').parents.sort()).toEqual([a.id, b.id].sort());
    expect(() => kanban.update(a.id, { parents: ['#2'] }, 'user')).toThrow(/linking #2 as parent of #1 would create a cycle/);
    expect(() => kanban.update(a.id, { parents: ['#42'] }, 'user')).toThrow(/parent card #42 does not exist/);
    expect(kanban.ref(a.id)).toBe('#1');
  });

  it('card tools take #12, 12 or the id, and name cards by number', () => {
    const { kanban } = setup();
    const a = kanban.create({ title: 'a' }, 'user');
    const b = kanban.create({ title: 'b', status: 'ready', parents: [a.id] }, 'user');
    const ctx = { kanban, agentId: 'atlas', cardId: a.id };
    for (const id of ['#2', '2', 2, b.id]) expect(runCardTool('card_show', { id }, ctx).output).toMatch(/^#2 \[todo\] unassigned P0 b \(parents: #1\)/);
    expect(runCardTool('card_update', { id: '#2', title: 'B', parents: [] }, ctx).output).toBe('updated #2 [todo] unassigned P0 B');
    expect(runCardTool('card_create', { title: 'c', parents: ['#1', 2] }, ctx).output).toBe('created #3 [todo] unassigned P0 c (parents: #1, #2)');
    expect(runCardTool('card_list', {}, ctx).output.split('\n').map((l) => l.split(' ')[0])).toEqual(['#1', '#2', '#3']);
    const delivered: string[] = [];
    const team = { kanban, agentId: 'atlas', cardId: a.id, deliver: (id: string) => delivered.push(id) } as unknown as TeamToolContext;
    expect(runTeamTool('card_message', { id: '#2', text: 'hi' }, team)).toEqual({ output: 'message posted on #2', isError: false });
    expect(kanban.messages(b.id).at(-1)!.content).toEqual([{ type: 'text', text: '[from @atlas, card #1] hi' }]);
    expect(delivered).toEqual([b.id]);
    expect(runTeamTool('card_message', { id: 1, text: 'me' }, team).output).toMatch(/your own card/);
  });
});
