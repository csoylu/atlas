import { describe, expect, it } from 'vitest';
import type { ContentBlock, Message } from '@atlas/shared';
import { buildMessages, COMPACT_AT, compactBudget, compactedView, opening, otherLead, SUMMARY_ROOM, summaryAsk, degrade, estimateTokens, INTERRUPTED, measuredSize, needsTurn, pairServerTools, pickCut, pickPrune, pruneMessages, serverToolProblem, SUMMARY_LEAD, TODO_LEAD } from './context.ts';

let seq = 0;
const m = (role: 'user' | 'assistant', content: ContentBlock[], contextUpto: number | null = null) => ({
  id: 'm' + ++seq,
  conversationId: 'c',
  seq,
  role,
  author: role === 'user' ? 'user' : 'atlas',
  content,
  at: '',
  contextUpto,
}) satisfies Message & { contextUpto: number | null };
const t = (text: string): ContentBlock[] => [{ type: 'text', text }];

describe('buildMessages', () => {
  it("shows another agent's turns as theirs, not as the running agent's (#221)", () => {
    seq = 0;
    const by = (author: string, msg: ReturnType<typeof m>) => ({ ...msg, author });
    const transcript = [
      m('user', t('build it')),
      by('munih', m('assistant', [{ type: 'thinking', thinking: 'private', signature: 's' }, { type: 'text', text: 'I built it.' }, { type: 'tool_use', id: 'u1', name: 'shell', input: { command: 'npm test' } }])),
      by('tool', m('user', [{ type: 'tool_result', tool_use_id: 'u1', content: '42 passed' }])),
      by('munih', m('assistant', t('PR #49 is open.'))),
      by('system', m('user', t('You review PR #49.'))),
      by('zurich', m('assistant', [{ type: 'tool_use', id: 'u2', name: 'shell', input: { command: 'git diff' } }])),
      by('tool', m('user', [{ type: 'tool_result', tool_use_id: 'u2', content: 'diff' }])),
    ];
    // zurich's view: munih's turns are user context opening with who wrote them; zurich's own call stays a tool call.
    const z = buildMessages(transcript, 'zurich');
    expect(z.map((v) => v.role)).toEqual(['user', 'assistant', 'user']);
    const context = z[0]!.content.map((b) => (b.type === 'text' ? b.text : b.type)).join('\n');
    expect(context).toContain(`${otherLead('munih')}\nI built it.\n→ shell {"command":"npm test"}`);
    expect(context).toContain("← @munih's shell: 42 passed");
    expect(context).toContain(`${otherLead('munih')}\nPR #49 is open.`);
    expect(context).not.toContain('private');
    expect(z[1]!.content).toEqual([{ type: 'tool_use', id: 'u2', name: 'shell', input: { command: 'git diff' } }]);
    expect(z[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'u2', content: 'diff' }]);
    // munih's view, later: its own turns are its own, zurich's are labelled.
    const mu = buildMessages(transcript, 'munih');
    expect(mu.map((v) => v.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(JSON.stringify(mu.at(-1)!.content)).toContain(otherLead('zurich'));
    // No running agent given: the raw view (one role per message, as before).
    expect(buildMessages(transcript).filter((v) => v.role === 'assistant')).toHaveLength(3);
  });

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
    expect(out[0]!.content).toEqual(view[0]!.content); // the user's words stay
    expect(out[1]!.content[0] === view[1]!.content[0] || JSON.stringify(out[1]!.content[0]) === JSON.stringify(view[1]!.content[0])).toBe(true); // fitted before touching assistant text
    expect(result(4).content).toBe(big); // newest turn stays whole
    expect(view[2]!.content[0]).toMatchObject({ content: big }); // input not mutated
    // Tighter: old assistant text goes next; the user's message still untouched.
    const tight = degrade(view, 8_000, 0);
    expect((tight[1]!.content[0] as { text: string }).text).toMatch(/chars omitted to fit the context\)$/);
    expect(tight[0]!.content).toEqual(view[0]!.content);
  });
});

describe('compaction budget (#376)', () => {
  it('compacts at 80% of the window, keeping room for the answer and for a summary call after the view', () => {
    expect(COMPACT_AT).toBe(0.8);
    expect(compactBudget({ contextWindow: 200_000, maxTokens: 16_000 })).toBe(160_000);
    expect(compactBudget({ contextWindow: 1_000_000, maxTokens: 32_000 })).toBe(800_000);
    expect(compactBudget({ contextWindow: 200_000, maxTokens: 64_000 })).toBe(136_000); // 0.8 would leave no room to answer
    expect(compactBudget({ contextWindow: 32_768, maxTokens: 16_000 })).toBe(16_768);
    expect(compactBudget({ contextWindow: 8_192, maxTokens: 1_000 })).toBe(4_096); // a small local window: the summary's room
    expect(compactBudget({ contextWindow: 4_096, maxTokens: 16_000 })).toBe(2_048); // never under half
  });
  it('a view at its budget + the summary instruction + its answer fits the window, for every window and answer size', () => {
    for (const contextWindow of [2_048, 4_096, 8_192, 16_384, 32_768, 131_072, 200_000, 1_000_000])
      for (const maxTokens of [1_000, 4_096, 8_192, 16_000, 32_000, 64_000]) {
        const budget = compactBudget({ contextWindow, maxTokens });
        if (contextWindow - Math.floor(contextWindow / 2) >= Math.max(maxTokens, SUMMARY_ROOM)) {
          expect(budget + Math.max(maxTokens, SUMMARY_ROOM), `${contextWindow}/${maxTokens}`).toBeLessThanOrEqual(contextWindow);
        }
        expect(budget).toBeGreaterThanOrEqual(Math.floor(contextWindow / 2));
        expect(budget).toBeLessThanOrEqual(Math.floor(contextWindow * COMPACT_AT));
      }
  });
});

describe('summary instruction (#376)', () => {
  it('asks for a summary of what comes before the kept messages, no tool call, folding the earlier summary', () => {
    const ask = summaryAsk({ previous: true, kept: 3, first: 'what is left?', focus: 'the importer' });
    expect(ask).toMatch(/^\[Atlas: context compaction\] /);
    expect(ask).toContain('Do not call any tool');
    expect(ask).toContain('every message before the last 3 of this conversation (they start with « what is left? »');
    expect(ask).toContain('folding the earlier summary at its start into it');
    expect(ask).toContain('with this focus: the importer');
    expect(summaryAsk({ previous: false, kept: 0, first: null })).toContain('a summary of the whole conversation.');
  });
  it('names a message by its first text or tool call, on one line, at most 160 chars', () => {
    expect(opening({ role: 'user', content: [{ type: 'text', text: ' two\nlines ' }] })).toBe('two lines');
    expect(opening({ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'shell', input: { command: 'ls' } }] })).toBe('→ shell {"command":"ls"}');
    expect(opening({ role: 'user', content: [{ type: 'text', text: 'x'.repeat(200) }] })).toBe('x'.repeat(160) + '…');
    expect(opening(undefined)).toBeNull();
  });
});

describe('real token counts', () => {
  it('uses the reading plus an estimate of only the messages added since; null without one', () => {
    const msgs = toolRounds(3, 400);
    expect(measuredSize(null, msgs)).toBeNull();
    expect(measuredSize({ tokens: 5000, upto: msgs.at(-1)!.seq }, msgs)).toBe(5000);
    const since = msgs.filter((x) => x.seq > 4);
    expect(measuredSize({ tokens: 5000, upto: 4 }, msgs)).toBe(5000 + estimateTokens(since.map((x) => x.content)));
  });
});

describe('prune', () => {
  it('stubs big outputs and inputs before the cut, dedupes identical ones, keeps the tail and text whole', () => {
    seq = 0;
    const same = 'same output '.repeat(10); // 120 chars: not big, but duplicated
    const msgs = [
      m('user', t('go')),
      m('assistant', [{ type: 'text', text: 'plan '.repeat(200) }, { type: 'tool_use', id: 'a', name: 'write_file', input: { content: 'x'.repeat(1000) } }], 1),
      m('user', [{ type: 'tool_result', tool_use_id: 'a', content: 'y'.repeat(2000) }]),
      m('assistant', [{ type: 'tool_use', id: 'b', name: 'shell', input: { command: 'ls' } }], 3),
      m('user', [{ type: 'tool_result', tool_use_id: 'b', content: same }]),
      m('assistant', [{ type: 'tool_use', id: 'c', name: 'todo_write', input: { todos: [{ content: 'z'.repeat(700), status: 'pending' }] } }], 5),
      m('user', [{ type: 'tool_result', tool_use_id: 'c', content: same }]),
      m('assistant', [{ type: 'tool_use', id: 'd', name: 'shell', input: { command: 'cat' } }], 7),
      m('user', [{ type: 'tool_result', tool_use_id: 'd', content: 'w'.repeat(2000) }]),
    ];
    const before = JSON.stringify(msgs);
    const out = pruneMessages(msgs, 7);
    expect(JSON.stringify(msgs)).toBe(before); // copies
    expect(out[1]!.content[0]).toEqual(msgs[1]!.content[0]); // assistant text untouched
    expect(out[1]!.content[1]).toMatchObject({ input: { omitted: 'input omitted to fit the context (1014 chars); history_search can read it (seq 2)' } });
    expect(out[2]!.content[0]).toMatchObject({ content: 'output omitted to fit the context (2000 chars); history_search can read it (seq 3)' });
    expect(out[4]!.content[0]).toMatchObject({ content: 'same output as the later call in #7' });
    expect(out[6]!.content[0]).toMatchObject({ content: same }); // the latest copy stays
    expect(out[5]).toBe(msgs[5]); // todo_write input kept
    expect(out[8]).toBe(msgs[8]); // the tail is whole
    expect(pruneMessages(msgs, 7)).toEqual(out); // deterministic
    expect(pruneMessages(msgs, null)).toBe(msgs);
  });

  it('protects a tail worth `tail` tokens and always the newest two messages', () => {
    const msgs = toolRounds(10, 4000); // ~1000 tokens per result
    const cut = pickPrune(msgs, 3500)!;
    const tail = msgs.filter((x) => x.seq > cut);
    expect(estimateTokens(tail.map((x) => x.content))).toBeLessThanOrEqual(3500);
    expect(tail.length).toBeGreaterThanOrEqual(6);
    expect(pickPrune(msgs, 1_000_000)).toBeNull();
    expect(pickPrune(msgs, 0)).toBe(msgs.at(-3)!.seq);
  });
});

describe('todo re-injection', () => {
  const todos = [{ content: 'ship it', status: 'pending' as const }];
  it('adds the list after the summary once its todo_write call is folded, not while the call is visible', () => {
    seq = 0;
    const msgs = [
      m('user', t('go')),
      m('assistant', [{ type: 'tool_use', id: 'w', name: 'todo_write', input: { todos } }], 1),
      m('user', [{ type: 'tool_result', tool_use_id: 'w', content: 'saved' }]),
      m('assistant', t('working'), 3),
      m('user', t('status?')),
    ];
    expect(JSON.stringify(compactedView(msgs, null, null, null, todos))).not.toContain(TODO_LEAD);
    const view = compactedView(msgs, 'planned', 3, null, todos);
    expect(view[0]!.content.slice(0, 2)).toEqual([
      { type: 'text', text: `${SUMMARY_LEAD}\n\nplanned` },
      { type: 'text', text: `${TODO_LEAD}\n- [ ] ship it` },
    ]);
    expect(view[0]!.role).toBe('user');
    expect(view[1]!.role).toBe('assistant');
  });
});

describe('provider web search pairs (#144)', () => {
  const search = (id: string): ContentBlock => ({ type: 'server_tool_use', id, name: 'web_search', input: { query: 'q ' + id } });
  const found = (id: string): ContentBlock => ({ type: 'web_search_tool_result', tool_use_id: id, content: [{ type: 'web_search_result', url: 'https://ex.com/' + id, title: 'Ex', encrypted_content: 'e' }] });
  const use = (id: string, size = 10): ContentBlock => ({ type: 'tool_use', id, name: 'shell', input: { command: 'x'.repeat(size) } });
  const result = (id: string, size = 10): ContentBlock => ({ type: 'tool_result', tool_use_id: id, content: 'o'.repeat(size) });
  const thinking: ContentBlock = { type: 'thinking', thinking: 'hm', signature: 'sig' };

  /** #142's shape: a client tool and a web search in one answer, the search's result opening the next answer. */
  function mixedTurn() {
    seq = 0;
    const msgs = [m('user', t('look it up'))];
    msgs.push(m('assistant', [thinking, use('a'), search('s')], 1));
    msgs.push(m('user', [result('a')]));
    msgs.push(m('assistant', [found('s'), thinking, use('b')], 3));
    for (let i = 0; i < 6; i++) {
      msgs.push(m('user', [result(i ? 'c' + (i - 1) : 'b', 2000)]));
      msgs.push(m('assistant', [thinking, use('c' + i, 800)], seq));
    }
    msgs.push(m('user', [result('c5')]));
    return msgs;
  }

  it('moves the search next to its result when the answer came in two parts', () => {
    const view = compactedView(mixedTurn(), null, null);
    expect(serverToolProblem(view)).toBeNull();
    expect(view[1]!.content.map((b) => b.type)).toEqual(['thinking', 'tool_use']);
    expect(view[3]!.content.map((b) => b.type)).toEqual(['server_tool_use', 'web_search_tool_result', 'thinking', 'tool_use']);
    expect(view[3]!.content[1]).toEqual(found('s')); // kept verbatim (encrypted_content replays)
  });

  it('builds a valid view at every prune point and every summary point', () => {
    const msgs = mixedTurn();
    const seqs = [null, ...msgs.map((x) => x.seq)];
    for (const prune of seqs)
      for (const upto of [null, ...msgs.filter((x, i) => msgs[i + 1]?.role === 'assistant').map((x) => x.seq)]) {
        const view = compactedView(msgs, upto == null ? null : 'earlier work', upto, prune);
        expect(serverToolProblem(view), `prune ${prune}, summary ${upto}`).toBeNull();
      }
    // #142: pruned up to the tool_result between the two halves. Both become text, nothing else changes.
    const view = compactedView(msgs, null, null, 3);
    const json = JSON.stringify(view);
    expect(json).not.toContain('server_tool_use');
    expect(json).not.toContain('web_search_tool_result');
    expect(json).toContain('(searched the web: {\\"query\\":\\"q s\\"})');
    expect(json).toContain('(web search: 1 results: Ex <https://ex.com/s>; results omitted to fit the context)');
  });

  it('degrading keeps the pair whole or makes both halves text', () => {
    const view = compactedView(mixedTurn(), null, null);
    for (let budget = 0; budget < estimateTokens(view); budget += 50) expect(serverToolProblem(degrade(view, budget, 0)), `budget ${budget}`).toBeNull();
  });

  it('keeps a search still running in the last answer (pause_turn), not one left without a result earlier', () => {
    const paused = [{ role: 'user' as const, content: t('go') }, { role: 'assistant' as const, content: [search('p')] }];
    expect(pairServerTools(paused)).toEqual(paused);
    const before = [
      { role: 'user' as const, content: t('go') },
      { role: 'assistant' as const, content: [search('p'), use('a')] },
      { role: 'user' as const, content: [result('a')] },
      { role: 'assistant' as const, content: [use('b')] },
      { role: 'user' as const, content: [result('b')] },
    ];
    const out = pairServerTools(before);
    expect(out[1]!.content[0]).toEqual({ type: 'text', text: '(searched the web: {"query":"q p"})' });
    expect(serverToolProblem(out)).toBeNull();
    // The answer just after a client tool that also started a search: the search may still come back.
    expect(serverToolProblem(pairServerTools(before.slice(0, 3)))).toBeNull();
    expect(pairServerTools(before.slice(0, 3))[1]!.content[0]).toEqual(search('p'));
  });

  it('drops a message emptied by the move and merges its neighbours', () => {
    const view = pairServerTools([
      { role: 'user', content: t('go') },
      { role: 'assistant', content: [search('s')] },
      { role: 'user', content: t('more') },
      { role: 'assistant', content: [found('s'), { type: 'text', text: 'done' }] },
    ]);
    expect(view.map((x) => x.role)).toEqual(['user', 'assistant']);
    expect(view[0]!.content).toEqual([...t('go'), ...t('more')]);
    expect(view[1]!.content.map((b) => b.type)).toEqual(['server_tool_use', 'web_search_tool_result', 'text']);
  });

  it('names the message and block the API would refuse', () => {
    expect(serverToolProblem([{ role: 'user', content: t('x') }, { role: 'assistant', content: [thinking, found('z')] }])).toBe(
      'messages.1.content.1: web_search_tool_result z without its server_tool_use before it in the same message',
    );
    expect(serverToolProblem([{ role: 'assistant', content: [search('y')] }, { role: 'user', content: t('x') }, { role: 'assistant', content: t('ok') }])).toBe(
      'messages.0.content.0: server_tool_use y without its web_search_tool_result',
    );
  });

  it('names a result whose content was cut or re-typed (#173)', () => {
    const view = (content: unknown) => [{ role: 'user' as const, content: t('x') }, { role: 'assistant' as const, content: [search('s'), { type: 'web_search_tool_result', tool_use_id: 's', content } as ContentBlock] }];
    const ok = { type: 'web_search_result', url: 'https://ex.com', title: 'Ex', encrypted_content: 'e' };
    expect(serverToolProblem(view([ok]))).toBeNull();
    expect(serverToolProblem(view({ type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }))).toBeNull();
    expect(serverToolProblem(view([ok, { ...ok, encrypted_content: '' }]))).toBe('messages.1.content.1: web_search_tool_result s: result 1 has no encrypted_content');
    expect(serverToolProblem(view([{ ...ok, type: 'search_result' }]))).toBe('messages.1.content.1: web_search_tool_result s: result 0 is of type search_result, not web_search_result');
    expect(serverToolProblem(view('cut…'))).toBe('messages.1.content.1: web_search_tool_result s: its content is neither a list of results nor an error');
  });

  it("replays #173's stored shape (search, result, thinking, tool_use in one answer) followed by 40+ messages verbatim", () => {
    seq = 0;
    const msgs = [m('user', t('make it bigger'))];
    const answer: ContentBlock[] = [thinking, search('s'), { ...found('s'), origin: 'plan:a' } as ContentBlock, thinking, use('k')];
    msgs.push(m('assistant', answer, 1));
    msgs.push(m('user', [result('k')]));
    for (let i = 0; i < 22; i++) {
      msgs.push(m('assistant', i % 2 ? t('reply ' + i) : [thinking, use('u' + i)], seq));
      msgs.push(m('user', i % 2 ? t('next ' + i) : [result('u' + i)]));
    }
    expect(msgs.length).toBeGreaterThan(45);
    const view = compactedView(msgs, null, null);
    expect(serverToolProblem(view)).toBeNull();
    expect(view[1]!.content).toEqual(answer); // exactly as stored (the provider drops only Atlas's origin field)
  });
});
