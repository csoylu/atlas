// Child engine for crash.test.ts: started and SIGKILLed repeatedly.
import { startEngine } from '../src/index.ts';
import { LEASE_MS, SlowProvider } from './crash-fixture.ts';

const [dbFile, dataDir, marker] = process.argv.slice(2) as [string, string, string];
const engine = await startEngine({ dbFile, dataDir, port: 0, dispatch: false, leaseMs: LEASE_MS, providers: () => new SlowProvider(marker), env: {} });
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
}
// Events consumed and step tasks made at a random instant too: the kill may come before, during or after.
setTimeout(() => engine.workflows.start(5), Math.random() * 300);
process.stdout.write('ready\n');
