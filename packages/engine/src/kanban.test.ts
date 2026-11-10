import { describe, expect, it } from 'vitest';
import { openDb } from './store/db.ts';
import { Bus } from './events.ts';
import { Kanban, NotFoundError } from './kanban.ts';
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
    const card = kanban.create({ title: 'Landing page' }, 'can');
    expect(card.status).toBe('triage');
    expect(card.conversationId).toBe('conv_' + card.id);
    expect(events).toEqual([{ type: 'card.updated', card }]);
  });

  it('records status changes as events', () => {
    const { db, kanban } = setup();
    const card = kanban.create({ title: 'x' }, 'can');
    kanban.update(card.id, { status: 'ready' }, 'atlas');
    const ev = db.prepare('SELECT kind, payload FROM card_events WHERE card_id = ? ORDER BY id').all(card.id);
    expect(ev).toEqual([
      { kind: 'created', payload: JSON.stringify({ by: 'can' }) },
      { kind: 'status', payload: JSON.stringify({ from: 'triage', to: 'ready', by: 'atlas' }) },
    ]);
  });

  it('rejects invalid input and unknown cards', () => {
    const { kanban } = setup();
    expect(() => kanban.create({ title: '  ' }, 'can')).toThrow();
    expect(() => kanban.update('nope', { title: 'a' }, 'can')).toThrow(NotFoundError);
    const card = kanban.create({ title: 'x' }, 'can');
    expect(() => kanban.update(card.id, { status: 'bogus' as never }, 'can')).toThrow();
  });

  it('appends chat messages in sequence', () => {
    const { kanban } = setup();
    const card = kanban.create({ title: 'x' }, 'can');
    kanban.appendMessage(card.id, 'user', 'can', [{ type: 'text', text: 'hi' }]);
    kanban.appendMessage(card.id, 'assistant', 'atlas', [{ type: 'text', text: 'hello' }]);
    expect(kanban.messages(card.id).map((m) => [m.seq, m.author])).toEqual([
      [1, 'can'],
      [2, 'atlas'],
    ]);
  });

  it('deletes a card with its conversation', () => {
    const { db, kanban } = setup();
    const card = kanban.create({ title: 'x' }, 'can');
    kanban.appendMessage(card.id, 'user', 'can', [{ type: 'text', text: 'hi' }]);
    kanban.remove(card.id);
    expect(kanban.list()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 0 });
  });
});
