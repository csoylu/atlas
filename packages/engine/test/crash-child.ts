// Child engine for crash.test.ts: started and SIGKILLed repeatedly.
import { execFileSync } from 'node:child_process';
import { startEngine } from '../src/index.ts';
import { LEASE_MS, SlowProvider } from './crash-fixture.ts';

const [dbFile, dataDir, marker, origin] = process.argv.slice(2) as [string, string, string, string];
const engine = await startEngine({
  dbFile,
  dataDir,
  port: 0,
  dispatch: false,
  leaseMs: LEASE_MS,
  providers: () => new SlowProvider(marker),
  env: {},
  // A command step (#273) clones a local bare repo standing in for GitHub.
  workflowCommand: { clone: async (_repo, dir) => void execFileSync('git', ['clone', '-q', origin, dir]) },
});
if (engine.kanban.list().length === 0) {
  // An event-started workflow (#258): each task created fires one run, whose step makes one task per run.
  engine.workflows.create(
    {
      name: 'On created',
      nodes: [
        { id: 'trigger', kind: 'trigger', x: 0, y: 0, config: { kind: 'task', event: 'created' } },
        { id: 'look', kind: 'agent', x: 0, y: 0, config: { agentId: 'atlas', prompt: 'Look at {{task.ref}} « {{task.title}} »', newTaskEachRun: true } },
      ],
      edges: [{ from: 'trigger', exit: 'start', to: 'look' }],
    },
    'user',
  );
  for (let i = 0; i < 3; i++) {
    const card = engine.kanban.create({ title: `crash ${i}`, assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'go' }]);
    engine.runner.wake(card.id);
  }
  // A waiting run (#261): a Wait step on « crash 0 » closed, killed and restarted 50 times while it waits.
  const w = engine.workflows.create(
    {
      name: 'Wait',
      nodes: [
        { id: 'trigger', kind: 'trigger', x: 0, y: 0, config: { kind: 'manual' } },
        { id: 'w', kind: 'wait', x: 0, y: 0, config: { for: 'status', status: 'closed', limitMin: 600 } },
        { id: 'n', kind: 'action', x: 0, y: 0, config: { do: 'notify', text: '{{task.ref}} closed' } },
      ],
      edges: [
        { from: 'trigger', exit: 'start', to: 'w' },
        { from: 'w', exit: 'event', to: 'n' },
      ],
    },
    'user',
  );
  engine.workflows.runNow(w.id, { task: engine.kanban.list().find((c) => c.title === 'crash 0')!.id });
  // A command step killed at a random instant (#273): it runs at most once by itself, never again after a cut.
  const p = engine.projects.create({ name: 'Crash', repo: 'crash/crash', lead: 'atlas', members: [] });
  const c = engine.workflows.create(
    {
      name: 'Command',
      projectId: p.id,
      nodes: [
        { id: 'trigger', kind: 'trigger', x: 0, y: 0, config: { kind: 'manual' } },
        { id: 'c', kind: 'action', x: 0, y: 0, config: { do: 'command', title: 'Count', command: `echo ran >> ${dataDir}/command-runs; sleep 0.3 # ${marker}`, secrets: [], limitMin: 5 } },
      ],
      edges: [{ from: 'trigger', exit: 'start', to: 'c' }],
    },
    'user',
  );
  engine.workflows.runNow(c.id);
}
// Events consumed and step tasks made at a random instant too: the kill may come before, during or after.
setTimeout(() => engine.workflows.start(5), Math.random() * 300);
process.stdout.write('ready\n');
