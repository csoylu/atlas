import { describe, expect, it } from 'vitest';
import type { ModelRequest } from './types.ts';
import { GeminiError, GeminiProvider, SKIP_THOUGHT_SIGNATURE, cleanSchema, toGeminiContents } from './gemini.ts';

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'gemini-4-neon',
  system: 'You are atlas.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  maxTokens: 1000,
  ...over,
});

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

describe('Gemini (Antigravity) request mapping', () => {
  it('maps the transcript, tool results carrying their call name, and the thought signature', () => {
    const contents = toGeminiContents(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'list the cards' }] },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'I should call card_list.', signature: 'SIG-1' },
              { type: 'tool_use', id: 'call_1', name: 'card_list', input: { status: 'ready' } },
              { type: 'tool_use', id: 'call_2', name: 'card_list', input: {} },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'call_1', content: '[{"id":"c1"}]' },
              { type: 'tool_result', tool_use_id: 'call_2', content: 'boom', is_error: true },
            ],
          },
        ],
      }),
    );

    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'list the cards' }] });
    const model = contents[1]!;
    expect(model.role).toBe('model');
    expect(model.parts[0]).toEqual({ text: 'I should call card_list.', thought: true, thoughtSignature: SKIP_THOUGHT_SIGNATURE });
    // The real signature rides the first function call; the second parallel call must not carry one.
    expect(model.parts[1]).toEqual({
      functionCall: { id: 'call_1', name: 'card_list', args: { status: 'ready' } },
      thoughtSignature: 'SIG-1',
    });
    expect(model.parts[2]).toEqual({ functionCall: { id: 'call_2', name: 'card_list', args: {} } });
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { id: 'call_1', name: 'card_list', response: { result: '[{"id":"c1"}]' } } },
        { functionResponse: { id: 'call_2', name: 'card_list', response: { error: 'boom' } } },
      ],
    });
  });

  it('uses Cloud Code’s skip sentinel when Atlas has no signature to replay', () => {
    const [, model] = toGeminiContents(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'shell', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'ok' }] },
        ],
      }),
    );
    expect(model!.parts[0]).toEqual({
      functionCall: { id: 'c', name: 'shell', args: {} },
      thoughtSignature: SKIP_THOUGHT_SIGNATURE,
    });
  });

  it('drops JSON Schema fields Gemini refuses', () => {
    expect(
      cleanSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1 }, opts: { type: 'object', additionalProperties: true } },
        required: ['path'],
      }),
    ).toEqual({
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 }, opts: { type: 'object' } },
      required: ['path'],
    });
  });
});

describe('Gemini (Antigravity) streaming', () => {
  it('streams text, keeps thinking, tool calls and usage, and sends the Antigravity request', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const provider = new GeminiProvider(
      'proj-1',
      'tok-1',
      'https://cc.test',
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen = { url: String(url), init: init! };
        return sse([
          { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Let me ', thought: true }, { text: 'checking' }] } }] } },
          {
            response: {
              candidates: [
                {
                  content: {
                    parts: [
                      { text: ' that.' },
                      { functionCall: { id: 'c1', name: 'card_list', args: { status: 'ready' } }, thoughtSignature: 'SIG-9' },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 10, cachedContentTokenCount: 100 },
            },
          },
        ]);
      }) as typeof fetch,
    );

    const text: string[] = [];
    const out = await provider.complete(
      request({ effort: 'high', tools: [{ name: 'card_list', description: 'List', input_schema: { type: 'object', properties: {} } }] }),
      (t) => text.push(t),
      AbortSignal.timeout(5000),
    );

    expect(seen!.url).toBe('https://cc.test/v1internal:streamGenerateContent?alt=sse');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    expect((seen!.init.headers as Record<string, string>)['user-agent']).toMatch(/^antigravity\/hub\//);
    const body = JSON.parse(String(seen!.init.body)) as Record<string, unknown>;
    expect(body.project).toBe('proj-1');
    expect(body.model).toBe('gemini-4-neon');
    expect(body.requestType).toBe('agent');
    expect(body.userAgent).toBe('antigravity');
    expect(String(body.requestId)).toMatch(/^agent-/);
    const inner = body.request as Record<string, unknown>;
    expect(inner.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(inner.systemInstruction).toEqual({ role: 'user', parts: [{ text: 'You are atlas.' }] });
    expect((inner.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'high' });

    expect(text.join('')).toBe('checking that.');
    expect(out.content).toEqual([
      { type: 'thinking', thinking: 'Let me ', signature: 'SIG-9' },
      { type: 'text', text: 'checking that.' },
      { type: 'tool_use', id: 'c1', name: 'card_list', input: { status: 'ready' } },
    ]);
    expect(out.stopReason).toBe('tool_use');
    expect(out.usage).toEqual({ input: 120, output: 40, cached: 100 });
  });

  it('keeps a signature sent on a function call even when the model sent no thought text', async () => {
    const provider = new GeminiProvider(
      'p',
      't',
      'https://cc.test',
      (async () =>
        sse([
          {
            response: {
              candidates: [
                {
                  content: { parts: [{ functionCall: { id: 'c1', name: 'get_time', args: { city: 'Zurich' } }, thoughtSignature: 'SIG-CALL' }] },
                  finishReason: 'STOP',
                },
              ],
            },
          },
        ])) as typeof fetch,
    );
    const out = await provider.complete(request(), () => {}, AbortSignal.timeout(5000));
    expect(out.content).toEqual([
      { type: 'thinking', thinking: '', signature: 'SIG-CALL' },
      { type: 'tool_use', id: 'c1', name: 'get_time', input: { city: 'Zurich' } },
    ]);
    const [model] = toGeminiContents({ ...request(), messages: [{ role: 'assistant', content: out.content }] });
    expect(model).toEqual({
      role: 'model',
      parts: [{ functionCall: { id: 'c1', name: 'get_time', args: { city: 'Zurich' } }, thoughtSignature: 'SIG-CALL' }],
    });
  });

  it('reports a Cloud Code error with its status and headers', async () => {
    const provider = new GeminiProvider(
      'p',
      't',
      'https://cc.test',
      (async () =>
        Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } }, { status: 429, headers: { 'retry-after': '30' } })) as typeof fetch,
    );
    const e = await provider.complete(request(), () => {}, AbortSignal.timeout(5000)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GeminiError);
    expect((e as GeminiError).status).toBe(429);
    expect((e as GeminiError).transient).toBe(true);
    expect((e as GeminiError).message).toContain('RESOURCE_EXHAUSTED: quota');
    expect((e as GeminiError).headers?.get('retry-after')).toBe('30');
  });

  it('accepts a whole JSON body when the server does not stream', async () => {
    const provider = new GeminiProvider(
      'p',
      't',
      'https://cc.test',
      (async () =>
        Response.json({
          response: { candidates: [{ content: { parts: [{ text: 'whole' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } },
        })) as typeof fetch,
    );
    const out = await provider.complete(request(), () => {}, AbortSignal.timeout(5000));
    expect(out.content).toEqual([{ type: 'text', text: 'whole' }]);
    expect(out.usage).toEqual({ input: 5, output: 2, cached: 0 });
  });
});
