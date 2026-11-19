import { describe, expect, it } from 'vitest';
import { AnthropicProvider, adaptiveThinking, searchesFor, systemBlocks, WEB_SEARCH, withCacheBreakpoints } from './anthropic.ts';
import { OUTPUT_LIMIT, type ModelRequest } from './types.ts';

describe('adaptiveThinking', () => {
  it('asks newer Claude models for summarized thinking, leaves older ones alone', () => {
    for (const m of ['claude-opus-5-5', 'claude-opus-4-6', 'claude-sonnet-4-6-20260101', 'claude-opus-5', 'claude-haiku-5-1', 'claude-fable-5-2'])
      expect(adaptiveThinking(m), m).toBe(true);
    for (const m of ['claude-sonnet-4-5', 'claude-opus-4-5-20251101', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest', 'gpt-5', 'claude-opus-4-1'])
      expect(adaptiveThinking(m), m).toBe(false);
  });
});

describe('withCacheBreakpoints', () => {
  const cc = { type: 'ephemeral' };
  const msgs = (): ModelRequest['messages'] => [
    { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: 'a', name: 'shell', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'b', name: 'shell', input: {} }, { type: 'tool_use', id: 'c', name: 'shell', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '1' }, { type: 'tool_result', tool_use_id: 'c', content: '2' }] },
  ];

  it('marks the last block of the last two user messages, nothing else', () => {
    const out = withCacheBreakpoints(msgs()) as { role: string; content: Record<string, unknown>[] }[];
    const marked = out.flatMap((m, i) => m.content.map((b, j) => (b.cache_control ? `${i}.${j}` : null))).filter(Boolean);
    expect(marked).toEqual(['2.0', '4.1']);
    expect(out[4]!.content[1]!.cache_control).toEqual(cc);
    expect(out[4]!.content[0]).toEqual({ type: 'tool_result', tool_use_id: 'b', content: '1' });
  });

  it('leaves the caller’s messages untouched', () => {
    const input = msgs();
    const before = JSON.stringify(input);
    withCacheBreakpoints(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('handles a single message and skips empty text', () => {
    const one = withCacheBreakpoints([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]) as { content: Record<string, unknown>[] }[];
    expect(one[0]!.content[0]!.cache_control).toEqual(cc);
    const empty = withCacheBreakpoints([{ role: 'user', content: [{ type: 'text', text: '' }] }]) as { content: Record<string, unknown>[] }[];
    expect(empty[0]!.content[0]!.cache_control).toBeUndefined();
    expect(withCacheBreakpoints([])).toEqual([]);
  });
});

describe('systemBlocks', () => {
  it('marks the stable prefix and leaves the volatile tail unmarked; one plain block without cache', () => {
    expect(systemBlocks({ system: 'ROLE\n# Memory x', cache: { systemStable: 5 } })).toEqual([
      { type: 'text', text: 'ROLE\n', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '# Memory x' },
    ]);
    expect(systemBlocks({ system: 'ROLE\n' , cache: { systemStable: 5 } })).toEqual([{ type: 'text', text: 'ROLE\n', cache_control: { type: 'ephemeral' } }]);
    expect(systemBlocks({ system: 'one shot' })).toEqual([{ type: 'text', text: 'one shot' }]);
  });
});

describe('web search (server tool)', () => {
  const sse = (events: unknown[]) =>
    new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  const results = [{ type: 'web_search_result', url: 'https://ex.com/a', title: 'A', encrypted_content: 'enc', page_age: null }];
  const answer = () =>
    sse([
      { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"atlas"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: results } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Found A.' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]);
  const req = (messages: ModelRequest['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'search' }] }]): ModelRequest => ({
    model: 'claude-x',
    system: 's',
    messages,
    tools: [{ name: 'shell', description: 'd', input_schema: { type: 'object' } }],
    maxTokens: 100,
    webSearch: true,
  });
  const make = (baseURL?: string) => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return answer();
    }) as typeof globalThis.fetch;
    return { bodies, p: new AnthropicProvider('k', { fetch, maxRetries: 0, origin: 'account:a', ...(baseURL ? { baseURL } : {}) }), fetch };
  };

  it('offers web_search_20250305 on the Anthropic API, keeps the blocks and replays them as-is', async () => {
    const { bodies, p } = make();
    const res = await p.complete(req(), () => {}, new AbortController().signal);
    expect(bodies[0]!.tools).toEqual([{ name: 'shell', description: 'd', input_schema: { type: 'object' } }, WEB_SEARCH]);
    expect(res.content).toEqual([
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'atlas' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: results, origin: 'account:a' },
      { type: 'text', text: 'Found A.' },
    ]);
    await p.complete(req([...req().messages, { role: 'assistant', content: res.content }, { role: 'user', content: [{ type: 'text', text: 'more' }] }]), () => {}, new AbortController().signal);
    // Exactly as Anthropic sent it: Atlas's origin field stays home.
    expect((bodies[1]!.messages as { content: unknown }[])[1]!.content).toEqual([
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'atlas' } },
      { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: results },
      { type: 'text', text: 'Found A.' },
    ]);
  });

  it('sends a search from another account, or of unknown origin, as text with its request (#173)', async () => {
    const { bodies, p, fetch } = make();
    const res = await p.complete(req(), () => {}, new AbortController().signal);
    const history = req([...req().messages, { role: 'assistant', content: res.content }, { role: 'user', content: [{ type: 'text', text: 'more' }] }]);
    const other = new AnthropicProvider('k2', { fetch, maxRetries: 0, origin: 'account:b' });
    await other.complete(history, () => {}, new AbortController().signal);
    const text = [
      { type: 'text', text: '(searched the web: {"query":"atlas"})' },
      { type: 'text', text: '(web search: 1 results: A <https://ex.com/a>; results omitted to fit the context)' },
      { type: 'text', text: 'Found A.' },
    ];
    expect((bodies[1]!.messages as { content: unknown }[])[1]!.content).toEqual(text);
    expect(JSON.stringify(bodies[1])).not.toContain('encrypted_content');
    const { origin: _, ...unstamped } = res.content[1] as { origin?: string };
    const old = [res.content[0]!, unstamped as typeof res.content[number], res.content[2]!];
    expect(searchesFor([{ role: 'assistant', content: old }], 'account:a')[0]!.content).toEqual(text);
    const none = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];
    expect(searchesFor(none, 'account:a')).toBe(none);
  });

  it('puts cache_control only on agent turns: stable system prefix + the last two user messages; none on one-shot calls', async () => {
    const { bodies, p } = make();
    const history: ModelRequest['messages'] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'd' }] },
      { role: 'user', content: [{ type: 'text', text: 'e' }] },
    ];
    await p.complete({ ...req(history), system: 'STABLE\nTAIL', cache: { systemStable: 7 } }, () => {}, new AbortController().signal);
    await p.complete({ ...req(history), system: 'summarize' }, () => {}, new AbortController().signal);
    const marks = (body: Record<string, unknown>) => JSON.stringify(body).split('"cache_control"').length - 1;
    expect(bodies[0]!.system).toEqual([
      { type: 'text', text: 'STABLE\n', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'TAIL' },
    ]);
    const msgs = bodies[0]!.messages as { content: Record<string, unknown>[] }[];
    expect(msgs.map((m) => !!m.content.at(-1)!.cache_control)).toEqual([false, false, true, false, true]);
    expect(marks(bodies[0]!)).toBe(3); // ≤ 4 allowed
    expect(marks(bodies[1]!)).toBe(0);
  });

  it('keeps a tool call whose streamed arguments are invalid JSON (raw text) instead of failing the turn', async () => {
    const bad = '{"path":"a.html","content":"<p class="x y">hi</p>","b":1}'; // the SDK's own parser threw on this (#55)
    const fetch = (async () =>
      sse([
        { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Writing ' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'it.' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'write_file', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: bad.slice(0, 20) } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: bad.slice(20) } },
        { type: 'content_block_stop', index: 2 },
        { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 't2', name: 'shell', input: {} } },
        { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } },
        { type: 'content_block_stop', index: 3 },
        { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 't3', name: 'list_files', input: {} } },
        { type: 'content_block_stop', index: 4 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } },
        { type: 'message_stop' },
      ])) as unknown as typeof globalThis.fetch;
    const p = new AnthropicProvider('k', { fetch, maxRetries: 0 });
    const streamed: string[] = [];
    const res = await p.complete(req(), (t, kind) => streamed.push(`${kind}:${t}`), new AbortController().signal);
    expect(res.content).toEqual([
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'text', text: 'Writing it.' },
      { type: 'tool_use', id: 't1', name: 'write_file', input: { _invalid_json: bad } },
      { type: 'tool_use', id: 't2', name: 'shell', input: { command: 'ls' } },
      { type: 'tool_use', id: 't3', name: 'list_files', input: {} },
    ]);
    // Thinking streams live too, before the text (#80).
    expect(streamed).toEqual(['thinking:hmm', 'text:Writing ', 'text:it.']);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toEqual({ input: 15, output: 42, cached: 5 });
  });

  it('a tool call cut at max_tokens keeps its raw arguments and the stop reason max_tokens (#274)', async () => {
    const fetch = (async () =>
      sse([
        { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'write_file', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.mjs","content":"const a' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 16000 } },
        { type: 'message_stop' },
      ])) as unknown as typeof globalThis.fetch;
    const res = await new AnthropicProvider('k', { fetch, maxRetries: 0 }).complete(req(), () => {}, new AbortController().signal);
    expect(res.stopReason).toBe(OUTPUT_LIMIT);
    expect(res.content).toEqual([{ type: 'tool_use', id: 't1', name: 'write_file', input: { _invalid_json: '{"path":"a.mjs","content":"const a' } }]);
    expect(res.usage.output).toBe(16000);
  });

  it('a stream cut before message_stop is a transient error, not an answer', async () => {
    const fetch = (async () =>
      sse([
        { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-x', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } },
      ])) as unknown as typeof globalThis.fetch;
    const p = new AnthropicProvider('k', { fetch, maxRetries: 0 });
    await expect(p.complete(req(), () => {}, new AbortController().signal)).rejects.toMatchObject({ message: /ended before it completed/, transient: true });
  });

  it('offers no web search through another server or when not asked', async () => {
    const proxied = make('http://127.0.0.1:9/anthropic');
    await proxied.p.complete(req(), () => {}, new AbortController().signal);
    expect((proxied.bodies[0]!.tools as { name: string }[]).map((t) => t.name)).toEqual(['shell']);
    const plain = make('https://api.anthropic.com');
    await plain.p.complete({ ...req(), webSearch: false }, () => {}, new AbortController().signal);
    expect((plain.bodies[0]!.tools as { name: string }[]).map((t) => t.name)).toEqual(['shell']);
  });
});
