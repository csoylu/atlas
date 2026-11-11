import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAiCompatProvider, toOpenAiMessages } from './openai.ts';
import { ModelError } from './types.ts';

describe('openai-compatible provider', () => {
  it('converts the transcript', () => {
    const msgs = toOpenAiMessages({
      model: 'm',
      system: 'sys',
      maxTokens: 10,
      tools: [],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'tool_use', id: 'a', name: 'shell', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }, { type: 'text', text: 'thanks' }] },
      ],
    });
    expect(msgs).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'x' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('streams text and tool calls from an SSE server', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'shell', arguments: '{"comm' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } },
    ];
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bearer k');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    let streamed = '';
    const res = await new OpenAiCompatProvider(url, 'k').complete(
      { model: 'm', system: 's', maxTokens: 10, tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      (t) => (streamed += t),
      new AbortController().signal,
    );
    server.close();
    expect(streamed).toBe('Hello');
    expect(res).toEqual({
      content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'c1', name: 'shell', input: { command: 'ls' } }],
      stopReason: 'tool_use',
      usage: { input: 7, output: 3, cached: 0 },
    });
  });

  it('keeps the thinking as an unsigned block and sends effort none as reasoning_effort', async () => {
    const chunks = [
      { choices: [{ delta: { reasoning: 'let me ' } }] },
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: 'Hi' }, finish_reason: 'stop' }] },
    ];
    const bodies: { reasoning_effort?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        bodies.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const p = new OpenAiCompatProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, undefined);
    const req = { model: 'm', system: 's', maxTokens: 10, tools: [], messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }] };
    let streamed = '';
    const res = await p.complete({ ...req, effort: 'none' }, (t) => (streamed += t), new AbortController().signal);
    await p.complete({ ...req, effort: 'max' }, () => {}, new AbortController().signal);
    await p.complete(req, () => {}, new AbortController().signal);
    server.close();
    expect(streamed).toBe('Hi'); // thinking is not answer text
    expect(res.content).toEqual([{ type: 'thinking', thinking: 'let me think', signature: '' }, { type: 'text', text: 'Hi' }]);
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(['none', 'high', undefined]);
  });

  it('reports an unreachable server clearly', async () => {
    const p = new OpenAiCompatProvider('http://127.0.0.1:1/v1', undefined);
    await expect(
      p.complete({ model: 'm', system: '', maxTokens: 1, tools: [], messages: [] }, () => {}, new AbortController().signal),
    ).rejects.toThrow(ModelError);
  });
});
