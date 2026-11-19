import { describe, expect, it } from 'vitest';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startEngine } from '../src/index.ts';
import { spawnClone } from '../src/projects.ts';
import { eventually } from './kit/index.ts';
import { LEASE_MS, SlowProvider } from './crash-fixture.ts';

/**
 * #218 — a SIGKILL during a clone and during a member's removal, repeated at random instants, then a last engine
 * that must find everything whole (design §6, §17). `CRASH_KILLS=n` shortens it (default 20 per test).
 */
const KILLS = Number(process.env.CRASH_KILLS ?? 20);
const child = join(import.meta.dirname, 'projects-crash-child.ts');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: GIT_ENV, stdio: 'pipe' });
function remote(): string {
  const remotes = mkdtempSync(join(tmpdir(), 'atlas-remotes-'));
  const work = mkdtempSync(join(tmpdir(), 'atlas-src-'));
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'README.md'), 'datinel readme\n');
  writeFileSync(join(work, 'CLAUDE.md'), 'DATINEL-RULES\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  mkdirSync(join(remotes, 'datinel'), { recursive: true });
  git(remotes, 'clone', '-q', '--bare', work, 'datinel/datinel.git');
  return remotes;
}

/** Start the child, wait until it has said `after`, then kill it a random time later. */
function runChild(mode: string, dbFile: string, dataDir: string, marker: string, remotes: string, after: string, window: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', child, mode, dbFile, dataDir, marker, remotes], { stdio: ['ignore', 'pipe', 'inherit'] });
    let killed = false;
    p.stdout.on('data', (d: Buffer) => {
      if (killed || !d.toString().includes(after)) return;
      killed = true;
      setTimeout(() => p.kill('SIGKILL'), Math.random() * window);
    });
    p.on('exit', () => resolve());
    p.on('error', reject);
  });
}

describe('projects survive a kill (#218)', () => {
  it(`a kill in the middle of a clone, ${KILLS} times: the last engine clones each member once, whole, with no half folder`, async () => {
    const remotes = remote();
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-pcrash-'));
    const dbFile = join(dataDir, 'atlas.db');
    const marker = 'atlas-pcrash-' + randomUUID().slice(0, 8);
    for (let i = 0; i < KILLS; i++) await runChild('clone', dbFile, dataDir, marker, remotes, 'ready', 250);

    const cloned: string[] = [];
    const engine = await startEngine({
      dbFile,
      dataDir,
      port: 0,
      dispatch: false,
      leaseMs: LEASE_MS,
      providers: () => new SlowProvider(marker),
      env: {},
      projects: {
        clone: (repo, dir, o) => {
          cloned.push(dir);
          return spawnClone('git', ['clone', '--quiet', join(remotes, `${repo}.git`), dir], o);
        },
      },
    });
    try {
      await eventually(() => expect(engine.projects.get('datinel').members.map((m) => m.cloneState)).toEqual(['ready', 'ready']), { timeout: 20_000, what: 'both clones ready after the kills' });
      for (const agent of ['munih', 'zurich']) {
        const ws = join(dataDir, 'projects', 'datinel', agent); // #245: clones live outside every agent workdir
        expect(readFileSync(join(ws, 'README.md'), 'utf8')).toBe('datinel readme\n');
        expect(existsSync(join(ws, 'partial.txt'))).toBe(false); // the partial folder of a killed clone is never the workspace
        expect(git(ws, 'status', '--porcelain').toString()).toBe('');
        expect(existsSync(`${ws}.cloning`)).toBe(false);
        expect(engine.projects.get('datinel').members.find((m) => m.agentId === agent)).toMatchObject({ cloneState: 'ready', cloneError: null, workspace: ws });
      }
      expect(readdirSync(join(dataDir, 'projects', 'datinel')).filter((f) => f.endsWith('.cloning'))).toEqual([]);
      // Two engines never both cloned the same member: no member cloned twice in the last engine.
      expect(new Set(cloned).size).toBe(cloned.length);
    } finally {
      await engine.stop();
    }
    expect(() => execSync(`pgrep -f ${marker}`)).toThrow();
  }, 180_000);

  it(`a kill around a member's removal, ${KILLS} times: either still a member with its work, or gone with its tasks back to the lead; never in between`, async () => {
    const remotes = remote();
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-pcrash-'));
    const dbFile = join(dataDir, 'atlas.db');
    const marker = 'atlas-pcrash-' + randomUUID().slice(0, 8);
    // The first child sets Datinel up and removes zurich; each later child resumes what the kill left, and removes zurich if still a member.
    for (let i = 0; i < KILLS; i++) await runChild('removal', dbFile, dataDir, marker, remotes, i === 0 ? 'ready' : 'ready', 500);

    const engine = await startEngine({
      dbFile,
      dataDir,
      port: 0,
      dispatch: false,
      leaseMs: LEASE_MS,
      providers: () => new SlowProvider(marker),
      env: {},
      projects: { clone: (repo, dir, o) => spawnClone('git', ['clone', '--quiet', join(remotes, `${repo}.git`), dir], o) },
    });
    try {
      const p = engine.projects.get('datinel');
      const works = engine.kanban.list({ project: 'datinel' }).filter((c) => c.title.startsWith('datinel work'));
      const chat = engine.db.prepare("SELECT status FROM cards WHERE project_id = 'datinel' AND board = 'direct' AND assignee = 'zurich'").all() as { status: string }[];
      const member = p.members.some((m) => m.agentId === 'zurich');
      const kept = engine.db.prepare("SELECT path FROM kept_workspaces WHERE project_id = 'datinel' AND agent_id = 'zurich'").all() as { path: string }[];
      expect(works).toHaveLength(3); // the child prints « ready » only after creating them: a kill never comes before
      if (member) {
        // Killed before the transaction committed: nothing of the removal happened.
        expect(kept).toEqual([]);
        expect(chat.every((c) => c.status !== 'archived')).toBe(true);
        await eventually(() => expect(engine.kanban.list({ project: 'datinel' }).filter((c) => c.title.startsWith('datinel work')).every((c) => c.status === 'blocked' || c.status === 'done' || c.status === 'review')).toBe(true), { timeout: 30_000, what: 'zurich finishes its work after the kills' });
      } else {
        // Committed: the tasks are with the lead, unassigned; the chat is archived; the workspace is kept; no run goes on for it.
        for (const c of works) expect(c, c.title).toMatchObject({ assignee: null });
        expect(works.filter((c) => c.status !== 'done').every((c) => c.status === 'triage')).toBe(true);
        expect(chat.every((c) => c.status === 'archived')).toBe(true);
        expect(kept).toEqual([{ path: join(dataDir, 'projects', 'datinel', 'zurich') }]);
        expect(existsSync(join(dataDir, 'projects', 'datinel', 'zurich', 'README.md'))).toBe(true);
        // A resumed run of the removed member must not be left running, nor fail the card in the lead's triage.
        await eventually(() => expect(engine.db.prepare("SELECT COUNT(*) n FROM runs r JOIN cards c ON c.id = r.card_id WHERE c.project_id = 'datinel' AND r.agent_id = 'zurich' AND r.status = 'running'").get()).toEqual({ n: 0 }), { timeout: 30_000, what: 'no run of the removed member keeps going' });
        expect(engine.kanban.list({ project: 'datinel' }).filter((c) => c.title.startsWith('datinel work')).every((c) => c.assignee === null)).toBe(true);
      }
      // Either way: no card was lost, task numbers are unique, and munih (the lead) is untouched.
      expect(p.members.some((m) => m.agentId === 'munih' && m.cloneState === 'ready')).toBe(true);
      const nums = engine.db.prepare('SELECT COUNT(number) n, COUNT(DISTINCT number) d FROM cards').get() as { n: number; d: number };
      expect(nums.d).toBe(nums.n);
    } finally {
      await engine.stop();
    }
    expect(() => execSync(`pgrep -f ${marker}`)).toThrow();
  }, 180_000);
});
