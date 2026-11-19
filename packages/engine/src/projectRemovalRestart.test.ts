import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { eventually, launch } from '../test/kit/index.ts';

/**
 * #218: a kill between a member's removal (committed: its tasks are with the lead) and the end of its stopped runs
 * leaves the run 'interrupted' (a dead owner's lease expiring does exactly that). The next start must not resume a
 * run for an agent that is no longer a member there.
 */
const use = (id: string, name: string, input: unknown): ContentBlock[] => [{ type: 'tool_use', id, name, input }];

describe('a member removed, then a kill before its run ended (#218)', () => {
  // Was a bug (#246, fixed in PR #79): Runner.recover resumed the interrupted run of the removed member.
  it('the next start does not resume the removed member’s run (no kick message, no failed run)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-t-'));
    const dbFile = join(dataDir, 'atlas.db');
    let started = () => {};
    const inRun = new Promise<void>((r) => (started = r));
    const clone = async (_r: string, dir: string) => void mkdirSync(dir, { recursive: true });
    const a = await launch({
      dispatch: false,
      env: {},
      dbFile,
      dataDir,
      projects: { clone },
      script: [
        () => {
          started();
          return use('t1', 'shell', { command: 'sleep 30' });
        },
      ],
    });
    for (const id of ['dina', 'zurich']) a.engine.agents.create({ id, rolePrompt: id, modelId: 'sonnet' });
    a.engine.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'dina', members: ['zurich'] });
    await eventually(() => expect(a.engine.projects.get('datinel').members.every((m) => m.cloneState === 'ready')).toBe(true), { what: 'ready' });
    const t = a.engine.kanban.create({ title: 'datinel work', projectId: 'datinel', assignee: 'zurich', status: 'done' }, 'user');
    a.engine.kanban.appendMessage(t.id, 'user', 'user', [{ type: 'text', text: 'go' }]);
    a.engine.runner.wake(t.id);
    await inRun;
    a.engine.projects.update('datinel', { members: ['dina'] });
    await a.engine.runner.settled(t.id);
    // The kill: the run never got to write its end.
    a.engine.db.prepare("UPDATE runs SET status = 'interrupted', error = 'engine stopped during the run' WHERE card_id = ?").run(t.id);
    const before = a.engine.kanban.messages(t.id).length;
    await a.engine.stop();

    const b = await launch({ dispatch: false, env: {}, dbFile, dataDir, projects: { clone }, script: [] });
    await b.engine.runner.settled(t.id);
    const runs = b.engine.db.prepare('SELECT status, error FROM runs WHERE card_id = ?').all(t.id) as { status: string; error: string | null }[];
    expect(runs.map((r) => r.status)).toEqual(['stopped']); // never resumed, never failed
    expect(runs[0]!.error).toMatch(/left project Datinel/);
    expect(b.engine.kanban.messages(t.id).length).toBe(before); // no « continue » kick added to the lead's card
  });
});
