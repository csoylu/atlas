import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { ImageBlock } from '@atlas/shared';
import { runTool, type ToolContext } from './tools.ts';
import { describeImage, MAX_SIDE, sniff, stripData, wireImage, withPictures } from './images.ts';
import { estimateTokens, renderForSummary } from './context.ts';
import { anthropicMessages } from './providers/anthropic.ts';
import { toResponsesInput } from './providers/chatgpt.ts';
import { toOpenAiMessages } from './providers/openai.ts';
import type { ModelRequest } from './providers/types.ts';

export const png = (w = 40, h = 30, color = '#ff0000') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
const dir = () => mkdtempSync(join(tmpdir(), 'atlas-img-'));
const ctx = (): ToolContext => ({ workdir: dir(), outputsDir: dir(), conversationId: 'c_' + randomUUID(), signal: new AbortController().signal });
async function imageAt(name = 'a.png', buf?: Buffer): Promise<ImageBlock> {
  const p = join(dir(), name);
  const b = buf ?? (await png());
  writeFileSync(p, b);
  return describeImage(p, b);
}
const req = (messages: ModelRequest['messages']): ModelRequest => ({ model: 'm', system: 's', maxTokens: 10, tools: [], messages });

describe('images', () => {
  it('knows a picture by its bytes, not its name', async () => {
    expect(sniff(await png())).toBe('image/png');
    expect(sniff(await sharp(await png()).jpeg().toBuffer())).toBe('image/jpeg');
    expect(sniff(await sharp(await png()).webp().toBuffer())).toBe('image/webp');
    expect(sniff(await sharp(await png()).gif().toBuffer())).toBe('image/gif');
    expect(sniff(Buffer.from('hello world, not an image'))).toBeNull();
  });

  it('read_file returns a picture with a text line (path, size in px); web_fetch of an image too', async () => {
    const c = ctx();
    writeFileSync(join(c.workdir, 'shot.png'), await png(120, 80));
    const r = await runTool('read_file', { path: 'shot.png' }, c);
    expect(r.isError).toBe(false);
    expect(r.output).toMatch(/^\[image: .*shot\.png \(120×80 px, \d+ KB\)\]$/);
    expect(r.images).toHaveLength(1);
    expect(r.images![0]).toMatchObject({ type: 'image', media_type: 'image/png', width: 120, height: 80 });
    expect(r.images![0]!.data).toBeUndefined(); // the transcript never holds the bytes

    const bytes = await sharp(await png()).jpeg().toBuffer();
    const fetchFn = (async () => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } })) as unknown as typeof fetch;
    const w = await runTool('web_fetch', { url: 'https://example.com/cat.jpg' }, { ...c, fetch: fetchFn });
    expect(w.isError).toBe(false);
    expect(w.images![0]).toMatchObject({ media_type: 'image/jpeg', width: 40, height: 30 });
    expect(w.images![0]!.path.startsWith(c.outputsDir)).toBe(true);
  });

  it('refuses images over 10 MB', async () => {
    const c = ctx();
    const big = Buffer.concat([await png(), Buffer.alloc(10 * 1024 * 1024)]);
    writeFileSync(join(c.workdir, 'big.png'), big);
    expect((await runTool('read_file', { path: 'big.png' }, c)).output).toMatch(/images over 10\.0 MB are refused/);
  });

  it('downscales a big picture to 1568 px on the long side', async () => {
    const b = await imageAt('wide.png', await png(4000, 1000));
    const w = await wireImage(b);
    const meta = await sharp(Buffer.from(w.data, 'base64')).metadata();
    expect([meta.width, meta.height]).toEqual([MAX_SIDE, 392]);
    // A small one goes as is.
    const s = await imageAt('small.png');
    expect((await wireImage(s)).data).toBe((await png()).toString('base64'));
  });

  it('sends only the newest 6 pictures; older ones and missing files become text', async () => {
    const imgs = await Promise.all(Array.from({ length: 8 }, (_, i) => imageAt(`p${i}.png`)));
    rmSync(imgs[7]!.path);
    // Even ones as user pictures, odd ones as a tool's pictures.
    const view: ModelRequest['messages'] = imgs.flatMap((im, i): ModelRequest['messages'] => [
      { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'read_file', input: {} }] },
      { role: 'user', content: i % 2 ? [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'line', images: [im] }] : [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'line' }, im] },
    ]);
    const out = await withPictures(view);
    const pictures = out.flatMap((t) => t.content.flatMap((b) => (b.type === 'image' && b.data ? [b.path] : b.type === 'tool_result' ? (b.images ?? []).filter((x) => x.data).map((x) => x.path) : [])));
    // Newest 6 = p2..p7; p7 is gone → 5 pictures.
    expect(pictures).toEqual([2, 3, 4, 5, 6].map((i) => imgs[i]!.path));
    const text = JSON.stringify(out);
    expect(text).toContain(`[image: ${imgs[0]!.path} (40×30 px), no longer shown as a picture`);
    expect(text).toContain(`[image: ${imgs[1]!.path} (40×30 px), no longer shown`); // inside the tool result's text
    expect(text).toContain(`[image: ${imgs[7]!.path}: the file no longer exists`);
    // The input view is untouched, and storing strips any bytes.
    expect(JSON.stringify(view)).not.toContain('"data"');
    expect(JSON.stringify(stripData(out.flatMap((t) => t.content)))).not.toContain('"data"');
  });

  it('a changed file is not sent as the old picture', async () => {
    const b = await imageAt('c.png');
    writeFileSync(b.path, await png(40, 30, '#00ff00'));
    const out = await withPictures([{ role: 'user', content: [b] }]);
    expect(out[0]!.content[0]).toMatchObject({ type: 'text', text: expect.stringMatching(/changed since it was attached/) });
  });

  it('counts a picture as ~1600 tokens and summarizes it as its line', async () => {
    const b = await imageAt();
    expect(estimateTokens([{ role: 'user', content: [b] }])).toBeGreaterThan(1600);
    const s = renderForSummary([{ id: 'm', conversationId: 'c', seq: 1, role: 'user', author: 'user', at: '', content: [{ type: 'text', text: 'see' }, b] }]);
    expect(s).toContain(`[image: ${b.path} (40×30 px`);
  });

  describe('provider request shapes', () => {
    const shapes = async () => {
      const a = await imageAt('user.png');
      const t = await imageAt('tool.png');
      return withPictures([
        { role: 'user', content: [{ type: 'text', text: 'what is this?' }, a] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'tool.png' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '[image: tool.png]', images: [t] }] },
      ]);
    };

    it('Anthropic: image blocks with a base64 source, also inside tool_result', async () => {
      const m = anthropicMessages(await shapes()) as unknown as { content: Record<string, unknown>[] }[];
      expect(m[0]!.content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: expect.any(String) } });
      const tr = m[2]!.content[0] as { type: string; tool_use_id: string; content: unknown[]; images?: unknown };
      expect(tr.type).toBe('tool_result');
      expect(tr.images).toBeUndefined();
      expect(tr.content).toEqual([{ type: 'text', text: '[image: tool.png]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: expect.any(String) } }]);
    });

    it('ChatGPT (Responses): input_image data URLs, in the user item and in function_call_output', async () => {
      const items = toResponsesInput(req(await shapes())) as unknown as Record<string, unknown>[];
      expect(items[0]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'what is this?' }, { type: 'input_image', image_url: expect.stringMatching(/^data:image\/png;base64,/), detail: 'auto' }] });
      expect(items[2]).toEqual({
        type: 'function_call_output',
        call_id: 'c1',
        output: [{ type: 'input_text', text: '[image: tool.png]' }, { type: 'input_image', image_url: expect.stringMatching(/^data:image\/png;base64,/), detail: 'auto' }],
      });
    });

    it('OpenAI-compatible: image_url parts; a tool’s pictures follow in a user message', async () => {
      const msgs = toOpenAiMessages(req(await shapes())) as unknown as Record<string, unknown>[];
      expect(msgs[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } }] });
      expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '[image: tool.png]' });
      expect(msgs[4]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Pictures returned by tool call c1:' }, { type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } }] });
    });
  });
});
