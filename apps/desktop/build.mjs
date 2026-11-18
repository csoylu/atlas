// Bundles the Electron main process (engine included) and copies what it reads at runtime.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/main.mjs',
  // Native module (rebuilt for Electron by electron-builder) and ws's optional native helpers stay outside.
  // sherpa-onnx-node (voice) loads its prebuilt addon + dylibs from node_modules at runtime.
  external: ['electron', 'better-sqlite3', 'sharp', 'sherpa-onnx-node', 'bufferutil', 'utf-8-validate'],
  // CommonJS dependencies bundled into ESM still call require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  sourcemap: true,
  logLevel: 'info',
});
// The voice orb's window: its page script (browser) and preload (sandboxed preloads must be CommonJS).
await build({ entryPoints: ['src/orb/renderer.ts'], bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', outfile: 'dist/orb/renderer.js', logLevel: 'info' });
await build({ entryPoints: ['src/orb/preload.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], outfile: 'dist/orb/orb-preload.cjs', logLevel: 'info' });
cpSync('src/orb/orb.html', 'dist/orb/orb.html');
// The engine reads its SQL migrations next to the code (store/db.ts resolves them from import.meta.url).
cpSync('../../packages/engine/src/store/migrations', 'dist/migrations', { recursive: true });
// macOS: the menu bar orb's breathing layer (src/tray/breathe.mm, card #56), a Node-API addon (ABI-stable, so no
// rebuild per Electron version), universal (arm64 + x64). Headers from the Node running this build; a failure stops it.
if (process.platform === 'darwin') {
  const include = join(dirname(process.execPath), '..', 'include', 'node');
  if (!existsSync(join(include, 'node_api.h'))) throw new Error(`no Node-API headers in ${include}`);
  mkdirSync('dist/native', { recursive: true });
  execFileSync('clang++', ['-fobjc-arc', '-std=c++20', '-O2', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=12.0', '-bundle', '-undefined', 'dynamic_lookup',
    '-I', include, '-framework', 'AppKit', '-framework', 'QuartzCore', 'src/tray/breathe.mm', '-o', 'dist/native/breathe.node'], { stdio: 'inherit' });
  console.log('  dist/native/breathe.node');
  // push-to-talk « hold ⌥ » (card #75): a listen-only event tap (src/optionkey.mm), same build
  execFileSync('clang++', ['-std=c++20', '-O2', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=12.0', '-bundle', '-undefined', 'dynamic_lookup',
    '-I', include, '-framework', 'ApplicationServices', '-framework', 'CoreFoundation', 'src/optionkey.mm', '-o', 'dist/native/optionkey.node'], { stdio: 'inherit' });
  console.log('  dist/native/optionkey.node');
}
