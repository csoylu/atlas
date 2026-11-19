import { describe, expect, it } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startEngine } from '../src/index.ts';
import { LEASE_MS, SlowProvider, STEPS } from './crash-fixture.ts';

const KILLS = Number(process.env.CRASH_KILLS ?? 50);
const child = join(import.meta.dirname, 'crash-child.ts');

function runChild(dbFile: string, dataDir: string, marker: string, origin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', child, dbFile, dataDir, marker, origin], { stdio: ['ignore', 'pipe', 'inherit'] });
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
    // The repo a command step checks out (#273): a local bare one with one commit on main.
    const work = join(dataDir, 'origin-work');
    execSync(`git init -q -b main "${work}" && cd "${work}" && echo x > README && git add README && git -c user.name=t -c user.email=t@t commit -qm x && git clone -q --bare "${work}" "${dataDir}/origin.git"`);
    const origin = join(dataDir, 'origin.git');
    for (let i = 0; i < KILLS; i++) await runChild(dbFile, dataDir, marker, origin);

    // Final engine: resumes everything once the dead owners' leases expire.
    const engine = await startEngine({ dbFile, dataDir, port: 0, dispatch: false, leaseMs: LEASE_MS, providers: () => new SlowProvider(marker), env: {}, workflowCommand: { clone: async (_r, dir) => void execSync(`git clone -q "${origin}" "${dir}"`) } });
    try {
      const cards = engine.kanban.list().filter((c) => c.title.startsWith('crash '));
      expect(cards).toHaveLength(3);
      // The event-started workflow (#258): every created task fired exactly one run, with exactly one step task.
      engine.workflows.tick();
      const w = engine.workflows.list().find((x) => x.name === 'On created');
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
      // The waiting run (#261): still on its one Wait step, deadline as stored; it goes on once its event comes.
      const wait = engine.workflows.list().find((x) => x.name === 'Wait')!;
      const [wr] = engine.workflows.runs(wait.id);
      const before = engine.workflows.run(wr!.id);
      expect(before.state).toBe('running');
      expect(before.steps!.map((s) => [s.nodeId, s.state])).toEqual([
        ['trigger', 'done'],
        ['w', 'waiting'],
      ]);
      engine.kanban.update(cards.find((c) => c.title === 'crash 0')!.id, { status: 'closed' }, 'user');
      engine.workflows.tick();
      const after = engine.workflows.run(wr!.id);
      expect(after).toMatchObject({ state: 'done' });
      expect(after.steps!.map((s) => s.exit)).toEqual(['start', 'event', 'done']);
      expect(after.steps![1]!.deadlineAt).toBe(before.steps![1]!.deadlineAt);
      // The command step (#273): ran to its end once, or was cut off and never run again by itself.
      engine.workflows.start(3_600_000);
      const cw = engine.workflows.list().find((x) => x.name === 'Command')!;
      const [cr] = engine.workflows.runs(cw.id);
      await engine.workflows.commandsIdle();
      const cmdRun = engine.workflows.run(cr!.id);
      const cmdStep = cmdRun.steps!.find((s) => s.nodeId === 'c')!;
      const ran = existsSync(join(dataDir, 'command-runs')) ? readFileSync(join(dataDir, 'command-runs'), 'utf8').split('\n').filter(Boolean).length : 0;
      if (cmdRun.state === 'done') {
        expect(cmdStep.exit).toBe('exit 0');
        expect(ran).toBe(1);
      } else {
        // Still queued (killed before it started each time), or cut off: never retried by itself.
        expect(ran).toBeLessThanOrEqual(1);
        if (cmdStep.couldntRun) expect(cmdStep.couldntRun).toMatchObject({ autoRetry: false });
      }
      expect(readdirSync(join(dataDir, 'checkouts')).flatMap((p) => (existsSync(join(dataDir, 'checkouts', p, 'runs')) ? readdirSync(join(dataDir, 'checkouts', p, 'runs')) : []))).toEqual([]);
    } finally {
      await engine.stop();
    }
    // No orphan shell left behind by the killed engines.
    expect(() => execSync(`pgrep -f ${marker}`)).toThrow();
  }, 180_000);
});
