// Child engine for projects-crash.test.ts (#218): started and SIGKILLed repeatedly, in the middle of a clone or of a
// member's removal.
//   mode « clone »:   Datinel is created with two members; each clone writes into its folder, waits a random time and
//                     then runs the real `git clone` from a local bare repo.
//   mode « removal »: Datinel has two members and zurich has running tasks there; the child removes zurich from the
//                     project (one transaction, then the runs stop) and is killed at a random instant around it.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startEngine } from '../src/index.ts';
import { spawnClone, type CloneRun } from '../src/projects.ts';
import { LEASE_MS, SlowProvider } from './crash-fixture.ts';

const [mode, dbFile, dataDir, marker, remotes] = process.argv.slice(2) as ['clone' | 'removal', string, string, string, string];

/** The real clone, started after a random pause with a partial folder already on disk (what a kill leaves behind). */
const slowClone: CloneRun = async (repo, dir, o) => {
  execFileSync('mkdir', ['-p', dir]);
  execFileSync('sh', ['-c', `echo partial > '${join(dir, 'partial.txt')}'`]);
  await new Promise((r) => setTimeout(r, Math.random() * 300));
  o.signal.throwIfAborted();
  execFileSync('rm', ['-rf', dir]);
  return spawnClone('git', ['clone', '--progress', join(remotes, `${repo}.git`), dir], o);
};

const engine = await startEngine({
  dbFile,
  dataDir,
  port: 0,
  dispatch: false,
  leaseMs: LEASE_MS,
  providers: () => new SlowProvider(marker),
  env: {},
  projects: { clone: mode === 'clone' ? slowClone : (repo, dir, o) => spawnClone('git', ['clone', '--quiet', join(remotes, `${repo}.git`), dir], o) },
});
const modelId = engine.agents.get('atlas').modelId;
for (const id of ['munih', 'zurich']) if (!engine.agents.list().some((a) => a.id === id)) engine.agents.create({ id, rolePrompt: `${id} role`, modelId });

if (!engine.projects.list().some((p) => p.id === 'datinel')) {
  engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'munih', members: ['zurich'] });
  if (mode === 'removal') {
    // Wait for both workspaces, then give zurich work that is still running when the removal comes.
    while (!engine.projects.get('datinel').members.every((m) => m.cloneState === 'ready')) await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 3; i++) {
      const c = engine.kanban.create({ title: `datinel work ${i}`, projectId: 'datinel', assignee: 'zurich' }, 'user');
      engine.kanban.appendMessage(c.id, 'user', 'user', [{ type: 'text', text: 'go' }]);
      engine.runner.wake(c.id);
    }
    engine.kanban.mainChat('zurich', 'datinel');
  }
}
process.stdout.write('ready\n');
if (mode === 'removal' && engine.projects.get('datinel').members.some((m) => m.agentId === 'zurich')) {
  await new Promise((r) => setTimeout(r, Math.random() * 400));
  engine.projects.update('datinel', { members: ['munih'] });
  process.stdout.write('removed\n');
}
