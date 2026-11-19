import { describe, expect, it } from 'vitest';
import { boardGroups, boardMeta, cardLine, cardSub, historyHits, historyMessage, markHits } from './cardRows.ts';

// Outputs in the engine's exact wording (packages/engine/src/cardTools.ts).
describe('card rows', () => {
  it('parses a card line, parents apart', () => {
    expect(cardLine('created #59 [todo] @atlas P2 Chat activity redesign (parents: #58)')).toEqual({ ref: '#59', status: 'todo', who: '@atlas', prio: 2, title: 'Chat activity redesign', parents: ['#58'] });
    expect(cardLine('#7 [done] unassigned P0 A (b) title\n\nbody')).toMatchObject({ who: null, title: 'A (b) title', parents: [] });
    expect(cardLine('#7 [weird] unassigned P0 x')).toBeNull();
    expect(cardLine('message posted on #57')).toBeNull();
  });
  it('chip line', () => {
    expect(cardSub({ status: 'todo', who: '@atlas', prio: 2, parents: ['#58', '#57'] })).toBe('todo · @atlas · Medium · after #58, #57');
    expect(cardSub({ status: 'todo', who: null, prio: 0, parents: [] })).toBe('todo');
    expect(cardSub({ status: 'done', who: null, prio: 3, parents: [] })).toBe('done · High');
  });
  it('board counts in board order', () => {
    const out = '#1 [done] @atlas P2 A\n#2 [running] @atlas P2 B (parents: #1)\n#3 [ready] unassigned P1 C\n#4 [running] @atlas P3 D';
    expect(boardGroups(out)).toEqual([
      { status: 'running', cards: [{ ref: '#2', title: 'B' }, { ref: '#4', title: 'D' }] },
      { status: 'ready', cards: [{ ref: '#3', title: 'C' }] },
      { status: 'done', cards: [{ ref: '#1', title: 'A' }] },
    ]);
    expect(boardMeta(out)).toBe('4 tasks · 2 running · 1 ready');
    expect(boardMeta('(no cards)')).toBe('0 tasks');
    expect(boardMeta('#1 [done] @atlas P2 A')).toBe('1 task');
  });
  it('history hits and one message', () => {
    const out = '#50 tool: …← exit 0 RUN v5.1.0…\n#62 atlas [rewound by the user: not part of the conversation]: …The reusable ChatRow is in…\n(3 older matches not shown)';
    expect(historyHits(out)).toEqual({
      hits: [
        { seq: 50, author: 'tool', text: '…← exit 0 RUN v5.1.0…' },
        { seq: 62, author: 'atlas', text: '…The reusable ChatRow is in…' },
      ],
      more: 3,
    });
    expect(historyHits('no message contains "x"')).toEqual({ hits: [], more: 0 });
    expect(historyMessage('#50 user (2026-11-14T10:00:00.000Z):\nhello\nworld')).toEqual({ seq: 50, author: 'user', at: '2026-11-14T10:00:00.000Z', text: 'hello\nworld' });
    expect(historyMessage('no message #9')).toBeNull();
  });
  it('marks every hit, case-insensitive', () => {
    expect(markHits('a ChatRow, chatrow b', 'chatrow')).toEqual(['a ', { hit: 'ChatRow' }, ', ', { hit: 'chatrow' }, ' b']);
    expect(markHits('abc', '')).toEqual(['abc']);
  });
});
