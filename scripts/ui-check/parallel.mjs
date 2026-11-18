// Runs ui-check once per width, all at the same time (own Chrome + own output dir each). ~80 s instead of ~3 min.
// node scripts/ui-check/parallel.mjs [same flags as check.mjs, except --widths/--out]
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const args = process.argv.slice(2);
// check.mjs reads the first occurrence of a flag, so a user's --widths/--out would reach all four children.
const refused = args.find((a) => /^--(widths|out)(=|$)/.test(a));
if (refused) {
  console.error(`ui:check:fast sets its own widths and output folders: ${refused.split('=')[0]} is not allowed (use ui:check for that).`);
  process.exit(2);
}
const widths = ['1440', '1100', '900', '390'];
const out = join(tmpdir(), 'atlas-ui-check');
const run = (w) => new Promise((res) => {
  let settled = false;
  const done = (r) => { if (!settled) { settled = true; res({ w, log, ...r }); } };
  let log = '';
  const p = spawn(process.execPath, [join(import.meta.dirname, 'check.mjs'), ...args, '--widths', w, '--out', join(out, String(w))], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => (log += d));
  p.stderr.on('data', (d) => (log += d));
  p.on('error', (err) => done({ code: null, signal: null, error: err.message }));
  p.on('close', (code, signal) => done({ code, signal }));
});
const results = await Promise.all(widths.map(run));
const status = (r) => (r.error ? `failed to start: ${r.error}` : r.signal ? `killed by ${r.signal}` : `exit ${r.code}`);
for (const r of results) console.log(`── ${r.w}px (${status(r)})\n${r.log.trim().split('\n').slice(-12).join('\n')}`);
console.log(`Screenshots + report.json per width in ${out}/<width>`);
process.exit(results.some((r) => r.error || r.signal || r.code !== 0) ? 1 : 0);
