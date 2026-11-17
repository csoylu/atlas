// Orb check: drives the real voice-orb overlay (apps/desktop/src/orb) in Electron through every state and reports
// screenshots, frame times, CPU (idle shown / listening / speaking / hidden), Esc, click-through logic and drag +
// position after a restart. Needs the voice models (Settings → Voice) for the reply's Kokoro audio.
// Usage: node scripts/orb-check/check.mjs [--out DIR]   (default: shots/orb). Exit 1 on errors.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../..');
const arg = (name, dflt) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : dflt);
const out = resolve(arg('--out', join(root, 'shots/orb')));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

const models = arg('--models', join(homedir(), 'Library/Application Support/Atlas/voice-models'));
run('npx', ['tsx', 'scripts/orb-check/tts.ts', models, out]);
run('npm', ['-w', '@atlas/desktop', 'run', 'build']);
await build({
  entryPoints: [join(root, 'scripts/orb-check/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  outfile: join(out, 'main.mjs'),
  logLevel: 'warning',
});
const electron = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
run(electron, [join(out, 'main.mjs')], {
  env: {
    ...process.env,
    ORB_CHECK_OUT: out,
    ORB_CHECK_ORB: join(root, 'apps/desktop/dist/orb'),
    ORB_CHECK_MIC: join(root, 'packages/voice/test/fixtures/unrelated-speech.wav'),
  },
});
rmSync(join(out, 'main.mjs'));
