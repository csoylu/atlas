import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';

let engine: Engine | undefined;
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
});

/**
 * The fixed part of every model request (#295): the engine's system text (no project file, no memories, the
 * workdir is empty) and the tools JSON. Budgets sit just above the size measured when #295 shrank them
 * (4552 → ~3600 chars, 25142 → ~17600 chars): raise one only for a new rule or tool worth its room, never for wording.
 */
const SYSTEM_BUDGET = 3_800;
const TOOLS_BUDGET = 17_900;

describe('prompt size', () => {
  it('keeps the fixed part of a request under its budget', async () => {
    const fake = new FakeProvider([[{ type: 'text', text: 'ok' }]]);
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, dispatch: false, providers: () => fake, env: {}, memoryReview: false });
    const card = engine.kanban.create({ title: 'p', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'hi' }]);
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    const req = fake.calls[0]!;
    if (process.env.PROMPT_SIZE_OUT) writeFileSync(process.env.PROMPT_SIZE_OUT, [req.system.length, JSON.stringify(req.tools).length, req.tools.length].join(' ') + '\n' + req.system + '\n----\n' + JSON.stringify(req.tools, null, 1));
    // Every tool a run can get here (files, tasks, team, artifacts, secrets): the budget covers them all.
    expect(req.tools.length).toBeGreaterThanOrEqual(38);
    expect(req.system.length).toBeLessThanOrEqual(SYSTEM_BUDGET);
    expect(JSON.stringify(req.tools).length).toBeLessThanOrEqual(TOOLS_BUDGET);
    // Pure noise: zod's ±MAX_SAFE_INTEGER bounds on integers never reach the model.
    expect(JSON.stringify(req.tools)).not.toContain(String(Number.MAX_SAFE_INTEGER));
  });
});
