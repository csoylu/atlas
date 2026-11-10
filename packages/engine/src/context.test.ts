import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message } from '@atlas/shared';
import { buildMessages, compactedView, degrade, estimateTokens, INTERRUPTED, needsTurn, pickCut, SUMMARY_LEAD } from './context.ts';

let seq = 0;
const m = (role: 'user' | 'assistant', content: ContentBlock[], contextUpto: number | null = null) => ({
  id: 'm' + ++seq,
  conversationId: 'c',
  seq,
  role,
  author: role === 'user' ? 'can' : 'atlas',
  content,
  at: '',
  contextUpto,
}) satisfies Message & { contextUpto: number | null };
const t = (text: string): ContentBlock[] => [{ type: 'text', text }];

describe('buildMessages', () => {
  it('merges consecutive roles and puts tool results first', () => {
    seq = 0;
    const view = buildMessages([
      m('user', t('a')),
      m('assistant', [{ type: 'tool_use', id: 'x', name: 'shell', input: {} }], 1),
      m('user', t('while the tool runs')),
      m('user', [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]),
    ]);
    expect(view.map((v) => v.role)).toEqual(['user', 'assistant', 'user']);
    expect(view[2]!.content.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(needsTurn(view)).toBe(true);
  });

  it('moves a message the model did not see after its answer', () => {
    seq = 0;
    const view = buildMessages([m('user', t('first')), m('user', t('late')), m('assistant', t('answer'), 1)]);
    expect(view.map((v) => v.role)).toEqual(['user', 'assistant', 'user']);
    expect(view[2]!.content).toEqual(t('late'));
  });

  it('adds a synthetic result for an unanswered tool_use', () => {
    seq = 0;
    const view = buildMessages([m('user', t('go')), m('assistant', [{ type: 'tool_use', id: 'k', name: 'shell', input: {} }], 1)]);
    expect(view.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'k', content: INTERRUPTED, is_error: true }],
    });
  });

  it('owes nothing after a final answer', () => {
    seq = 0;
    expect(needsTurn(buildMessages([m('user', t('hi')), m('assistant', t('hello'), 1)]))).toBe(false);
  });
});

/** A tool-heavy transcript: a request, then `n` tool rounds whose outputs are `size` chars each. */
function toolRounds(n: number, size: number) {
  seq = 0;
  const out = [m('user', t('build it'))];
  for (let i = 0; i < n; i++) {
    out.push(m('assistant', [{ type: 'tool_use', id: 'u' + i, name: 'shell', input: { command: 'step ' + i } }], seq));
    out.push(m('user', [{ type: 'tool_result', tool_use_id: 'u' + i, content: String(i).padEnd(size, '.') }]));
  }
  return out;
}

describe('compaction', () => {
  it('cuts only before an assistant message, folding just enough', () => {
    const msgs = toolRounds(10, 4000); // ~1000 tokens per result
    const cut = pickCut(msgs, 3500, 100_000)!;
    const kept = msgs.filter((x) => x.seq > cut);
    expect(kept[0]!.role).toBe('assistant');
    expect(estimateTokens(kept.map((x) => x.content))).toBeLessThanOrEqual(3500);
    expect(kept.length).toBeGreaterThanOrEqual(4); // not more than needed
  });

  it('folds at most a chunk per call, and nothing when it cannot cut', () => {
    const msgs = toolRounds(10, 4000);
    const small = pickCut(msgs, 0, 400)!; // results render capped (~300 tokens each)
    expect(small).toBeLessThan(6);
    seq = 0;
    expect(pickCut([m('user', t('x'.repeat(50_000)))], 10, 100_000)).toBeNull();
  });

  it('puts the summary first and keeps every tool_result with its tool_use', () => {
    const msgs = toolRounds(4, 100);
    const cut = pickCut(msgs, 60, 100_000)!;
    const view = compactedView(msgs, 'did steps 0-1', cut);
    expect(view[0]).toEqual({ role: 'user', content: [{ type: 'text', text: `${SUMMARY_LEAD}\n\ndid steps 0-1` }] });
    const uses = view.flatMap((v) => v.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])));
    const results = view.flatMap((v) => v.content.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : [])));
    expect(results).toEqual(uses);
    expect(view.map((v) => v.role)).toEqual(view.map((_, i) => (i % 2 ? 'assistant' : 'user')));
  });

  it('degrades old tool outputs first and never touches user text or the newest turns', () => {
    seq = 0;
    const big = 'y'.repeat(20_000);
    const view = buildMessages([
      m('user', t('please ' + big)),
      m('assistant', [{ type: 'text', text: 'thinking out loud ' + big }, { type: 'tool_use', id: 'a', name: 'shell', input: {} }], 1),
      m('user', [{ type: 'tool_result', tool_use_id: 'a', content: big }]),
      m('assistant', [{ type: 'tool_use', id: 'b', name: 'shell', input: {} }], 3),
      m('user', [{ type: 'tool_result', tool_use_id: 'b', content: big }]),
    ]);
    const out = degrade(view, 16_000, 0);
    const result = (i: number) => out[i]!.content.find((b) => b.type === 'tool_result') as { content: string };
    expect(result(2).content).toMatch(/^output omitted to fit the context \(20000 chars\)/);
    expect(out[0]!.content).toEqual(view[0]!.content); // Can's words stay
    expect(out[1]!.content[0] === view[1]!.content[0] || JSON.stringify(out[1]!.content[0]) === JSON.stringify(view[1]!.content[0])).toBe(true); // fitted before touching assistant text
    expect(result(4).content).toBe(big); // newest turn stays whole
    expect(view[2]!.content[0]).toMatchObject({ content: big }); // input not mutated
    // Tighter: old assistant text goes next; Can's message still untouched.
    const tight = degrade(view, 8_000, 0);
    expect((tight[1]!.content[0] as { text: string }).text).toMatch(/chars omitted to fit the context\)$/);
    expect(tight[0]!.content).toEqual(view[0]!.content);
  });
});
