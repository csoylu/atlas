// Runs ui-check once per width, all at the same time (own Chrome + own output dir each). ~80 s instead of ~3 min.
// node scripts/ui-check/parallel.mjs [same flags as check.mjs, except --widths/--out]
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const args = process.argv.slice(2);
const widths = ['1440', '1100', '900', '390'];
const out = join(tmpdir(), 'atlas-ui-check');
const run = (w) => new Promise((res) => {
  const p = spawn(process.execPath, [join(import.meta.dirname, 'check.mjs'), ...args, '--widths', w, '--out', join(out, String(w))], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (d) => (log += d));
  p.stderr.on('data', (d) => (log += d));
  p.on('exit', (code) => res({ w, code, log }));
});
const results = await Promise.all(widths.map(run));
for (const r of results) console.log(`── ${r.w}px (exit ${r.code})\n${r.log.trim().split('\n').slice(-12).join('\n')}`);
console.log(`Screenshots + report.json per width in ${out}/<width>`);
process.exit(results.some((r) => r.code) ? 1 : 0);
