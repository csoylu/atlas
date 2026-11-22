import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message } from '@atlas/shared';
import { draftSegments, endedOnFailure, groupSummary, groupTurn, stepArtifact, turns, type Segment } from './chatTurn.ts';
import type { ToolOutcome } from './toolRows.ts';

let seq = 0;
const msg = (content: ContentBlock[], author = 'atlas'): Message => ({
  id: 'm' + ++seq,
  conversationId: 'c',
  seq,
  role: author === 'atlas' ? 'assistant' : 'user',
  author,
  content,
  at: '2026-11-14T17:00:00.000Z',
});
const use = (id: string, name: string, input: unknown = {}): ContentBlock => ({ type: 'tool_use', id, name, input });
const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const ok = (content: string): ToolOutcome => ({ content, isError: false });
const kinds = (s: Segment[]) => s.map((x) => (x.kind === 'group' ? `group(${x.steps.length})` : x.kind === 'pin' ? `pin:${x.pin}` : x.kind));

describe('groupTurn', () => {
  it('keeps old canvas_* calls and an old panel_open({ canvas }) as plain steps, never an artifact chip (#342)', () => {
    const ms = [msg([use('a', 'canvas_write', { id: 'cv_1' }), use('b', 'canvas_read', { id: 'cv_1' }), use('c', 'panel_open', { canvas: 'cv_1' })])];
    const res = new Map([['a', ok('canvas cv_1 is now v2 with 1 node')], ['b', ok('{}')], ['c', ok('opened canvas')]]);
    const segs = groupTurn(ms, res, { live: false });
    expect(kinds(segs)).toEqual(['group(3)']);
    for (const step of (segs[0] as Extract<Segment, { kind: 'group' }>).steps) expect(stepArtifact(step)).toBeNull();
  });

  it('folds 2+ calls in a row into a group; text breaks it; a single call stays a row', () => {
    const ms = [msg([text('Looking.'), use('a', 'read_file', { path: 'x.ts' })]), msg([use('b', 'grep', { pattern: 'y' })]), msg([text('Found it.'), use('c', 'shell', { command: 'npm test' })])];
    const res = new Map([['a', ok('1|x')], ['b', ok('x.ts:1:y')], ['c', ok('exit 0\n')]]);
    const segs = groupTurn(ms, res, { live: false });
    expect(kinds(segs)).toEqual(['text', 'group(2)', 'text', 'step']);
  });

  it('never folds an artifact card, the question or the live plan', () => {
    const ms = [
      msg([
        use('a', 'read_file', { path: 'x' }),
        use('b', 'artifact_create', { kind: 'markdown', title: 'B', content: '# B' }),
        use('c', 'read_file', { path: 'y' }),
        use('d', 'panel_open', { path: 'docs/a.md' }),
        use('e', 'todo_write', { todos: [] }),
        use('f', 'card_block', { kind: 'needs_input', question: 'Q?' }),
      ]),
    ];
    const res = new Map([
      ['a', ok('1|')],
      ['b', ok('created B (doc_2, docs/b.md, v1) in Unfiled; shown in the side panel')],
      ['c', ok('1|')],
      ['d', ok('opened A (doc_1, docs/a.md, v1) in the side panel')],
      ['e', ok('saved')],
      ['f', ok('card blocked')],
    ]);
    expect(kinds(groupTurn(ms, res, { live: true }))).toEqual(['step', 'pin:doc', 'step', 'pin:doc', 'pin:plan', 'pin:ask']);
    // Not live: the plan is history, it folds like any step.
    expect(kinds(groupTurn(ms, res, { live: false }))).toEqual(['step', 'pin:doc', 'step', 'pin:doc', 'step', 'pin:ask']);
  });

  it('only the latest plan is pinned while live', () => {
    const ms = [msg([use('p1', 'todo_write', { todos: [] }), use('r', 'read_file', {}), use('p2', 'todo_write', { todos: [] })])];
    const segs = groupTurn(ms, new Map([['p1', ok('')], ['r', ok('')], ['p2', ok('')]]), { live: true });
    expect(kinds(segs)).toEqual(['group(2)', 'pin:plan']);
  });

  it('step states: running while live, cut once the run is over, failed on an error or a red exit', () => {
    const ms = [msg([use('a', 'shell', { command: 'false' }), use('b', 'edit_file', { path: 'x' }), use('c', 'shell', { command: 'sleep 9' })])];
    const res = new Map([['a', ok('exit 1\n')], ['b', { content: 'not read', isError: true }]]);
    const live = groupTurn(ms, res, { live: true })[0]!;
    const over = groupTurn(ms, res, { live: false })[0]!;
    expect(live.kind === 'group' && live.steps.map((s) => s.state)).toEqual(['failed', 'failed', 'running']);
    expect(over.kind === 'group' && over.steps.at(-1)!.state).toBe('cut');
  });

  it('thinking joins the steps; empty thinking is dropped', () => {
    const ms = [msg([{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'thinking', thinking: ' ', signature: 's' }, use('a', 'read_file', {}), use('b', 'read_file', {})])];
    const g = groupTurn(ms, new Map(), { live: false })[0]!;
    expect(g.kind === 'group' && g.steps.map((s) => s.kind)).toEqual(['thinking', 'tool', 'tool']);
  });
});

describe('groupSummary', () => {
  const steps = (calls: [string, string, unknown, ToolOutcome | undefined][]) => {
    const ms = [msg(calls.map(([id, name, input]) => use(id, name, input)))];
    const g = groupTurn(ms, new Map(calls.flatMap(([id, , , r]) => (r ? [[id, r] as const] : []))), { live: true })[0]!;
    if (g.kind !== 'group') throw new Error('not a group');
    return g.steps;
  };

  it('says the 2–3 key actions (edits > shell > writes > reads), merges same verbs, sums +/−', () => {
    const s = groupSummary(
      steps([
        ['a', 'read_file', { path: 'a/CardPanel.tsx' }, ok('1|')],
        ['b', 'edit_file', { path: 'a/CardPanel.tsx', old_text: 'x', new_text: 'y\nz' }, ok('edited')],
        ['c', 'edit_file', { path: 'a/styles.css', old_text: 'q', new_text: 'q\nr' }, ok('edited')],
        ['d', 'edit_file', { path: 'a/CardPanel.tsx', old_text: 'm', new_text: 'n' }, ok('edited')],
        ['e', 'shell', { command: 'npm test' }, ok('exit 0\n')],
        ['f', 'grep', { pattern: 'p' }, ok('no matches')],
      ]),
    );
    expect(s.text).toBe('Edited CardPanel.tsx and styles.css, ran npm test');
    expect(s).toMatchObject({ add: 4, del: 2, failed: 0, tools: 6, running: null });
    expect(s.icons).toEqual(['read', 'edit', 'term', 'search']);
  });

  it('counts failures (x icon first) and leaves them out of the summary and totals', () => {
    const s = groupSummary(
      steps([
        ['a', 'edit_file', { path: 'a/x.ts', old_text: 'a', new_text: 'b\nc' }, { content: 'not read', isError: true }],
        ['b', 'read_file', { path: 'a/x.ts' }, ok('1|')],
        ['c', 'edit_file', { path: 'a/x.ts', old_text: 'a', new_text: 'b' }, ok('edited')],
      ]),
    );
    expect(s).toMatchObject({ failed: 1, add: 1, del: 1, text: 'Read x.ts, edited x.ts' });
    expect(s.icons[0]).toBe('x');
  });

  it('knows the running step', () => {
    const s = groupSummary(steps([['a', 'read_file', { path: 'x' }, ok('')], ['b', 'shell', { command: 'npm test' }, undefined]]));
    expect(s.running?.id).toBe('b');
  });
});

describe('endedOnFailure', () => {
  it('a turn whose last group ends on a failed step', () => {
    const ms = [msg([use('a', 'read_file', {}), use('b', 'edit_file', { path: 'x' })])];
    const bad = new Map([['a', ok('')], ['b', { content: 'no', isError: true }]]);
    expect(endedOnFailure(groupTurn(ms, bad, { live: false }))?.id).toBe('b');
    expect(endedOnFailure(groupTurn([...ms, msg([text('Fixed it another way.')])], bad, { live: false }))).toBeNull();
    expect(endedOnFailure(groupTurn(ms, new Map([['a', ok('')], ['b', ok('')]]), { live: false }))).toBeNull();
  });
});

describe('turns', () => {
  it('merges one agent’s consecutive messages', () => {
    const ms = [msg([text('hi')], 'user'), msg([text('a')]), msg([text('b')]), msg([text('sys')], 'system'), msg([text('c')])];
    expect(turns(ms, (m) => m.role === 'assistant').map((t) => t.length)).toEqual([1, 2, 1, 1]);
  });
  it('the first message after the « New » line starts its own group (#338)', () => {
    const ms = [msg([text('hi')], 'user'), msg([text('a')]), msg([text('b')]), msg([text('c')])];
    const after = ms[1]!.seq;
    expect(turns(ms, (m) => m.role === 'assistant', after).map((t) => t.map((m) => m.seq - after))).toEqual([[-1], [0], [1, 2]]);
    expect(turns(ms, (m) => m.role === 'assistant', null).map((t) => t.length)).toEqual([1, 3]);
  });
});

describe('draftSegments (#80)', () => {
  const at = '2026-11-16T10:00:00.000Z';
  it('the live thinking row sits above the streaming text, running until text follows', () => {
    const thinking = draftSegments([{ kind: 'thinking', text: 'Let me see.', at }]);
    expect(thinking).toMatchObject([{ kind: 'step', step: { kind: 'thinking', text: 'Let me see.', state: 'running', row: { running: 'Thinking' } } }]);
    const both = draftSegments([
      { kind: 'thinking', text: 'Let me see.', at },
      { kind: 'text', text: 'Hi there.', at },
    ]);
    expect(kinds(both)).toEqual(['step', 'text']);
    expect(both[0]).toMatchObject({ step: { state: 'done', id: thinking[0]!.kind === 'step' && thinking[0]!.step.id } }); // same key: the row stays
  });

  it('lays out like the landed message: no reorder, no duplicate', () => {
    const live = draftSegments([
      { kind: 'thinking', text: 'Let me see.', at },
      { kind: 'text', text: 'Hi there.', at },
    ]);
    const landed = groupTurn([msg([{ type: 'thinking', thinking: 'Let me see.', signature: 's' }, text('Hi there.')])], new Map(), { live: false });
    const shape = (ss: Segment[]) => ss.map((x) => (x.kind === 'step' ? `${x.step.kind}:${x.step.text}:${x.step.state}` : x.kind === 'text' ? `text:${x.text}` : x.kind));
    expect(shape(live)).toEqual(shape(landed));
  });

  it('blank thinking shows nothing (as when saved)', () => {
    expect(draftSegments([{ kind: 'thinking', text: '  ', at }])).toEqual([]);
  });
});
