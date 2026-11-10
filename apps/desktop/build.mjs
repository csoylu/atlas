// Bundles the Electron main process (engine included) and copies what it reads at runtime.
import { build } from 'esbuild';
import { cpSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/main.mjs',
  // Native module (rebuilt for Electron by electron-builder) and ws's optional native helpers stay outside.
  external: ['electron', 'better-sqlite3', 'bufferutil', 'utf-8-validate'],
  // CommonJS dependencies bundled into ESM still call require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  sourcemap: true,
  logLevel: 'info',
});
// The engine reads its SQL migrations next to the code (store/db.ts resolves them from import.meta.url).
cpSync('../../packages/engine/src/store/migrations', 'dist/migrations', { recursive: true });
