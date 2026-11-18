import { describe, expect, it } from 'vitest';
import { flakyTests, formatFlaky } from './retryReporter';

const test = (fullName: string, retryCount: number, state = 'passed') =>
  ({ fullName, diagnostic: () => ({ retryCount }), result: () => ({ state }) });
const mod = (moduleId: string, tests: ReturnType<typeof test>[]) =>
  ({ moduleId, children: { allTests: () => tests } }) as never;

describe('retry reporter', () => {
  it('says nothing when no test needed a retry', () => {
    expect(formatFlaky(flakyTests([mod('/r/a.test.ts', [test('a ok', 0), test('a ok 2', 0)])], '/r'))).toBeNull();
  });

  it('lists a test that passed on a retry by name and file; a test that kept failing is vitest’s plain failure', () => {
    const list = flakyTests([mod('/r/pkg/a.test.ts', [test('suite flaky', 2), test('fine', 0), test('dead', 2, 'failed')])], '/r');
    expect(list).toEqual([{ name: 'suite flaky', file: 'pkg/a.test.ts', retries: 2 }]);
    const r = formatFlaky(list)!;
    expect(r.text).toBe('1 test passed only on a retry (flaky: fix the test, do not rely on retry)\n  - pkg/a.test.ts > suite flaky (2 retries)');
    expect(r.annotations).toEqual(['::warning file=pkg/a.test.ts,title=Flaky test::suite flaky passed only after 2 retries']);
  });
});
