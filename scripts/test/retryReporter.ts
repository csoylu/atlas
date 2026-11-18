import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Reporter, TestCase, TestModule } from 'vitest/node';

// A test that failed and passed on a retry is a flaky test (#178). vitest's `retry` lets it through quietly, so this reporter
// lists every such test by name: in the console, as a GitHub warning annotation, and in the job summary
// ($GITHUB_STEP_SUMMARY). A run with no retry prints and writes nothing.

export interface Retried { name: string; file: string; retries: number; passed: boolean }

/** Tests of these modules that ran more than once because of `retry`. */
export function retriedTests(modules: ReadonlyArray<Pick<TestModule, 'moduleId' | 'children'>>, root = process.cwd()): Retried[] {
  const out: Retried[] = [];
  for (const m of modules) {
    for (const t of m.children.allTests() as Iterable<TestCase>) {
      const retries = t.diagnostic()?.retryCount ?? 0;
      if (retries > 0) out.push({ name: t.fullName, file: relative(root, m.moduleId), retries, passed: t.result().state === 'passed' });
    }
  }
  return out;
}

/** The report, as plain text and as markdown for the job summary. Empty list = null: nothing to say. */
export function formatRetried(list: Retried[]): { text: string; markdown: string; annotations: string[] } | null {
  if (!list.length) return null;
  const n = list.length;
  const head = `${n} test${n > 1 ? 's' : ''} needed a retry (flaky: fix the test, do not rely on retry)`;
  const verdict = (r: Retried) => (r.passed ? 'passed on retry' : 'still failed');
  const times = (r: Retried) => `${r.retries} retr${r.retries > 1 ? 'ies' : 'y'}`;
  const text = [head, ...list.map((r) => `  - ${r.file} > ${r.name} (${times(r)}, ${verdict(r)})`)].join('\n');
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  const markdown = [
    `### ⚠️ ${head}`, '', '| Test | File | Retries | Result |', '|---|---|---|---|',
    ...list.map((r) => `| ${cell(r.name)} | \`${r.file}\` | ${r.retries} | ${verdict(r)} |`), '',
  ].join('\n');
  const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const annotations = list.map((r) => `::warning file=${esc(r.file)},title=Flaky test::${esc(`${r.name} needed ${times(r)} (${verdict(r)})`)}`);
  return { text, markdown, annotations };
}

export default class RetryReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const report = formatRetried(retriedTests(modules));
    if (!report) return;
    console.log(`\n${report.text}\n`);
    if (process.env.GITHUB_ACTIONS) for (const a of report.annotations) console.log(a);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, `${report.markdown}\n`);
  }
}
