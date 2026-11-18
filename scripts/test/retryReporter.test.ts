import { describe, expect, it } from 'vitest';
import { formatRetried, retriedTests } from './retryReporter';

const test = (fullName: string, retryCount: number, state = 'passed') =>
  ({ fullName, diagnostic: () => ({ retryCount }), result: () => ({ state }) });
const mod = (moduleId: string, tests: ReturnType<typeof test>[]) =>
  ({ moduleId, children: { allTests: () => tests } }) as never;

describe('retry reporter', () => {
  it('says nothing when no test needed a retry', () => {
    expect(formatRetried(retriedTests([mod('/r/a.test.ts', [test('a ok', 0), test('a ok 2', 0)])], '/r'))).toBeNull();
  });

  it('lists a retried test by name, file and outcome', () => {
    const list = retriedTests([mod('/r/pkg/a.test.ts', [test('suite flaky | one', 2), test('fine', 0), test('dead', 1, 'failed')])], '/r');
    expect(list).toEqual([
      { name: 'suite flaky | one', file: 'pkg/a.test.ts', retries: 2, passed: true },
      { name: 'dead', file: 'pkg/a.test.ts', retries: 1, passed: false },
    ]);
    const r = formatRetried(list)!;
    expect(r.text).toContain('2 tests needed a retry');
    expect(r.text).toContain('pkg/a.test.ts > suite flaky | one (2 retries, passed on retry)');
    expect(r.markdown).toContain('| suite flaky \\| one | `pkg/a.test.ts` | 2 | passed on retry |');
    expect(r.annotations[0]).toBe('::warning file=pkg/a.test.ts,title=Flaky test::suite flaky | one needed 2 retries (passed on retry)');
  });
});
