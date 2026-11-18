/**
 * Test kit (QA, 18 Nov 2026): the few generic tools every Atlas test needs, so no test writes its own sleep loop.
 *
 *   eventually(fn, opts)  poll until fn() stops throwing / returns something truthy; returns its value.
 *                         The one way to wait for something asynchronous. Never `sleep(1500)` and hope.
 *   until(cond, what, ms) the same for a plain boolean, with the old (cond, what, ms) call shape.
 *   retry(fn, opts)       run an operation again when it throws (flaky I/O, a port still closing), n times.
 *   launch(overrides)     a throwaway engine, dependencies injected (provider, clock, fetch, anything startEngine takes),
 *                         stopped by itself after the test. See ./engine.ts.
 *
 * Rules: (1) wait for the thing you need, with eventually(); (2) inject what you need to control (a provider, a clock,
 * a fake GitHub) through launch()/startEngine options, never patch globals; (3) a test that needs a retry to pass is a
 * bug in the test: vitest retries once (see vitest.config.ts) and prints it, so it is visible, then fix it.
 */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface EventuallyOptions {
  /** Give up after this long (default 5 s). */
  timeout?: number;
  /** Time between tries (default 10 ms). */
  interval?: number;
  /** Named in the failure message: « timed out after 5000 ms waiting for the run to end ». */
  what?: string;
}

/** Calls fn until it returns a truthy value (or, if it returns undefined, until it stops throwing). Awaits async fns. */
export async function eventually<T>(fn: () => T | Promise<T>, o: EventuallyOptions = {}): Promise<Exclude<Awaited<T>, false | null | 0 | ''>> {
  const { timeout = 5000, interval = 10, what = fn.toString().slice(0, 80) } = o;
  const end = Date.now() + timeout;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v === undefined || v) return v as Exclude<Awaited<T>, false | null | 0 | ''>;
      last = new Error('returned ' + String(v));
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what} (last: ${last instanceof Error ? last.message : String(last)})`, { cause: last });
    await sleep(interval);
  }
}

/** eventually() for a boolean condition, with the call shape the older tests used. */
export const until = (cond: () => boolean | Promise<boolean>, what: string, ms = 5000) => eventually(cond, { what, timeout: ms }).then(() => undefined);

export interface RetryOptions {
  /** Total tries (default 3). */
  times?: number;
  delayMs?: number;
  /** Only retry errors this accepts (default: all). */
  retryIf?: (e: unknown) => boolean;
}

/** Runs fn; on a throw, again after delayMs, up to `times` tries in all. The last error is thrown. */
export async function retry<T>(fn: (attempt: number) => T | Promise<T>, o: RetryOptions = {}): Promise<T> {
  const { times = 3, delayMs = 50, retryIf = () => true } = o;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= times || !retryIf(e)) throw e;
      await sleep(delayMs);
    }
  }
}
