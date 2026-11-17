import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build the UI the suite drives (the engine serves packages/ui/dist), unless E2E_SKIP_BUILD=1. */
export default function setup() {
  if (process.env.E2E_SKIP_BUILD === '1') return;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  execFileSync('npm', ['-w', '@atlas/ui', 'run', 'build'], { cwd: root, stdio: 'pipe' });
}
