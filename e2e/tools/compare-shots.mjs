/**
 * #218 item 3: pixel diff of two ui-check output folders (before / after a change), by file name.
 *   node e2e/tools/compare-shots.mjs <before-dir> <after-dir> [--diff-out DIR] [--tolerance N]
 * A pixel differs when any channel differs by more than N (default 8: anti-aliasing noise). Prints one line per
 * screenshot present on both sides (% of pixels that differ, size change) and lists the ones only on one side.
 * Exit 1 when a shot differs by more than 0.5 % of its pixels or changes size.
 */
import { readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const [a, b] = args.filter((x, i) => !x.startsWith('--') && !args[i - 1]?.startsWith('--'));
const tol = Number(opt('--tolerance', 8));
const out = opt('--diff-out', '');
if (out) mkdirSync(out, { recursive: true });
const pngs = (d) => new Set(readdirSync(d).filter((f) => f.endsWith('.png')));
const A = pngs(a), B = pngs(b);
let bad = 0, same = 0;
for (const f of [...A].filter((x) => B.has(x)).sort()) {
  const [x, y] = await Promise.all([a, b].map((d) => sharp(join(d, f)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
  if (x.info.width !== y.info.width || x.info.height !== y.info.height) {
    console.log(`SIZE ${f}: ${x.info.width}x${x.info.height} → ${y.info.width}x${y.info.height}`);
    bad++;
    continue;
  }
  const n = x.info.width * x.info.height;
  const diff = Buffer.alloc(n * 4);
  let d = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const hit = Math.abs(x.data[o] - y.data[o]) > tol || Math.abs(x.data[o + 1] - y.data[o + 1]) > tol || Math.abs(x.data[o + 2] - y.data[o + 2]) > tol;
    if (hit) { d++; diff[o] = 255; diff[o + 3] = 255; } else { diff[o] = diff[o + 1] = diff[o + 2] = y.data[o] >> 1 | 128; diff[o + 3] = 255; }
  }
  const pct = (100 * d) / n;
  if (pct > 0.5) bad++;
  else if (d === 0) same++;
  if (d) {
    console.log(`${pct > 0.5 ? 'DIFF' : 'near'} ${f}: ${pct.toFixed(3)} % of pixels (${d})`);
    if (out) await sharp(diff, { raw: { width: x.info.width, height: x.info.height, channels: 4 } }).png().toFile(join(out, f));
  }
}
console.log(`${same} identical, ${bad} over 0.5 %, only before: [${[...A].filter((f) => !B.has(f)).join(' ')}], only after: [${[...B].filter((f) => !A.has(f)).join(' ')}]`);
process.exit(bad ? 1 : 0);
