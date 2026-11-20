import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';

/**
 * Processes by command line (#322). `pgrep` exits 1 when nothing matches and 3 when it cannot list processes, which is
 * what it does inside a Mac sandbox (sysmond is denied). A check « no process left » that only expects pgrep to fail
 * would then pass without checking anything: these helpers tell the two apart.
 */
export class PgrepUnavailable extends Error {}

/** Pids whose command line matches `pattern` (pgrep -f); [] for no match. Throws PgrepUnavailable when pgrep can't list. */
export function pgrepPids(pattern: string): number[] {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim().split('\n').map(Number);
  if (r.status === 1) return [];
  throw new PgrepUnavailable(`pgrep cannot list processes here (exit ${r.status ?? r.error?.message}: ${r.stderr?.trim() || 'no output'}); a Mac sandbox denies it (#322)`);
}

let works: boolean | undefined;
/** Whether pgrep can list processes on this machine (false in a Mac sandbox). */
export function pgrepWorks(): boolean {
  if (works === undefined) {
    try {
      pgrepPids(`^pgrep-probe-${process.pid}$`);
      works = true;
    } catch (e) {
      if (!(e instanceof PgrepUnavailable)) throw e;
      works = false;
    }
  }
  return works;
}

/**
 * The end of a test: no process matching `pattern` is left. Where pgrep can't list processes the check is impossible:
 * the test is marked skipped with the reason (visible), never passed. Call it after every other assertion.
 */
export function expectNoProcessLeft(pattern: string, ctx: { skip: (note?: string) => void }): void {
  if (!pgrepWorks()) return ctx.skip(`no-process-left check impossible: pgrep cannot list processes here (Mac sandbox, #322); the rest of the test passed`);
  expect(pgrepPids(pattern), `processes matching ${pattern}`).toEqual([]);
}
