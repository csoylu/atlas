import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Card, ChatUsage, UsageSummary } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { openDb } from './store/db.ts';
import { Bus } from './events.ts';
import { Usage } from './usage.ts';
import type { Provider } from './providers/types.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});
const json = { 'content-type': 'application/json' };

describe('token usage', () => {
  it('records every answer of a chat, with how full the context was at the latest one', async () => {
    let n = 0;
    // Each answer reports a bigger prompt, like a growing conversation; part of it read from the cache.
    const provider: Provider = {
      complete: async () => {
        n++;
        return { content: [{ type: 'text', text: 'ok ' + n }], stopReason: 'end_turn', usage: { input: 40_000 * n, output: 500, cached: 30_000 } };
      },
    };
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, providers: () => provider });
    const u = engine.url + '/api';
    const chat = (await (await fetch(u + '/agents/atlas/chats', { method: 'POST' })).json()) as Card;
    const empty = (await (await fetch(u + `/cards/${chat.id}/usage`)).json()) as ChatUsage;
    expect(empty).toMatchObject({ calls: 0, input: 0, output: 0, lastInput: null });

    for (const t of ['one', 'two']) {
      await fetch(u + `/cards/${chat.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: t }) });
      await expect.poll(() => engine!.kanban.messages(chat.id).filter((m) => m.author === 'atlas').length, { timeout: 5000 }).toBe(t === 'one' ? 1 : 2);
    }
    const used = (await (await fetch(u + `/cards/${chat.id}/usage`)).json()) as ChatUsage;
    const agentModel = engine.models.get(engine.agents.get('atlas').modelId);
    expect(used).toMatchObject({ calls: 2, input: 120_000, output: 1000, cached: 60_000, lastInput: 80_000, lastModelId: agentModel.id, contextWindow: agentModel.contextWindow });

    const s = (await (await fetch(u + '/usage?days=7')).json()) as UsageSummary;
    expect(s.perDay).toHaveLength(7);
    expect(s.perDay.at(-1)![agentModel.provider as 'anthropic']).toBe(121_000);
    expect(s.models).toEqual([expect.objectContaining({ modelId: agentModel.id, today: { calls: 2, input: 120_000, output: 1000 } })]);
    expect(s.total).toMatchObject({ calls: 2, input: 120_000, output: 1000, cached: 60_000 });
  });

  it('sums per local day, per source and per model over the range, oldest day first', () => {
    const db = openDb(':memory:');
    let t = new Date('2026-11-01T10:00:00');
    const usage = new Usage(db, new Bus(), () => t);
    const at = (d: string, model: { id: string; provider: 'anthropic' | 'chatgpt' | 'openai_compat' }, input: number) => {
      t = new Date(d);
      usage.record({ model, agentId: 'atlas', cardId: 'c', conversationId: 'conv', kind: 'turn', usage: { input, output: 10 } });
    };
    at('2026-11-01T10:00:00', { id: 'sonnet', provider: 'anthropic' }, 100); // out of a 7-day range ending on the 10th
    at('2026-11-05T10:00:00', { id: 'sol', provider: 'chatgpt' }, 200);
    at('2026-11-10T09:00:00', { id: 'sol', provider: 'chatgpt' }, 300);
    at('2026-11-10T09:30:00', { id: 'qwen', provider: 'openai_compat' }, 50);
    t = new Date('2026-11-10T12:00:00');
    const s = usage.summary(7);
    expect(s.perDay.map((d) => d.day)).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']);
    expect(s.perDay[1]).toMatchObject({ chatgpt: 210, anthropic: 0 });
    expect(s.perDay[6]).toMatchObject({ chatgpt: 310, openai_compat: 60 });
    expect(s.models.map((m) => m.modelId)).toEqual(['sol', 'qwen']);
    expect(s.models[0]).toMatchObject({ today: { calls: 1, input: 300, output: 10 }, week: { calls: 2, input: 500, output: 20 } });
    expect(s.total).toMatchObject({ calls: 3, input: 550 });
  });
});
