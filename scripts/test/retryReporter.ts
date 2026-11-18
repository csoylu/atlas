import { relative } from 'node:path';
import type { Reporter, TestCase, TestModule } from 'vitest/node';

// A test that failed and passed on a retry is a flaky test (#178). vitest's `retry` lets it through quietly, so this reporter
// lists every such test by name in the console and, on GitHub Actions, as a ::warning annotation. A run with no flaky test
// prints nothing. The job summary needs nothing from us: vitest's github-actions reporter already writes a « Flaky Tests »
// section there (keep it in the reporters list, see vitest.config.ts). A test that fails on every attempt is a plain
// failure, reported by vitest: not listed here.

export interface Flaky { name: string; file: string; retries: number }

/** Tests that failed, then passed on a retry. */
export function flakyTests(modules: ReadonlyArray<Pick<TestModule, 'moduleId' | 'children'>>, root = process.cwd()): Flaky[] {
  const out: Flaky[] = [];
  for (const m of modules) {
    for (const t of m.children.allTests() as Iterable<TestCase>) {
      const retries = t.diagnostic()?.retryCount ?? 0;
      if (retries > 0 && t.result().state === 'passed') out.push({ name: t.fullName, file: relative(root, m.moduleId), retries });
    }
  }
  return out;
}

/** The report as console text and GitHub annotations. Empty list = null: nothing to say. */
export function formatFlaky(list: Flaky[]): { text: string; annotations: string[] } | null {
  if (!list.length) return null;
  const n = list.length;
  const times = (r: Flaky) => `${r.retries} retr${r.retries > 1 ? 'ies' : 'y'}`;
  const text = [
    `${n} test${n > 1 ? 's' : ''} passed only on a retry (flaky: fix the test, do not rely on retry)`,
    ...list.map((r) => `  - ${r.file} > ${r.name} (${times(r)})`),
  ].join('\n');
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
  const data = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const annotations = list.map((r) => `::warning file=${esc(r.file)},title=Flaky test::${data(`${r.name} passed only after ${times(r)}`)}`);
  return { text, annotations };
}

export default class RetryReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const report = formatFlaky(flakyTests(modules));
    if (!report) return;
    console.log(`\n${report.text}\n`);
    if (process.env.GITHUB_ACTIONS === 'true') for (const a of report.annotations) console.log(a);
  }
}
