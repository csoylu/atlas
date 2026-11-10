// Child engine for crash.test.ts: started and SIGKILLed repeatedly.
import { startEngine } from '../src/index.ts';
import { LEASE_MS, SlowProvider } from './crash-fixture.ts';

const [dbFile, dataDir, marker] = process.argv.slice(2) as [string, string, string];
const engine = await startEngine({ dbFile, dataDir, port: 0, dispatch: false, leaseMs: LEASE_MS, providers: () => new SlowProvider(marker), env: {} });
if (engine.kanban.list().length === 0) {
  for (let i = 0; i < 3; i++) {
    const card = engine.kanban.create({ title: `crash ${i}`, assignee: 'atlas' }, 'can');
    engine.kanban.appendMessage(card.id, 'user', 'can', [{ type: 'text', text: 'go' }]);
    engine.runner.wake(card.id);
  }
}
process.stdout.write('ready\n');
