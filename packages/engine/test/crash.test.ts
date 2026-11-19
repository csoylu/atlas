import { describe, expect, it } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startEngine } from '../src/index.ts';
import { LEASE_MS, SlowProvider, STEPS } from './crash-fixture.ts';

const KILLS = Number(process.env.CRASH_KILLS ?? 50);
const child = join(import.meta.dirname, 'crash-child.ts');

function runChild(dbFile: string, dataDir: string, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', child, dbFile, dataDir, marker], { stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', (d: Buffer) => {
      if (!d.toString().includes('ready')) return;
      // Kill at a random instant: mid model call, mid tool, mid write.
      setTimeout(() => p.kill('SIGKILL'), 20 + Math.random() * 600);
    });
    p.on('exit', () => resolve());
    p.on('error', reject);
  });
}

describe('durability (design §6)', () => {
  it(`completes every run consistently after ${KILLS} random SIGKILLs`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-crash-'));
    const dbFile = join(dataDir, 'atlas.db');
    const marker = 'atlas-crash-' + randomUUID().slice(0, 8);
    for (let i = 0; i < KILLS; i++) await runChild(dbFile, dataDir, marker);

    // Final engine: resumes everything once the dead owners' leases expire.
    const engine = await startEngine({ dbFile, dataDir, port: 0, dispatch: false, leaseMs: LEASE_MS, providers: () => new SlowProvider(marker), env: {} });
    try {
      const cards = engine.kanban.list().filter((c) => c.title.startsWith('crash '));
      expect(cards).toHaveLength(3);
      // The event-started workflow (#258): every created task fired exactly one run, with exactly one step task.
      engine.workflows.tick();
      const [w] = engine.workflows.list();
      const runs = engine.workflows.runs(w!.id);
      expect(runs.map((r) => r.subject!.cardId).sort()).toEqual(cards.map((c) => c.id).sort());
      expect(engine.db.prepare('SELECT COUNT(*) AS n FROM workflow_events').get()).toEqual({ n: 0 });
      for (const r of runs) {
        const steps = engine.workflows.run(r.id).steps!.filter((s) => s.nodeId === 'look');
        expect(steps).toHaveLength(1);
        expect(engine.kanban.get(steps[0]!.cardId!).body).toContain(`Look at ${engine.kanban.ref(r.subject!.cardId)}`);
      }
      const stepTasks = engine.kanban.list().filter((c) => !c.title.startsWith('crash '));
      expect(stepTasks).toHaveLength(3);
      const deadline = Date.now() + 30_000;
      const finished = () =>
        cards.every((c) => {
          const last = engine.kanban.messages(c.id).at(-1);
          return last?.role === 'assistant' && last.content[0]?.type === 'text';
        }) && !engine.db.prepare("SELECT 1 FROM runs WHERE status = 'running'").get();
      while (!finished()) {
        if (Date.now() > deadline) throw new Error('runs did not complete after the crashes');
        await new Promise((r) => setTimeout(r, 100));
      }

      for (const c of cards) {
        const msgs = engine.kanban.messages(c.id);
        expect(msgs.map((m) => m.seq)).toEqual(msgs.map((_, i) => i + 1));
        const blocks = msgs.flatMap((m) => m.content);
        const uses = blocks.flatMap((b) => (b.type === 'tool_use' ? [b.id] : []));
        const results = blocks.flatMap((b) => (b.type === 'tool_result' ? [b.tool_use_id] : []));
        expect(new Set(uses).size).toBe(uses.length);
        expect([...results].sort()).toEqual([...uses].sort()); // every tool_use answered exactly once
        expect(blocks.filter((b) => b.type === 'tool_result' && b.content.startsWith('exit 0'))).toHaveLength(STEPS);
        expect(msgs.at(-1)!.content).toEqual([{ type: 'text', text: 'finished' }]);
        const statuses = engine.runner.runs(c.id).map((r) => r.status);
        expect(statuses.filter((s) => s === 'failed' || s === 'stopped')).toEqual([]); // interruption is never a failure
        expect(statuses.filter((s) => s === 'done')).toHaveLength(1);
      }
    } finally {
      await engine.stop();
    }
    // No orphan shell left behind by the killed engines.
    expect(() => execSync(`pgrep -f ${marker}`)).toThrow();
  }, 180_000);
});
